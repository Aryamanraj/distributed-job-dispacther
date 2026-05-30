import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppDataSource } from "../../src/coordinator/db/data-source";
import { closeTestDb, initTestDb, resetDb } from "./db-helpers";

describe("fencing: (token, ts_us) global monotonicity under contention", () => {
	beforeAll(async () => {
		await initTestDb();
	});

	afterAll(async () => {
		await closeTestDb();
	});

	beforeEach(async () => {
		await resetDb();
	});

	async function issueOne(): Promise<{ token: bigint; tsUs: bigint }> {
		const [row]: Array<{ nextval: string; ts_us: string }> =
			await AppDataSource.transaction((em) =>
				em.query(
					`WITH _lock AS (SELECT pg_advisory_xact_lock(7919))
					 SELECT nextval('fencing_seq') AS nextval,
					        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::bigint AS ts_us
					 FROM _lock`,
				),
			);
		return { token: BigInt(row.nextval), tsUs: BigInt(row.ts_us) };
	}

	it("100 parallel issuers produce strictly increasing tokens", async () => {
		const issued = await Promise.all(Array.from({ length: 100 }, issueOne));
		const tokens = issued.map((i) => i.token).sort((a, b) => Number(a - b));

		// Strictly increasing: no duplicates, contiguous starting at 1.
		for (let i = 0; i < tokens.length; i++) {
			expect(tokens[i]).toBe(BigInt(i + 1));
		}
	});

	it("ordering by token gives non-decreasing issue timestamps", async () => {
		// This is the global-monotonicity property: a token issued earlier
		// (lower fence) must have been stamped no later than any higher fence.
		const issued = await Promise.all(Array.from({ length: 100 }, issueOne));
		issued.sort((a, b) => Number(a.token - b.token));

		for (let i = 1; i < issued.length; i++) {
			expect(issued[i].tsUs >= issued[i - 1].tsUs).toBe(true);
		}
	});

	it("sequence survives a session 'restart' (mid-run advisory release)", async () => {
		// Simulate a coordinator restart between issuances by running two
		// separate batches. The sequence must continue, not reset.
		const first = await Promise.all(Array.from({ length: 10 }, issueOne));
		const second = await Promise.all(Array.from({ length: 10 }, issueOne));
		const all = [...first, ...second]
			.map((i) => i.token)
			.sort((a, b) => Number(a - b));
		expect(all[0]).toBe(1n);
		expect(all[all.length - 1]).toBe(20n);
	});
});
