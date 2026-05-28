import "dotenv/config";
import { createServer as createHttpServer } from "node:http";
import { WebSocketServer } from "ws";
import { logger } from "../util/logger";
import { config } from "./config";
import { AppDataSource } from "./db/data-source";
import { createServer } from "./server";
import { ChaosService } from "./services/chaos.service";
import { DispatchService } from "./services/dispatch.service";
import { LeaseReaperService } from "./services/lease-reaper.service";
import { WorkerHubService } from "./services/worker-hub.service";

async function main() {
	logger.info("Connecting to database");
	await AppDataSource.initialize();
	logger.info("Database connected");

	const wss = new WebSocketServer({ noServer: true });
	const chaos = new ChaosService();
	const workerHub = new WorkerHubService(wss, chaos);

	const app = createServer(workerHub, chaos);
	const httpServer = createHttpServer(app);
	const dispatch = new DispatchService(workerHub, {
		isDispatchPaused: () => chaos.isDispatchPaused(),
		isDbPartitioned: () => chaos.isDbPartitioned(),
		getClockSkewMs: () => chaos.getClockSkewMs(),
	});
	const reaper = new LeaseReaperService(chaos);

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
		reaper.start();
	});

	// Graceful shutdown
	process.on("SIGTERM", () => {
		dispatch.stop();
		reaper.stop();
		workerHub.stop();
		httpServer.close(() => process.exit(0));
	});
}

main().catch((err) => {
	logger.error({ err }, "Coordinator failed to start");
	process.exit(1);
});
