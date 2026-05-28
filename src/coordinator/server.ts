import express from "express";
import { createJobsRouter } from "./routes/jobs";
import { createStatsRouter } from "./routes/stats";
import type { WorkerHubService } from "./services/worker-hub.service";

export function createServer(hub: WorkerHubService) {
	const app = express();

	app.use(express.json());

	app.get("/health", (_req, res) => {
		res.json({ status: "ok" });
	});

	app.use("/jobs", createJobsRouter());
	app.use("/stats", createStatsRouter(hub));

	return app;
}
