import type { EntityManager } from "typeorm";
import WebSocket, { type WebSocketServer } from "ws";
import { JOB_STATUS_ENUM } from "../../shared/job-status";
import type { CoordToWorkerMsg, WorkerToCoordMsg } from "../../shared/protocol";
import { MsgType } from "../../shared/protocol";
import { logger } from "../../util/logger";
import { AppDataSource } from "../db/data-source";
import { jobEventRepo, jobRepo, leaseRepo, workerRegRepo } from "../db/repo";
import type { ChaosService } from "./chaos.service";

interface WorkerState {
	ws: WebSocket;
	workerId: string;
	concurrencyLimit: number;
	inFlight: number;
	connectedAt: Date;
}

export class WorkerHubService {
	private readonly workers = new Map<string, WorkerState>();
	private readonly pingTimer: NodeJS.Timeout;

	constructor(
		wss: WebSocketServer,
		private readonly chaos?: ChaosService,
	) {
		wss.on("connection", (ws) => this.handleConnection(ws));
		this.pingTimer = setInterval(() => this.pingAll(), 30_000);
	}

	// ── Connection lifecycle ────────────────────────────────────────────────

	private handleConnection(ws: WebSocket): void {
		let workerId: string | null = null;

		ws.on("message", (raw) => {
			let msg: WorkerToCoordMsg;
			try {
				msg = JSON.parse(raw.toString()) as WorkerToCoordMsg;
			} catch {
				logger.warn("Worker sent invalid JSON — closing connection");
				ws.close();
				return;
			}
			this.route(ws, msg, (id) => {
				workerId = id;
			}).catch((err) => {
				logger.error({ err, workerId }, "Worker message handler error");
			});
		});

		ws.on("close", () => {
			if (workerId) this.deregister(workerId);
		});

		ws.on("error", (err) => {
			logger.error({ err, workerId }, "Worker WebSocket error");
			if (workerId) this.deregister(workerId);
		});
	}

	private async route(
		ws: WebSocket,
		msg: WorkerToCoordMsg,
		setId: (id: string) => void,
	): Promise<void> {
		switch (msg.type) {
			case MsgType.WorkerHello:
				await this.onHello(ws, msg, setId);
				break;
			case MsgType.JobResult:
				await this.onResult(ws, msg);
				break;
			case MsgType.JobFailed:
				await this.onFailed(ws, msg);
				break;
			case MsgType.Pong:
				await this.onPong(ws);
				break;
			default:
				logger.warn({ msg }, "Unknown message type from worker");
		}
	}

	// ── Message handlers ────────────────────────────────────────────────────

	private async onHello(
		ws: WebSocket,
		msg: Extract<WorkerToCoordMsg, { type: MsgType.WorkerHello }>,
		setId: (id: string) => void,
	): Promise<void> {
		const { workerId, concurrencyLimit } = msg;
		setId(workerId);

		await workerRegRepo.upsert(
			{
				WorkerID: workerId,
				ConcurrencyLimit: concurrencyLimit,
				ConnectedAt: new Date(),
				LastSeenAt: new Date(),
			},
			["WorkerID"],
		);

		// Close stale connection for same workerId (reconnect scenario)
		const stale = this.workers.get(workerId);
		if (stale && stale.ws !== ws && stale.ws.readyState === WebSocket.OPEN) {
			stale.ws.close();
		}

		this.workers.set(workerId, {
			ws,
			workerId,
			concurrencyLimit,
			inFlight: 0,
			connectedAt: new Date(),
		});
		logger.info({ workerId, concurrencyLimit }, "Worker registered");
	}

	private async onResult(
		ws: WebSocket,
		msg: Extract<WorkerToCoordMsg, { type: MsgType.JobResult }>,
	): Promise<void> {
		const state = this.stateByWs(ws);
		if (!state) {
			logger.warn(
				{ jobId: msg.jobId },
				"job.result from unregistered worker — ignoring",
			);
			return;
		}

		const lease = await leaseRepo.get(
			{ where: { JobID: msg.jobId, WorkerID: state.workerId } },
			false,
		);

		// No lease = expired. Token mismatch = fencing violation.
		// Special case: lease is gone but job is already COMPLETED — this is a
		// worker retry after a dropped ack. Ack again to stop the retry loop.
		if (!lease.data || String(lease.data.Token) !== String(msg.token)) {
			const { data: alreadyDone } = await jobRepo.get(
				{
					where: {
						JobID: msg.jobId,
						Status: JOB_STATUS_ENUM.COMPLETED,
					},
				},
				false,
			);
			if (alreadyDone) {
				logger.info(
					{ jobId: msg.jobId, workerId: state.workerId },
					"Duplicate result (ack was dropped) — re-acking",
				);
				this.sendMsg(ws, { type: MsgType.JobAck, jobId: msg.jobId });
			} else {
				logger.warn(
					{
						jobId: msg.jobId,
						workerId: state.workerId,
						hasLease: !!lease.data,
					},
					"Lease missing or token mismatch — discarding result",
				);
			}
			state.inFlight = Math.max(0, state.inFlight - 1);
			return;
		}

		await AppDataSource.transaction(async (em: EntityManager) => {
			await leaseRepo.delete({ JobID: msg.jobId }, em);
			await jobRepo.update(
				{ JobID: msg.jobId },
				{
					Status: JOB_STATUS_ENUM.COMPLETED,
					Result: msg.result,
					UpdatedAt: new Date(),
				},
				em,
			);
			await jobEventRepo.create({ JobID: msg.jobId, Event: "completed" }, em);
		});

		state.inFlight = Math.max(0, state.inFlight - 1);

		if (this.chaos?.consumeDropAck()) {
			logger.warn({ jobId: msg.jobId }, "Chaos: job.ack dropped");
		} else {
			this.sendMsg(ws, { type: MsgType.JobAck, jobId: msg.jobId });
		}
		logger.info(
			{ jobId: msg.jobId, workerId: state.workerId },
			"Job completed",
		);
	}

