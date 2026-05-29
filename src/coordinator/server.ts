import express from "express";
import { createAuditRouter } from "./routes/audit";
import { createChaosRouter } from "./routes/chaos";
import { createJobsRouter } from "./routes/jobs";
import { createStatsRouter } from "./routes/stats";
import { createWorkersRouter } from "./routes/workers";
import type { ChaosService } from "./services/chaos.service";
import type { WorkerHubService } from "./services/worker-hub.service";

export function createServer(
	hub: WorkerHubService,
	chaos: ChaosService,
	startedAt: Date,
) {
	const app = express();

	app.use(express.json());

	app.get("/health", (_req, res) => {
		res.json({ status: "ok" });
	});

	app.use("/audit", createAuditRouter());
	app.use("/jobs", createJobsRouter());
	app.use("/stats", createStatsRouter(chaos, startedAt));
	app.use("/chaos", createChaosRouter(chaos));
	app.use("/workers", createWorkersRouter(hub));

	return app;
}
