import type { EntityManager } from "typeorm";
import { AppDataSource } from "../../src/coordinator/db/data-source";
import { CommitAttempt } from "../../src/coordinator/db/entities/commit-attempt.entity";
import { Job } from "../../src/coordinator/db/entities/job.entity";
import { JobTransition } from "../../src/coordinator/db/entities/job-transition.entity";
import { Lease } from "../../src/coordinator/db/entities/lease.entity";
import { LeaseHistory } from "../../src/coordinator/db/entities/lease-history.entity";
import { WorkerReg } from "../../src/coordinator/db/entities/worker-reg.entity";
import { InitialSchema1779876937994 } from "../../src/db/migrations/1779876937994-initial-schema";
import { AuditTables1779900000000 } from "../../src/db/migrations/1779900000000-audit-tables";

export async function initTestDb(): Promise<void> {
	if (!AppDataSource.isInitialized) {
		const opts = AppDataSource.options as {
			entities: unknown[];
			migrations: unknown[];
		};
		opts.entities = [
			Job,
			Lease,
			WorkerReg,
			JobTransition,
			LeaseHistory,
			CommitAttempt,
		];
		opts.migrations = [InitialSchema1779876937994, AuditTables1779900000000];
		await AppDataSource.initialize();
		await AppDataSource.runMigrations();
	}
}

export async function closeTestDb(): Promise<void> {
	if (AppDataSource.isInitialized) {
		await AppDataSource.destroy();
	}
}

/**
 * Truncate every domain table and reset the fencing sequence. Call between
 * tests to keep them independent.
 */
export async function resetDb(
	em: EntityManager = AppDataSource.manager,
): Promise<void> {
	await em.query(
		`TRUNCATE TABLE "Leases", "LeaseHistory", "CommitAttempts", "JobTransitions", "Jobs", "WorkerReg" RESTART IDENTITY CASCADE`,
	);
	await em.query(`ALTER SEQUENCE fencing_seq RESTART WITH 1`);
}
