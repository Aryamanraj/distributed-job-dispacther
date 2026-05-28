import { In, LessThan } from "typeorm";
import { JOB_STATUS_ENUM } from "../../shared/job-status";
import { logger } from "../../util/logger";
import { AppDataSource } from "../db/data-source";
import { Job } from "../db/entities/job.entity";
import { Lease } from "../db/entities/lease.entity";

const REAPER_INTERVAL_MS = 5_000;

/**
 * Periodically scans for DISPATCHED jobs whose lease has expired and resets
 * them back to PENDING so the DispatchService can re-dispatch them.
 *
 * Uses FOR UPDATE SKIP LOCKED so multiple coordinator replicas don't
 * double-process the same expired lease.
 */
export class LeaseReaperService {
	private running = false;
	private timer: NodeJS.Timeout | null = null;

	start(): void {
		this.running = true;
		this.scheduleNext();
		logger.info("LeaseReaperService started");
	}

	stop(): void {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		logger.info("LeaseReaperService stopped");
	}

	// ── Internal loop ───────────────────────────────────────────────────────

	private scheduleNext(): void {
		this.timer = setTimeout(() => {
			this.tick()
				.catch((err) => logger.error({ err }, "LeaseReaper tick failed"))
				.finally(() => {
					if (this.running) this.scheduleNext();
				});
		}, REAPER_INTERVAL_MS);
	}

	private async tick(): Promise<void> {
		await AppDataSource.transaction(async (em) => {
			// Lock expired leases — SKIP LOCKED avoids contention across replicas.
			const leases = await em.find(Lease, {
				where: {
					ExpiresAt: LessThan(new Date()),
					Job: { Status: JOB_STATUS_ENUM.DISPATCHED },
				},
				lock: { mode: "pessimistic_write", onLocked: "skip_locked" },
			});

			if (leases.length === 0) return;

			const ids = leases.map((l) => l.JobID);
			logger.warn({ count: ids.length, ids }, "Reaping expired leases");

			await em.delete(Lease, { JobID: In(ids) });
			await em.update(
				Job,
				{ JobID: In(ids) },
				{ Status: JOB_STATUS_ENUM.PENDING, UpdatedAt: new Date() },
			);

			logger.info(
				{ count: ids.length },
				"Expired leases reaped, jobs reset to PENDING",
			);
		});
	}
}
