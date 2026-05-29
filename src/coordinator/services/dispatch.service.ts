import { JOB_STATUS_ENUM } from "../../shared/job-status";
import { MsgType } from "../../shared/protocol";
import { logger } from "../../util/logger";
import { AppDataSource } from "../db/data-source";
import { jobRepo, leaseRepo } from "../db/repo";
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
			// FOR UPDATE SKIP LOCKED — safe across multiple coordinator replicas;
			// each picks a different row without blocking each other.
			const rows: Array<{ JobID: string; Payload: unknown }> = await em.query(
				`SELECT "JobID", "Payload"
				   FROM "Jobs"
				  WHERE "Status" = $1
				  ORDER BY "CreatedAt"
				  LIMIT 1
				  FOR UPDATE SKIP LOCKED`,
				[JOB_STATUS_ENUM.PENDING],
			);

			if (rows.length === 0) return;

			const { JobID: jobId, Payload: payload } = rows[0];

			// Monotonic fencing token — global across all coordinators and
			// restarts because it lives in Postgres, not in process memory.
			const tokenRows: Array<{ nextval: string }> = await em.query(
				`SELECT nextval('fencing_seq') AS nextval`,
			);
			const token = tokenRows[0].nextval;

			const expiresAt = new Date(
				Date.now() + LEASE_TTL_MS + this.getClockSkewMs(),
			);

			await leaseRepo.insert(
				{
					JobID: jobId,
					WorkerID: workerId,
					Token: token,
					ExpiresAt: expiresAt,
				},
				em,
			);

			await jobRepo.update(
				{ JobID: jobId },
				{ Status: JOB_STATUS_ENUM.DISPATCHED },
				em,
			);

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
