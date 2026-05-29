import { Router } from "express";
import { ResponseCode } from "../../shared/errors";
import { makeResponse } from "../../util/response";
import type { WorkerHubService } from "../services/worker-hub.service";

/**
 * Worker control plane.
 *
 * Spec §3.1: "The concurrency limit is configured per worker and must be
 * changeable at runtime without a worker restart."
 *
 * POST /workers/:workerId/concurrency  { "limit": <int> }
 *   Sends a `control.set_concurrency` message over the worker's existing
 *   outbound WebSocket. The new limit takes effect on the next dispatch
 *   decision; in-flight jobs are untouched.
 *
 * GET /workers
 *   Lists currently-connected workers with their in-flight / limit, useful
 *   for operators choosing which worker to retune.
 */
export function createWorkersRouter(hub: WorkerHubService): Router {
	const router = Router();

	router.get("/", (_req, res) => {
		makeResponse(
			res,
			200,
			true,
			"connected workers",
			{ workers: hub.getWorkerStats() },
			ResponseCode.OK,
		);
	});

	router.post("/:workerId/concurrency", async (req, res) => {
		const { workerId } = req.params;
		const { limit } = req.body as { limit?: unknown };

		if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
			makeResponse(
				res,
				400,
				false,
				"limit must be a positive integer",
				null,
				ResponseCode.VALIDATION_ERROR,
			);
			return;
		}

		const ok = await hub.setConcurrency(workerId, limit);
		if (!ok) {
			makeResponse(
				res,
				404,
				false,
				`worker ${workerId} not connected to this coordinator`,
				null,
				ResponseCode.NOT_FOUND,
			);
			return;
		}

		makeResponse(
			res,
			200,
			true,
			"concurrency updated",
			{ workerId, limit },
			ResponseCode.OK,
		);
	});

	return router;
}
