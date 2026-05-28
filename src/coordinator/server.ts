import express from "express";
import { createChaosRouter } from "./routes/chaos";
import { createJobsRouter } from "./routes/jobs";
import { createStatsRouter } from "./routes/stats";
import type { ChaosService } from "./services/chaos.service";
import type { WorkerHubService } from "./services/worker-hub.service";

export function createServer(hub: WorkerHubService, chaos: ChaosService) {
	const app = express();

	app.use(express.json());

	app.get("/health", (_req, res) => {
		res.json({ status: "ok" });
	});

	app.use("/jobs", createJobsRouter());
	app.use("/stats", createStatsRouter(hub));
	app.use("/chaos", createChaosRouter(chaos));

	return app;
}
