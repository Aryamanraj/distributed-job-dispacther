import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppDataSource } from "../../src/coordinator/db/data-source";
import { Job } from "../../src/coordinator/db/entities/job.entity";
import { Lease } from "../../src/coordinator/db/entities/lease.entity";
import { JOB_STATUS_ENUM } from "../../src/shared/job-status";
import { closeTestDb, initTestDb, resetDb } from "./db-helpers";

describe("commit: stale tokens are rejected, live tokens accepted, retries idempotent", () => {
	beforeAll(async () => {
		await initTestDb();
	});

	afterAll(async () => {
		await closeTestDb();
	});

	beforeEach(async () => {
		await resetDb();
	});

	async function seedJobAndLease(
		token: bigint,
		workerId = "w-test",
	): Promise<string> {
		const jobId = randomUUID();
		await AppDataSource.manager.insert(Job, {
			JobID: jobId,
			IdempotencyKey: `idem-${jobId}`,
			Payload: {},
			Status: JOB_STATUS_ENUM.DISPATCHED,
		});
		await AppDataSource.manager.insert(Lease, {
			JobID: jobId,
			WorkerID: workerId,
			Token: token.toString(),
			ExpiresAt: new Date(Date.now() + 60_000),
		});
		return jobId;
	}

	/** Simulates the coordinator's "is this token still valid?" check. */
	async function lookupLeaseByToken(
		jobId: string,
		token: bigint,
	): Promise<Lease | null> {
		return AppDataSource.manager.findOne(Lease, {
			where: { JobID: jobId, Token: token.toString() },
		});
	}

	it("a commit with the matching token finds the lease", async () => {
		const jobId = await seedJobAndLease(42n);
		const lease = await lookupLeaseByToken(jobId, 42n);
		expect(lease).not.toBeNull();
		expect(lease?.WorkerID).toBe("w-test");
	});

	it("a commit with a stale (lower) token does not match", async () => {
		const jobId = await seedJobAndLease(100n);
		const lease = await lookupLeaseByToken(jobId, 99n);
		expect(lease).toBeNull();
	});

	it("after the lease is reaped, even the originally-valid token does not match", async () => {
		const jobId = await seedJobAndLease(7n);
		// reaper deletes the lease
		await AppDataSource.manager.delete(Lease, { JobID: jobId });

		const lease = await lookupLeaseByToken(jobId, 7n);
		expect(lease).toBeNull();
	});

	it("a re-dispatched lease has a new token; the old one is no longer valid", async () => {
		const jobId = await seedJobAndLease(50n);
		// simulate: reaper deletes, dispatcher re-leases with new token
		await AppDataSource.manager.delete(Lease, { JobID: jobId });
		await AppDataSource.manager.insert(Lease, {
			JobID: jobId,
			WorkerID: "w-other",
			Token: "51",
			ExpiresAt: new Date(Date.now() + 60_000),
		});

		expect(await lookupLeaseByToken(jobId, 50n)).toBeNull();
		const fresh = await lookupLeaseByToken(jobId, 51n);
		expect(fresh).not.toBeNull();
		expect(fresh?.WorkerID).toBe("w-other");
	});

	it("idempotent commit: marking SUCCEEDED twice does not produce two rows", async () => {
		const jobId = await seedJobAndLease(1n);
		// First commit
		await AppDataSource.manager.update(
			Job,
			{ JobID: jobId },
			{ Status: JOB_STATUS_ENUM.SUCCEEDED, Result: { ok: true } },
		);
		// Second commit (worker retried because ack was dropped) — same outcome
		await AppDataSource.manager.update(
			Job,
			{ JobID: jobId },
			{ Status: JOB_STATUS_ENUM.SUCCEEDED, Result: { ok: true } },
		);

		const rows = await AppDataSource.manager.find(Job, {
			where: { JobID: jobId },
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].Status).toBe(JOB_STATUS_ENUM.SUCCEEDED);
	});
});
