import type { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1779876937994 implements MigrationInterface {
	async up(queryRunner: QueryRunner): Promise<void> {
		// Globally monotonic fencing token counter — shared across all coordinator instances
		await queryRunner.query(`CREATE SEQUENCE fencing_seq START 1`);

		await queryRunner.query(`
			CREATE TABLE "Jobs" (
				"JobID"          UUID        NOT NULL DEFAULT gen_random_uuid(),
				"IdempotencyKey" TEXT        NOT NULL,
				"Payload"        JSONB       NOT NULL,
				"Status"         TEXT        NOT NULL DEFAULT 'pending',
				"Result"         JSONB,
				"CreatedAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
				"UpdatedAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
				CONSTRAINT "PK_Jobs" PRIMARY KEY ("JobID")
			)
		`);
		await queryRunner.query(
			`CREATE UNIQUE INDEX "UQ_Jobs_IdempotencyKey" ON "Jobs" ("IdempotencyKey")`,
		);
		await queryRunner.query(
			`CREATE INDEX "IX_Jobs_Status" ON "Jobs" ("Status")`,
		);

		await queryRunner.query(`
			CREATE TABLE "Leases" (
				"JobID"     UUID        NOT NULL,
				"WorkerID"  TEXT        NOT NULL,
				"Token"     BIGINT      NOT NULL,
				"ExpiresAt" TIMESTAMPTZ NOT NULL,
				CONSTRAINT "PK_Leases" PRIMARY KEY ("JobID"),
				CONSTRAINT "FK_Leases_Jobs" FOREIGN KEY ("JobID") REFERENCES "Jobs" ("JobID")
			)
		`);
		await queryRunner.query(
			`CREATE INDEX "IX_Leases_ExpiresAt" ON "Leases" ("ExpiresAt")`,
		);

		await queryRunner.query(`
			CREATE TABLE "WorkerReg" (
				"WorkerID"         TEXT        NOT NULL,
				"ConcurrencyLimit" INT         NOT NULL DEFAULT 8,
				"ConnectedAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
				"LastSeenAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
				CONSTRAINT "PK_WorkerReg" PRIMARY KEY ("WorkerID")
			)
		`);

		await queryRunner.query(`
			CREATE TABLE "JobTransitions" (
				"TransitionID" BIGSERIAL NOT NULL,
				"JobID"        UUID      NOT NULL,
				"FromStatus"   TEXT      NOT NULL,
				"ToStatus"     TEXT      NOT NULL,
				"AtMs"         BIGINT    NOT NULL,
				"CoordinatorId" TEXT     NOT NULL,
				CONSTRAINT "PK_JobTransitions" PRIMARY KEY ("TransitionID")
			)
		`);
		await queryRunner.query(
			`CREATE INDEX "IX_JobTransitions_JobID" ON "JobTransitions" ("JobID")`,
		);
	}

	async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP INDEX "IX_JobTransitions_JobID"`);
		await queryRunner.query(`DROP TABLE "JobTransitions"`);
		await queryRunner.query(`DROP TABLE "WorkerReg"`);
		await queryRunner.query(`DROP INDEX "IX_Leases_ExpiresAt"`);
		await queryRunner.query(`DROP TABLE "Leases"`);
		await queryRunner.query(`DROP INDEX "IX_Jobs_Status"`);
		await queryRunner.query(`DROP INDEX "UQ_Jobs_IdempotencyKey"`);
		await queryRunner.query(`DROP TABLE "Jobs"`);
		await queryRunner.query(`DROP SEQUENCE fencing_seq`);
	}
}
