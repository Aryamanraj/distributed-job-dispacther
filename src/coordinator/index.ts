import "dotenv/config";
import { createServer as createHttpServer } from "node:http";
import { WebSocketServer } from "ws";
import { logger } from "../util/logger";
import { config } from "./config";
import { AppDataSource } from "./db/data-source";
import { createServer } from "./server";
import { DispatchService } from "./services/dispatch.service";
import { WorkerHubService } from "./services/worker-hub.service";

async function main() {
	logger.info("Connecting to database");
	await AppDataSource.initialize();
	logger.info("Database connected");

	const app = createServer();
	const httpServer = createHttpServer(app);

	const wss = new WebSocketServer({ noServer: true });
	const workerHub = new WorkerHubService(wss);
	const dispatch = new DispatchService(workerHub);

	httpServer.on("upgrade", (req, socket, head) => {
		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit("connection", ws, req);
		});
	});

	httpServer.listen(config.port, () => {
		logger.info(
			{ port: config.port, coordinatorId: config.coordinatorId },
			"Coordinator listening",
		);
		dispatch.start();
	});

	// Graceful shutdown
	process.on("SIGTERM", () => {
		dispatch.stop();
		workerHub.stop();
		httpServer.close(() => process.exit(0));
	});
}

main().catch((err) => {
	logger.error({ err }, "Coordinator failed to start");
	process.exit(1);
});
