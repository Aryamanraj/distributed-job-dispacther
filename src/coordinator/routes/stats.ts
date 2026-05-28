import { Router } from "express";
import { ResponseCode } from "../../shared/errors";
import { JOB_STATUS_ENUM } from "../../shared/job-status";
import { makeResponse } from "../../util/response";
import { AppDataSource } from "../db/data-source";
import { Job } from "../db/entities/job.entity";
import type { WorkerHubService } from "../services/worker-hub.service";
import type { StatsDto } from "./dto/stats.dto";

export function createStatsRouter(hub: WorkerHubService): Router {
	const router = Router();

	router.get("/", async (_req, res) => {
		const repo = AppDataSource.getRepository(Job);

		const [pending, dispatched, completed, failed, cancelled] =
			await Promise.all([
				repo.count({ where: { Status: JOB_STATUS_ENUM.PENDING } }),
				repo.count({ where: { Status: JOB_STATUS_ENUM.DISPATCHED } }),
				repo.count({ where: { Status: JOB_STATUS_ENUM.COMPLETED } }),
				repo.count({ where: { Status: JOB_STATUS_ENUM.FAILED } }),
				repo.count({ where: { Status: JOB_STATUS_ENUM.CANCELLED } }),
			]);

		const workerStats = hub.getWorkerStats();

		const data: StatsDto = {
			workers_connected: workerStats.length,
			workers_busy: workerStats.filter((w) => w.inFlight > 0).length,
			jobs_pending: pending,
			jobs_dispatched: dispatched,
			jobs_completed: completed,
			jobs_failed: failed,
			jobs_cancelled: cancelled,
		};

		makeResponse(res, 200, true, "stats", data, ResponseCode.OK);
	});

	return router;
}
