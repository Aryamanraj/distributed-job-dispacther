import "dotenv/config";
import { AppDataSource } from "./coordinator/db/data-source";
import { logger } from "./util/logger";

async function migrate() {
	logger.info("Initializing database connection");
	await AppDataSource.initialize();

	try {
		const pending = await AppDataSource.showMigrations();
		if (!pending) {
			logger.info("No pending migrations — database is up to date");
			return;
		}

		logger.info("Running pending migrations");
		const ran = await AppDataSource.runMigrations({ transaction: "each" });

		for (const m of ran) {
			logger.info({ migration: m.name }, "Migration applied");
		}

		logger.info({ count: ran.length }, "All migrations complete");
	} finally {
		await AppDataSource.destroy();
	}
}

migrate().catch((err) => {
	logger.error({ err }, "Migration failed");
	process.exit(1);
});
