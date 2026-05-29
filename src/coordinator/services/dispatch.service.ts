import { JOB_STATUS_ENUM } from "../../shared/job-status";
import { MsgType } from "../../shared/protocol";
import { logger } from "../../util/logger";
import { config } from "../config";
import { AppDataSource } from "../db/data-source";
import { Job } from "../db/entities/job.entity";
import { JobTransition } from "../db/entities/job-transition.entity";
import { Lease } from "../db/entities/lease.entity";
import { LeaseHistory } from "../db/entities/lease-history.entity";
import type { WorkerHubService } from "./worker-hub.service";

const DISPATCH_INTERVAL_MS = 200;
const LEASE_TTL_MS = 60_000;

export class DispatchService {
	private running = false;
	private timer: NodeJS.Timeout | null = null;
	private isDispatchPaused: () => boolean = () => false;
	private isDbPartitioned: () => boolean = () => false;
	private getClockSkewMs: () => number = () => 0;

	constructor(
		private readonly workerHub: WorkerHubService,
		opts?: {
			isDispatchPaused?: () => boolean;
			isDbPartitioned?: () => boolean;
			getClockSkewMs?: () => number;
		},
	) {
		if (opts?.isDispatchPaused) this.isDispatchPaused = opts.isDispatchPaused;
		if (opts?.isDbPartitioned) this.isDbPartitioned = opts.isDbPartitioned;
		if (opts?.getClockSkewMs) this.getClockSkewMs = opts.getClockSkewMs;
	}

	start(): void {
		this.running = true;
		this.scheduleNext();
		logger.info("DispatchService started");
	}

	stop(): void {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		logger.info("DispatchService stopped");
	}

	// ── Internal loop ───────────────────────────────────────────────────────

	private scheduleNext(): void {
		this.timer = setTimeout(() => {
			this.tick()
				.catch((err) => logger.error({ err }, "Dispatch tick failed"))
				.finally(() => {
					if (this.running) this.scheduleNext();
				});
		}, DISPATCH_INTERVAL_MS);
	}

	private async tick(): Promise<void> {
		if (this.isDispatchPaused()) return;
		if (this.isDbPartitioned()) {
			logger.warn("Chaos: DB partitioned — skipping dispatch tick");
			return;
		}

		const available = this.workerHub.getAvailableWorkers();
		if (available.length === 0) return;

		// Round-robin across workers: one job per worker per pass, repeat until
		// no more pending jobs or all workers are at capacity.
		let anyDispatched: boolean;
		do {
			anyDispatched = false;
			for (const worker of available) {
				if (worker.inFlight >= worker.concurrencyLimit) continue;
				const dispatched = await this.tryDispatchOne(worker.workerId);
				if (!dispatched) return; // queue empty — stop entirely
				anyDispatched = true;
			}
		} while (anyDispatched);
	}

	// ── Core dispatch transaction ────────────────────────────────────────────

	private async tryDispatchOne(workerId: string): Promise<boolean> {
		let dispatched: { jobId: string; token: string; payload: unknown } | null =
			null;

		await AppDataSource.transaction(async (em) => {
			// Pick one PENDING job. SKIP LOCKED lets multiple coordinator
			// replicas dispatch in parallel without blocking on each other's
			// row locks.
			const [job] = await em.find(Job, {
				where: { Status: JOB_STATUS_ENUM.PENDING },
				order: { CreatedAt: "ASC" },
				take: 1,
				lock: { mode: "pessimistic_write", onLocked: "skip_locked" },
			});
			if (!job) return;

			const jobId = job.JobID;
			const payload = job.Payload;

			// Fencing token + issue timestamp must be allocated atomically across
			// all coordinators: if token A < token B, then ts(A) must be <= ts(B).
			// nextval() alone is serialized by Postgres on the sequence, but
			// clock_timestamp() is a separate volatile read with no defined
			// evaluation order relative to nextval(), so two concurrent sessions
			// can interleave (read clock → wait for seq → get token) and produce
			// (lower_token, higher_ts) pairs that break global monotonicity.
			// We close the race with a transaction-scoped advisory lock taken
			// in a CTE so it is guaranteed to be acquired before the sequence
			// and clock are read.
			const [{ nextval: token, ts_us: issuedAtMs }]: Array<{
				nextval: string;
				ts_us: string;
			}> = await em.query(
				`WITH _lock AS (SELECT pg_advisory_xact_lock(7919))
				 SELECT nextval('fencing_seq') AS nextval,
				        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::bigint AS ts_us
				 FROM _lock`,
			);

			// Lease expiry intentionally uses the chaos-skewed clock — that's
			// what the clock_skew fault is meant to perturb. Fencing itself
			// does not depend on it (token is from the sequence above).
			const expiresAt = new Date(
				Date.now() + LEASE_TTL_MS + this.getClockSkewMs(),
			);

			await em.insert(Lease, {
				JobID: jobId,
				WorkerID: workerId,
				Token: token,
				ExpiresAt: expiresAt,
			});

			await em.update(
				Job,
				{ JobID: jobId },
				{ Status: JOB_STATUS_ENUM.DISPATCHED },
			);

			// Audit/history rows always use the real wall clock. IssuedAtMs
			// comes from Postgres (above) so it stays aligned with token
			// order across concurrent coordinators.
			const nowMs = String(Date.now());
			await em.insert(LeaseHistory, {
				JobID: jobId,
				WorkerID: workerId,
				Fence: token,
				IssuedAtMs: issuedAtMs,
				TerminatedAtMs: null,
			});

			await em.insert(JobTransition, {
				JobID: jobId,
				FromStatus: JOB_STATUS_ENUM.PENDING,
				ToStatus: JOB_STATUS_ENUM.DISPATCHED,
				AtMs: nowMs,
				CoordinatorId: config.coordinatorId,
			});

			dispatched = { jobId, token, payload };
		});

		if (!dispatched) return false;

		// Send to worker AFTER the DB commit so if the send fails, the
		// lease reaper will recover the job rather than losing it forever.
		const { jobId, token, payload } = dispatched as {
			jobId: string;
			token: string;
			payload: unknown;
		};
		const sent = this.workerHub.sendJob(workerId, {
			type: MsgType.JobDispatch,
			jobId,
			token,
			payload: payload as Record<string, unknown>,
			timeoutMs: LEASE_TTL_MS,
		});

		if (!sent) {
			logger.warn(
				{ jobId, workerId },
				"Worker disconnected after dispatch commit — reaper will recover",
			);
		} else {
			logger.info({ jobId, workerId, token }, "Job dispatched");
		}

		return true;
	}
}