	private async onFailed(
		ws: WebSocket,
		msg: Extract<WorkerToCoordMsg, { type: MsgType.JobFailed }>,
	): Promise<void> {
		const state = this.stateByWs(ws);

		if (msg.temporary) {
			// Transient rejection (e.g. worker at capacity) — re-queue so it can be
			// dispatched again. The lease is deleted and the job returns to PENDING.
			await AppDataSource.transaction(async (em: EntityManager) => {
				await leaseRepo.delete({ JobID: msg.jobId }, em);
				await jobRepo.update(
					{ JobID: msg.jobId, Status: JOB_STATUS_ENUM.DISPATCHED },
					{ Status: JOB_STATUS_ENUM.PENDING },
					em,
				);
			});
			if (state) state.inFlight = Math.max(0, state.inFlight - 1);
			logger.warn(
				{ jobId: msg.jobId, error: msg.error },
				"Job transiently rejected — re-queued as PENDING",
			);
		} else {
			// Real execution failure — mark permanently FAILED.
			await AppDataSource.transaction(async (em: EntityManager) => {
				await leaseRepo.delete({ JobID: msg.jobId }, em);
				await jobRepo.update(
					{ JobID: msg.jobId, Status: JOB_STATUS_ENUM.DISPATCHED },
					{ Status: JOB_STATUS_ENUM.FAILED },
					em,
				);
				await jobEventRepo.create({ JobID: msg.jobId, Event: "failed" }, em);
			});
			if (state) state.inFlight = Math.max(0, state.inFlight - 1);
			logger.info({ jobId: msg.jobId, error: msg.error }, "Job failed");
		}
	}

	private async onPong(ws: WebSocket): Promise<void> {
		const state = this.stateByWs(ws);
		if (!state) return;
		await workerRegRepo.update(
			{ WorkerID: state.workerId },
			{ LastSeenAt: new Date() },
		);
	}

	// ── Keepalive ───────────────────────────────────────────────────────────

	private pingAll(): void {
		for (const [workerId, state] of this.workers) {
			if (state.ws.readyState === WebSocket.OPEN) {
				this.sendMsg(state.ws, { type: MsgType.Ping });
			} else {
				this.deregister(workerId);
			}
		}
	}

	private deregister(workerId: string): void {
		this.workers.delete(workerId);
		logger.info({ workerId }, "Worker deregistered");
	}

	// ── Public API for dispatch loop ────────────────────────────────────────

	getAvailableWorkers(): WorkerState[] {
		return [...this.workers.values()].filter(
			(w) =>
				w.ws.readyState === WebSocket.OPEN && w.inFlight < w.concurrencyLimit,
		);
	}

	sendJob(
		workerId: string,
		msg: Extract<CoordToWorkerMsg, { type: MsgType.JobDispatch }>,
	): boolean {
		const state = this.workers.get(workerId);
		if (!state || state.ws.readyState !== WebSocket.OPEN) return false;
		this.sendMsg(state.ws, msg);
		state.inFlight++;
		return true;
	}

	getWorkerStats(): Array<{
		workerId: string;
		inFlight: number;
		concurrencyLimit: number;
	}> {
		return [...this.workers.values()].map((w) => ({
			workerId: w.workerId,
			inFlight: w.inFlight,
			concurrencyLimit: w.concurrencyLimit,
		}));
	}

	/**
	 * Push a new concurrency limit to a connected worker at runtime.
	 * Returns false if the worker is unknown or its socket is not OPEN.
	 *
	 * The coordinator updates its local view immediately; the worker applies
	 * the new limit on receipt of `control.set_concurrency`. Subsequent
	 * dispatches respect the new ceiling.
	 */
	async setConcurrency(workerId: string, limit: number): Promise<boolean> {
		const state = this.workers.get(workerId);
		if (!state || state.ws.readyState !== WebSocket.OPEN) return false;
		state.concurrencyLimit = limit;
		this.sendMsg(state.ws, {
			type: MsgType.ControlSetConcurrency,
			limit,
		});
		await workerRegRepo.update(
			{ WorkerID: workerId },
			{ ConcurrencyLimit: limit },
		);
		logger.info({ workerId, limit }, "Worker concurrency updated at runtime");
		return true;
	}

	stop(): void {
		clearInterval(this.pingTimer);
	}

	// ── Helpers ─────────────────────────────────────────────────────────────

	private stateByWs(ws: WebSocket): WorkerState | null {
		for (const state of this.workers.values()) {
			if (state.ws === ws) return state;
		}
		return null;
	}

	private sendMsg(ws: WebSocket, msg: CoordToWorkerMsg): void {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
	}
}
