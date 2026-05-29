import type { EntityManager } from "typeorm";
import { IsNull } from "typeorm";
import WebSocket, { type WebSocketServer } from "ws";
import { JOB_STATUS_ENUM } from "../../shared/job-status";
import type { CoordToWorkerMsg, WorkerToCoordMsg } from "../../shared/protocol";
import { MsgType } from "../../shared/protocol";
import { logger } from "../../util/logger";
import { config } from "../config";
import { AppDataSource } from "../db/data-source";
import { CommitAttempt } from "../db/entities/commit-attempt.entity";
import { Job } from "../db/entities/job.entity";
import { JobTransition } from "../db/entities/job-transition.entity";
import { Lease } from "../db/entities/lease.entity";
import { LeaseHistory } from "../db/entities/lease-history.entity";
import { jobRepo, leaseRepo, workerRegRepo } from "../db/repo";
import type { ChaosService } from "./chaos.service";

interface WorkerState {
	ws: WebSocket;
	workerId: string;
	concurrencyLimit: number;
	inFlight: number;
	connectedAt: Date;
}

const HEARTBEAT_LEASE_TTL_MS = 15_000;

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
			if (workerId) void this.deregister(workerId, ws);
		});

		ws.on("error", (err) => {
			logger.error({ err, workerId }, "Worker WebSocket error");
			if (workerId) void this.deregister(workerId, ws);
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
			case MsgType.JobHeartbeat:
				await this.onHeartbeat(ws, msg);
				break;
			case MsgType.Pong:
				await this.onPong(ws);
				break;
			default:
				logger.warn({ msg }, "Unknown message type from worker");
		}
	}

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
						Status: JOB_STATUS_ENUM.SUCCEEDED,
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

		let accepted = false;
		await AppDataSource.transaction(async (em: EntityManager) => {
			const del = await em.delete(Lease, {
				JobID: msg.jobId,
				WorkerID: state.workerId,
				Token: String(msg.token),
			});
			if ((del.affected ?? 0) === 0) return;

			const upd = await em.update(
				Job,
				{ JobID: msg.jobId, Status: JOB_STATUS_ENUM.DISPATCHED },
				{
					Status: JOB_STATUS_ENUM.SUCCEEDED,
					Result: msg.result,
					UpdatedAt: new Date(),
				},
			);
			if ((upd.affected ?? 0) === 0) return;

			const nowMs = String(Date.now());
			await em.insert(CommitAttempt, {
				JobID: msg.jobId,
				Accepted: true,
				Fence: String(msg.token),
				WorkerID: state.workerId,
				AtMs: nowMs,
			});
			await em.update(
				LeaseHistory,
				{ JobID: msg.jobId, TerminatedAtMs: IsNull() },
				{ TerminatedAtMs: nowMs },
			);
			await em.insert(JobTransition, {
				JobID: msg.jobId,
				FromStatus: JOB_STATUS_ENUM.DISPATCHED,
				ToStatus: JOB_STATUS_ENUM.SUCCEEDED,
				AtMs: nowMs,
				CoordinatorId: config.coordinatorId,
			});
			accepted = true;
		});

		state.inFlight = Math.max(0, state.inFlight - 1);

		if (!accepted) {
			// Reaped mid-flight or job already terminal — re-ack if job succeeded
			const { data: alreadyDone } = await jobRepo.get(
				{ where: { JobID: msg.jobId, Status: JOB_STATUS_ENUM.SUCCEEDED } },
				false,
			);
			if (alreadyDone) {
				logger.info(
					{ jobId: msg.jobId, workerId: state.workerId },
					"Reaped mid-flight — re-acking succeeded job",
				);
				this.sendMsg(ws, { type: MsgType.JobAck, jobId: msg.jobId });
			}
			return;
		}

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
				await em.delete(Lease, { JobID: msg.jobId });
				await em.update(
					Job,
					{ JobID: msg.jobId, Status: JOB_STATUS_ENUM.DISPATCHED },
					{ Status: JOB_STATUS_ENUM.PENDING },
				);
				await em.update(
					LeaseHistory,
					{ JobID: msg.jobId, TerminatedAtMs: IsNull() },
					{ TerminatedAtMs: String(Date.now()) },
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
				await em.delete(Lease, { JobID: msg.jobId });
				await em.update(
					Job,
					{ JobID: msg.jobId, Status: JOB_STATUS_ENUM.DISPATCHED },
					{ Status: JOB_STATUS_ENUM.FAILED },
				);
				const nowMs = String(Date.now());
				await em.update(
					LeaseHistory,
					{ JobID: msg.jobId, TerminatedAtMs: IsNull() },
					{ TerminatedAtMs: nowMs },
				);
				await em.insert(JobTransition, {
					JobID: msg.jobId,
					FromStatus: JOB_STATUS_ENUM.DISPATCHED,
					ToStatus: JOB_STATUS_ENUM.FAILED,
					AtMs: nowMs,
					CoordinatorId: config.coordinatorId,
				});
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

	private async onHeartbeat(
		ws: WebSocket,
		msg: Extract<WorkerToCoordMsg, { type: MsgType.JobHeartbeat }>,
	): Promise<void> {
		const state = this.stateByWs(ws);
		if (!state) return;
		const skew = this.chaos?.getClockSkewMs() ?? 0;
		const newExpiry = new Date(Date.now() + HEARTBEAT_LEASE_TTL_MS + skew);
		await AppDataSource.getRepository(Lease).update(
			{
				JobID: msg.jobId,
				WorkerID: state.workerId,
				Token: String(msg.token),
			},
			{ ExpiresAt: newExpiry },
		);
	}

	// ── Keepalive ───────────────────────────────────────────────────────────

	private pingAll(): void {
		for (const [workerId, state] of this.workers) {
			if (state.ws.readyState === WebSocket.OPEN) {
				this.sendMsg(state.ws, { type: MsgType.Ping });
			} else {
				void this.deregister(workerId, state.ws);
			}
		}
	}

	private async deregister(workerId: string, ws: WebSocket): Promise<void> {
		// Only act if THIS ws is still the registered one. onHello closes
		// stale connections during reconnect — the eventual close event for
		// the old ws must not delete the freshly-registered new entry.
		const state = this.workers.get(workerId);
		if (!state || state.ws !== ws) return;

		this.workers.delete(workerId);
		logger.info({ workerId }, "Worker deregistered");
		// Lease cleanup happens via the TTL reaper: once heartbeats stop
		// arriving, ExpiresAt isn't extended and the lease is reaped within
		// LEASE_TTL_MS + reaper cadence (~20s).
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
