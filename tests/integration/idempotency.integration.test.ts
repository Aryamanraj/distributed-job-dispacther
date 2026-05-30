import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppDataSource } from "../../src/coordinator/db/data-source";
import { Job } from "../../src/coordinator/db/entities/job.entity";
import { closeTestDb, initTestDb, resetDb } from "./db-helpers";

describe("idempotency: UNIQUE(IdempotencyKey)", () => {
	beforeAll(async () => {
		await initTestDb();
	});

	afterAll(async () => {
		await closeTestDb();
	});

	beforeEach(async () => {
		await resetDb();
	});

	it("a second insert with the same key fails with a unique-constraint violation", async () => {
		const key = `dup-${randomUUID()}`;
		await AppDataSource.manager.insert(Job, {
			IdempotencyKey: key,
			Payload: { x: 1 },
		});
		await expect(
			AppDataSource.manager.insert(Job, {
				IdempotencyKey: key,
				Payload: { x: 2 },
			}),
		).rejects.toMatchObject({
			// pg unique_violation
			code: "23505",
		});
	});

	it("two concurrent inserts in the same millisecond yield exactly one row", async () => {
		const key = `race-${randomUUID()}`;
		const attempt = () =>
			AppDataSource.transaction(async (em) => {
				await em.insert(Job, {
					IdempotencyKey: key,
					Payload: { winner: Math.random() },
				});
			});

		const results = await Promise.allSettled([attempt(), attempt()]);
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);

		const rows = await AppDataSource.manager.find(Job, {
			where: { IdempotencyKey: key },
		});
		expect(rows).toHaveLength(1);
	});

	it("different keys produce distinct rows", async () => {
		await AppDataSource.manager.insert(Job, {
			IdempotencyKey: `a-${randomUUID()}`,
			Payload: {},
		});
		await AppDataSource.manager.insert(Job, {
			IdempotencyKey: `b-${randomUUID()}`,
			Payload: {},
		});
		const count = await AppDataSource.manager.count(Job);
		expect(count).toBe(2);
	});
});
