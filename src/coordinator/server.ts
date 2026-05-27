import express from "express";
import { createJobsRouter } from "./routes/jobs";

export function createServer() {
	const app = express();

	app.use(express.json());

	app.get("/health", (_req, res) => {
		res.json({ status: "ok" });
	});

	app.use("/jobs", createJobsRouter());

	return app;
}
