import WebSocket from "ws";
import type { CoordToWorkerMsg, WorkerToCoordMsg } from "../shared/protocol";
import { MsgType } from "../shared/protocol";
import { logger } from "../util/logger";
import { config } from "./config";
import { executeJob } from "./executor";

interface InFlightJob {
	/** Fencing token received with the dispatch. Sent back on result/failed. */
	token: string;
	/** Stored result — kept until ack received, for retry on dropped acks. */
	result?: Record<string, unknown>;
	retryCount: number;
	retryTimer?: NodeJS.Timeout;
}

const MAX_RESULT_RETRIES = 5;
const RESULT_RETRY_DELAY_MS = 5_000;

/**
 * Connects to a coordinator, processes dispatched jobs, and sends results.
 *
 * Fencing tokens — not wall clock — guard against stale results:
 * the worker records the token per job and discards the result if the token
 * has been superseded (coordinator will reject it anyway, but we skip the
 * send to avoid noise). The coordinator is the authoritative clock.
 *
 * Result retry: after sending job.result the worker waits for job.ack. If the
 * ack is dropped (chaos fault), the worker retries up to MAX_RESULT_RETRIES
 * times. The coordinator handles duplicate commits idempotently.
 */
export class WorkerService {
	private ws: WebSocket | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private readonly inFlight = new Map<string, InFlightJob>();
	private running = false;
	/** Mutable: updated at runtime via control.set_concurrency messages. */
	private concurrencyLimit = config.concurrencyLimit;

	start(): void {
		this.running = true;
		this.connect();
	}

	stop(): void {
		this.running = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		// Cancel any pending retry timers
		for (const job of this.inFlight.values()) {
			if (job.retryTimer) clearTimeout(job.retryTimer);
		}
		this.ws?.close();
	}

	// ── Connection lifecycle ─────────────────────────────────────────────────

	private connect(): void {
		logger.info({ url: config.coordinatorUrl }, "Connecting to coordinator");
		const ws = new WebSocket(config.coordinatorUrl);
		this.ws = ws;

		ws.on("open", () => {
			this.send({
				type: MsgType.WorkerHello,
				workerId: config.workerId,
				concurrencyLimit: this.concurrencyLimit,
			});
			logger.info({ workerId: config.workerId }, "Connected and registered");
		});

		ws.on("message", (raw) => {
			let msg: CoordToWorkerMsg;
			try {
				msg = JSON.parse(raw.toString()) as CoordToWorkerMsg;
			} catch {
				logger.warn("Received invalid JSON from coordinator — ignoring");
				return;
			}
			this.route(msg);
		});

		ws.on("close", () => {
			logger.warn("Coordinator connection closed — will reconnect");
			this.scheduleReconnect();
		});

		ws.on("error", (err) => {
			logger.error({ err }, "WebSocket error");
		});
	}

	private scheduleReconnect(): void {
		if (!this.running) return;
		this.reconnectTimer = setTimeout(
			() => this.connect(),
			config.reconnectDelayMs,
		);
	}

	// ── Message routing ──────────────────────────────────────────────────────

	private route(msg: CoordToWorkerMsg): void {
		switch (msg.type) {
			case MsgType.JobDispatch:
				this.handleDispatch(msg).catch((err) =>
					logger.error({ err, jobId: msg.jobId }, "Unhandled dispatch error"),
				);
				break;
			case MsgType.JobAck:
				this.handleAck(msg.jobId);
				break;
			case MsgType.Ping:
				this.send({ type: MsgType.Pong });
				break;
			case MsgType.ControlSetConcurrency:
				this.concurrencyLimit = msg.limit;
				logger.info(
					{ limit: msg.limit },
					"Concurrency limit updated at runtime",
				);
				break;
			default:
				logger.warn({ msg }, "Unknown message from coordinator");
		}
	}

	// ── Ack handler ──────────────────────────────────────────────────────────

	private handleAck(jobId: string): void {
		const job = this.inFlight.get(jobId);
		if (!job) return;
		if (job.retryTimer) clearTimeout(job.retryTimer);
		this.inFlight.delete(jobId);
		logger.debug({ jobId }, "Job ack received — cleared from in-flight");
	}

	// ── Job execution ────────────────────────────────────────────────────────

	private async handleDispatch(
		msg: Extract<CoordToWorkerMsg, { type: MsgType.JobDispatch }>,
	): Promise<void> {
		const { jobId, token, payload } = msg;

		if (this.inFlight.has(jobId)) {
			logger.warn({ jobId }, "Duplicate dispatch for in-flight job — ignoring");
			return;
		}

		// Enforce concurrency limit: reject immediately so coordinator can re-queue
		if (this.inFlight.size >= this.concurrencyLimit) {
			logger.warn(
				{ jobId, concurrencyLimit: this.concurrencyLimit },
				"At capacity — rejecting dispatch",
			);
			this.send({
				type: MsgType.JobFailed,
				jobId,
				token,
				error: "worker at capacity",
			});
			return;
		}

		this.inFlight.set(jobId, { token, retryCount: 0 });
		logger.info({ jobId, token }, "Executing job");

		try {
			const result = await executeJob(jobId, payload);

			// Guard: check token is still current before sending result.
			const current = this.inFlight.get(jobId);
			if (!current || current.token !== token) {
				logger.warn({ jobId }, "Token superseded — discarding result");
				this.inFlight.delete(jobId);
				return;
			}

			// Store result for retry and send. inFlight cleaned up in handleAck.
			current.result = result;
			this.send({ type: MsgType.JobResult, jobId, token, result });
			logger.info({ jobId }, "Job result sent — awaiting ack");
			this.scheduleResultRetry(jobId, token);
		} catch (err) {
			const current = this.inFlight.get(jobId);
			if (!current || current.token !== token) return;
			// Failed jobs: clean up immediately; coordinator marks FAILED, reaper
			// won't touch it. No retry for worker-side execution failures.
			this.inFlight.delete(jobId);
			this.send({
				type: MsgType.JobFailed,
				jobId,
				token,
				error: err instanceof Error ? err.message : String(err),
			});
			logger.error({ err, jobId }, "Job failed");
		}
	}

	// ── Result retry (for dropped acks under chaos) ──────────────────────────

	private scheduleResultRetry(jobId: string, token: string): void {
		const job = this.inFlight.get(jobId);
		if (!job) return;

		if (job.retryCount >= MAX_RESULT_RETRIES) {
			logger.warn(
				{ jobId, retries: MAX_RESULT_RETRIES },
				"Max retries reached — giving up on job.result",
			);
			this.inFlight.delete(jobId);
			return;
		}

		job.retryTimer = setTimeout(() => {
			const current = this.inFlight.get(jobId);
			if (!current || current.token !== token || !current.result) return;
			current.retryCount++;
			logger.warn(
				{ jobId, attempt: current.retryCount },
				"No ack received — retrying job.result",
			);
			this.send({
				type: MsgType.JobResult,
				jobId,
				token,
				result: current.result,
			});
			this.scheduleResultRetry(jobId, token);
		}, RESULT_RETRY_DELAY_MS);
	}

	// ── Helpers ──────────────────────────────────────────────────────────────

	private send(msg: WorkerToCoordMsg): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}
}
