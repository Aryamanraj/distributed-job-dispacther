import "dotenv/config";
import { logger } from "../util/logger";
import { config } from "./config";
import { AppDataSource } from "./db/data-source";
import { createServer } from "./server";

async function main() {
	logger.info("Connecting to database");
	await AppDataSource.initialize();
	logger.info("Database connected");

	const app = createServer();

	app.listen(config.port, () => {
		logger.info(
			{ port: config.port, coordinatorId: config.coordinatorId },
			"Coordinator listening",
		);
	});
}

main().catch((err) => {
	logger.error({ err }, "Coordinator failed to start");
	process.exit(1);
});
