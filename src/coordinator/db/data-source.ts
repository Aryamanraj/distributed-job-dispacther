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
		node_path.join(
			__dirname,
			"..",
			"..",
			"..",
			"db",
			"migrations",
			"*{.ts,.js}",
		),
	],
	migrationsTableName: "TypeORMMigrations",
});
