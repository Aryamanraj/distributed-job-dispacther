import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

let container: StartedPostgreSqlContainer | null = null;

export async function setup(): Promise<void> {
	container = await new PostgreSqlContainer("postgres:16-alpine")
		.withDatabase("dispatcher_test")
		.withUsername("postgres")
		.withPassword("postgres")
		.start();

	process.env.DB_HOST = container.getHost();
	process.env.DB_PORT = String(container.getMappedPort(5432));
	process.env.DB_NAME = "dispatcher_test";
	process.env.DB_USER = "postgres";
	process.env.DB_PASS = "postgres";
	process.env.COORDINATOR_ID = "test";
	process.env.LOG_LEVEL = "error";
	// Suppress TypeORM query logging — AppDataSource only enables logging
	// when NODE_ENV !== "production".
	process.env.NODE_ENV = "production";
}

export async function teardown(): Promise<void> {
	if (container) await container.stop();
	container = null;
}
