import "dotenv/config";
import { logger } from "../util/logger";
import { config } from "./config";
import { createServer } from "./server";

const app = createServer();

app.listen(config.port, () => {
	logger.info(
		{ port: config.port, coordinatorId: config.coordinatorId },
		"Coordinator listening",
	);
});
