import WebSocket from "ws";
import type { CoordToWorkerMsg, WorkerToCoordMsg } from "../shared/protocol";
import { MsgType } from "../shared/protocol";
import { logger } from "../util/logger";
import { config } from "./config";
import { executeJob } from "./executor";

interface InFlightJob {
	/** Fencing token received with the dispatch. Sent back on result/failed. */
	token: string;
}

/**
 * Connects to a coordinator, processes dispatched jobs, and sends results.
 *
 * Fencing tokens — not wall clock — guard against stale results:
 * the worker records the token per job and discards the result if the token
 * has been superseded (coordinator will reject it anyway, but we skip the
 * send to avoid noise). The coordinator is the authoritative clock.
 */
export class WorkerService {
	private ws: WebSocket | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private readonly inFlight = new Map<string, InFlightJob>();
	private running = false;

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
				concurrencyLimit: config.concurrencyLimit,
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
				logger.debug({ jobId: msg.jobId }, "Job ack received");
				break;
			case MsgType.Ping:
				this.send({ type: MsgType.Pong });
				break;
			case MsgType.ControlSetConcurrency:
				logger.info({ limit: msg.limit }, "Concurrency limit update received");
				break;
			default:
				logger.warn({ msg }, "Unknown message from coordinator");
		}
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

		this.inFlight.set(jobId, { token });
		logger.info({ jobId, token }, "Executing job");

		try {
			const result = await executeJob(jobId, payload);

			// Guard: check token is still current before sending result.
			// Coordinator enforces this too, but skip the send to avoid noise.
			if (this.inFlight.get(jobId)?.token !== token) {
				logger.warn({ jobId }, "Token superseded — discarding result");
				return;
			}

			this.send({ type: MsgType.JobResult, jobId, token, result });
			logger.info({ jobId }, "Job result sent");
		} catch (err) {
			if (this.inFlight.get(jobId)?.token !== token) return;
			this.send({
				type: MsgType.JobFailed,
				jobId,
				token,
				error: err instanceof Error ? err.message : String(err),
			});
			logger.error({ err, jobId }, "Job failed");
		} finally {
			if (this.inFlight.get(jobId)?.token === token) {
				this.inFlight.delete(jobId);
			}
		}
	}

	// ── Helpers ──────────────────────────────────────────────────────────────

	private send(msg: WorkerToCoordMsg): void {
		if (this.ws?.readyState !== WebSocket.OPEN) {
			logger.warn({ type: msg.type }, "Cannot send — WebSocket not open");
			return;
		}
		this.ws.send(JSON.stringify(msg));
	}
}
