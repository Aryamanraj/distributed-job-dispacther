import type { EntityManager } from "typeorm";
import WebSocket, { type WebSocketServer } from "ws";
import { JOB_STATUS_ENUM } from "../../shared/job-status";
import type { CoordToWorkerMsg, WorkerToCoordMsg } from "../../shared/protocol";
import { logger } from "../../util/logger";
import { AppDataSource } from "../db/data-source";
import { jobEventRepo, jobRepo, leaseRepo, workerRegRepo } from "../db/repo";

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

	constructor(wss: WebSocketServer) {
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
			case "worker.hello":
				await this.onHello(ws, msg, setId);
				break;
			case "job.result":
				await this.onResult(ws, msg);
				break;
			case "job.failed":
				await this.onFailed(ws, msg);
				break;
			case "pong":
				await this.onPong(ws);
				break;
			default:
				logger.warn({ msg }, "Unknown message type from worker");
		}
	}

	// ── Message handlers ────────────────────────────────────────────────────

	private async onHello(
		ws: WebSocket,
		msg: Extract<WorkerToCoordMsg, { type: "worker.hello" }>,
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
		msg: Extract<WorkerToCoordMsg, { type: "job.result" }>,
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

		// No lease = expired. Token mismatch = fencing violation. Either way: discard.
		if (!lease.data || String(lease.data.Token) !== String(msg.token)) {
			logger.warn(
				{ jobId: msg.jobId, workerId: state.workerId, hasLease: !!lease.data },
				"Lease missing or token mismatch — discarding result",
			);
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

		// TODO: chaos drop_acks — check chaosState.dropAcksRemaining before sending
		this.sendMsg(ws, { type: "job.ack", jobId: msg.jobId });
		logger.info(
			{ jobId: msg.jobId, workerId: state.workerId },
			"Job completed",
		);
	}

	private async onFailed(
		ws: WebSocket,
		msg: Extract<WorkerToCoordMsg, { type: "job.failed" }>,
	): Promise<void> {
		const state = this.stateByWs(ws);

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
				this.sendMsg(state.ws, { type: "ping" });
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
		msg: Extract<CoordToWorkerMsg, { type: "job.dispatch" }>,
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
