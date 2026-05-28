import "dotenv/config";
import { logger } from "../util/logger";
import { config } from "./config";
import { WorkerService } from "./worker";

logger.info(
	{ workerId: config.workerId, concurrencyLimit: config.concurrencyLimit },
	"Worker starting",
);

const worker = new WorkerService();
worker.start();

process.on("SIGTERM", () => {
	logger.info("SIGTERM received — shutting down");
	worker.stop();
	process.exit(0);
});
