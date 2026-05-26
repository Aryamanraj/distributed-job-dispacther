import express from "express";

export function createServer() {
	const app = express();

	app.use(express.json());

	app.get("/health", (_req, res) => {
		res.json({ status: "ok" });
	});

	return app;
}
