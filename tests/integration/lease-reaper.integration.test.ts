import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppDataSource } from "../../src/coordinator/db/data-source";
import { Job } from "../../src/coordinator/db/entities/job.entity";
import { JobTransition } from "../../src/coordinator/db/entities/job-transition.entity";
import { Lease } from "../../src/coordinator/db/entities/lease.entity";
import { LeaseHistory } from "../../src/coordinator/db/entities/lease-history.entity";
import { LeaseReaperService } from "../../src/coordinator/services/lease-reaper.service";
import { JOB_STATUS_ENUM } from "../../src/shared/job-status";
import { closeTestDb, initTestDb, resetDb } from "./db-helpers";

describe("lease reaper: expired leases reset jobs to PENDING", () => {
	let reaper: LeaseReaperService;

	beforeAll(async () => {
		await initTestDb();
		reaper = new LeaseReaperService();
	});

	afterAll(async () => {
		await closeTestDb();
	});

	beforeEach(async () => {
		await resetDb();
	});

	async function seedDispatchedJobWithExpiredLease(
		workerId = "w-test",
	): Promise<{ jobId: string; fence: bigint }> {
		const jobId = randomUUID();
		const fence = BigInt(
			(
				await AppDataSource.query<Array<{ nextval: string }>>(
					`SELECT nextval('fencing_seq') AS nextval`,
				)
			)[0].nextval,
		);
		await AppDataSource.manager.insert(Job, {
			JobID: jobId,
			IdempotencyKey: `idem-${jobId}`,
			Payload: { sleepMs: 50 },
			Status: JOB_STATUS_ENUM.DISPATCHED,
		});
		await AppDataSource.manager.insert(Lease, {
			JobID: jobId,
			WorkerID: workerId,
			Token: fence.toString(),
			// 1 second in the past — comfortably expired
			ExpiresAt: new Date(Date.now() - 1_000),
		});
		await AppDataSource.manager.insert(LeaseHistory, {
			JobID: jobId,
			WorkerID: workerId,
			Fence: fence.toString(),
			IssuedAtMs: String(Date.now() - 10_000),
			TerminatedAtMs: null,
		});
		return { jobId, fence };
	}

	// LeaseReaperService.tick is private; expose it via the service surface
	// the same way the timer loop would. Calling .start() + waiting 5s would
	// work but is slow and flaky — invoking the underlying behaviour directly
	// via a bracketed cast keeps the test deterministic.
	async function runOneReaperTick(): Promise<void> {
		await (reaper as unknown as { tick: () => Promise<void> }).tick();
	}

	it("expired lease is deleted and job goes back to PENDING", async () => {
		const { jobId } = await seedDispatchedJobWithExpiredLease();

		await runOneReaperTick();

		const leaseAfter = await AppDataSource.manager.findOne(Lease, {
			where: { JobID: jobId },
		});
		expect(leaseAfter).toBeNull();

		const jobAfter = await AppDataSource.manager.findOneOrFail(Job, {
			where: { JobID: jobId },
		});
		expect(jobAfter.Status).toBe(JOB_STATUS_ENUM.PENDING);
	});

	it("writes a LeaseHistory.TerminatedAtMs row for audit", async () => {
		const { jobId, fence } = await seedDispatchedJobWithExpiredLease();

		await runOneReaperTick();

		const hist = await AppDataSource.manager.findOneOrFail(LeaseHistory, {
			where: { JobID: jobId, Fence: fence.toString() },
		});
		expect(hist.TerminatedAtMs).not.toBeNull();
		expect(BigInt(hist.TerminatedAtMs as string)).toBeGreaterThan(0n);
	});

	it("writes a DISPATCHED→PENDING JobTransition for audit", async () => {
		const { jobId } = await seedDispatchedJobWithExpiredLease();

		await runOneReaperTick();

		const transition = await AppDataSource.manager.findOne(JobTransition, {
			where: {
				JobID: jobId,
				FromStatus: JOB_STATUS_ENUM.DISPATCHED,
				ToStatus: JOB_STATUS_ENUM.PENDING,
			},
		});
		expect(transition).not.toBeNull();
	});

	it("leaves non-expired leases alone", async () => {
		const jobId = randomUUID();
		await AppDataSource.manager.insert(Job, {
			JobID: jobId,
			IdempotencyKey: `live-${jobId}`,
			Payload: {},
			Status: JOB_STATUS_ENUM.DISPATCHED,
		});
		await AppDataSource.manager.insert(Lease, {
			JobID: jobId,
			WorkerID: "w-live",
			Token: "999",
			ExpiresAt: new Date(Date.now() + 60_000),
		});

		await runOneReaperTick();

		const lease = await AppDataSource.manager.findOne(Lease, {
			where: { JobID: jobId },
		});
		expect(lease).not.toBeNull();
		const job = await AppDataSource.manager.findOneOrFail(Job, {
			where: { JobID: jobId },
		});
		expect(job.Status).toBe(JOB_STATUS_ENUM.DISPATCHED);
	});

	it("reaps multiple expired leases in a single tick", async () => {
		const { jobId: j1 } = await seedDispatchedJobWithExpiredLease("w-a");
		const { jobId: j2 } = await seedDispatchedJobWithExpiredLease("w-b");
		const { jobId: j3 } = await seedDispatchedJobWithExpiredLease("w-c");

		await runOneReaperTick();

		for (const id of [j1, j2, j3]) {
			const lease = await AppDataSource.manager.findOne(Lease, {
				where: { JobID: id },
			});
			expect(lease).toBeNull();
		}
		const remaining = await AppDataSource.manager.count(Lease);
		expect(remaining).toBe(0);
	});
});
