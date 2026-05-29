import node_path from "node:path";
import { DataSource } from "typeorm";
import { config } from "../config";

export const AppDataSource = new DataSource({
	type: "postgres",
	host: config.db.host,
	port: config.db.port,
	database: config.db.name,
	username: config.db.user,
	password: config.db.pass,
	synchronize: false,
	logging: config.nodeEnv !== "production",
	entities: [node_path.join(__dirname, "entities", "*.entity{.ts,.js}")],
	migrations: [
		node_path.join(__dirname, "..", "..", "db", "migrations", "*{.ts,.js}"),
	],
	migrationsTableName: "TypeORMMigrations",
});

/**
 * Install the `partition_db` chaos guard on the underlying pg connection pool.
 *
 * Every TypeORM query — whether issued via `repository.find()`, `em.update()`,
 * `AppDataSource.query()`, or inside `AppDataSource.transaction()` — first
 * asks the driver's pool for a connection. By rejecting `pool.connect()` while
 * the partition fault is active we make EVERY in-flight and subsequent query
 * fail immediately, which is the spec's "refuse all queries for N ms"
 * fail-closed behavior.
 *
 * Must be called after `AppDataSource.initialize()` so the driver's pool
 * is constructed.
 */
export function installDbPartitionGuard(isPartitioned: () => boolean): void {
	// TypeORM's PostgresDriver exposes its node-pg Pool as `.master`.
	const driver = AppDataSource.driver as unknown as {
		master?: { connect: (...args: unknown[]) => Promise<unknown> };
	};
	const pool = driver.master;
	if (!pool || typeof pool.connect !== "function") {
		throw new Error(
			"installDbPartitionGuard: could not locate pg pool on TypeORM driver",
		);
	}
	const origConnect = pool.connect.bind(pool);
	pool.connect = ((...args: unknown[]) => {
		if (isPartitioned()) {
			return Promise.reject(
				new Error("DB partitioned (chaos): connection refused"),
			);
		}
		return origConnect(...args);
	}) as typeof pool.connect;
}
