import type { MigrationInterface, QueryRunner } from "typeorm";

export class AuditTables1779900000000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`
			CREATE TABLE "CommitAttempts" (
				"AttemptID" BIGSERIAL PRIMARY KEY,
				"JobID"     UUID    NOT NULL,
				"Accepted"  BOOLEAN NOT NULL,
				"Fence"     BIGINT  NOT NULL,
				"WorkerID"  TEXT    NOT NULL,
				"AtMs"      BIGINT  NOT NULL
			)
		`);
		await queryRunner.query(`
			CREATE INDEX "IX_CommitAttempts_JobID" ON "CommitAttempts" ("JobID")
		`);

		await queryRunner.query(`
			CREATE TABLE "LeaseHistory" (
				"EntryID"         BIGSERIAL PRIMARY KEY,
				"JobID"           UUID   NOT NULL,
				"WorkerID"        TEXT   NOT NULL,
				"Fence"           BIGINT NOT NULL,
				"IssuedAtMs"      BIGINT NOT NULL,
				"TerminatedAtMs"  BIGINT
			)
		`);
		await queryRunner.query(`
			CREATE INDEX "IX_LeaseHistory_JobID" ON "LeaseHistory" ("JobID")
		`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP TABLE IF EXISTS "LeaseHistory"`);
		await queryRunner.query(`DROP TABLE IF EXISTS "CommitAttempts"`);
	}
}
