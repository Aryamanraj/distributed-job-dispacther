import { Router } from "express";
import { JOB_STATUS_ENUM } from "../../shared/job-status";
import { AppDataSource } from "../db/data-source";
import { Job } from "../db/entities/job.entity";
import { JobEvent } from "../db/entities/job-event.entity";

const TERMINAL_STATUSES = new Set([
	JOB_STATUS_ENUM.COMPLETED,
	JOB_STATUS_ENUM.FAILED,
	JOB_STATUS_ENUM.CANCELLED,
]);

const SSE_POLL_INTERVAL_MS = 500;
const SSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function createJobsRouter(): Router {
	const router = Router();
	const jobRepo = AppDataSource.getRepository(Job);
	const eventRepo = AppDataSource.getRepository(JobEvent);

	// POST /jobs — submit a job
	router.post("/", async (req, res) => {
		const { idempotencyKey, payload } = req.body as {
			idempotencyKey?: string;
			payload?: Record<string, unknown>;
		};

		if (!idempotencyKey || typeof idempotencyKey !== "string") {
			res.status(400).json({ error: "idempotencyKey is required" });
			return;
		}
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			res.status(400).json({ error: "payload must be a JSON object" });
			return;
		}

		// Idempotency: return existing job if key already seen
		const existing = await jobRepo.findOne({
			where: { IdempotencyKey: idempotencyKey },
		});
		if (existing) {
			res.status(200).json(existing);
			return;
		}

		try {
			const job = jobRepo.create({
				IdempotencyKey: idempotencyKey,
				Payload: payload,
			});
			await jobRepo.save(job);

			await eventRepo.save(
				eventRepo.create({ JobID: job.JobID, Event: "submitted" }),
			);

			res.status(201).json(job);
		} catch (err: unknown) {
			// Unique constraint violation — race with another coordinator, return the winner
			const pgErr = err as { code?: string };
			if (pgErr.code === "23505") {
				const winner = await jobRepo.findOne({
					where: { IdempotencyKey: idempotencyKey },
				});
				res.status(200).json(winner);
				return;
			}
			throw err;
		}
	});

	// GET /jobs/:id — fetch job
	router.get("/:id", async (req, res) => {
		const job = await jobRepo.findOne({ where: { JobID: req.params.id } });
		if (!job) {
			res.status(404).json({ error: "job not found" });
			return;
		}
		res.json(job);
	});

	// DELETE /jobs/:id — cancel a job
	router.delete("/:id", async (req, res) => {
		const job = await jobRepo.findOne({ where: { JobID: req.params.id } });
		if (!job) {
			res.status(404).json({ error: "job not found" });
			return;
		}
		if (TERMINAL_STATUSES.has(job.Status as JOB_STATUS_ENUM)) {
			res.status(409).json({ error: `job is already ${job.Status}` });
			return;
		}

		await jobRepo.update(
			{ JobID: job.JobID },
			{ Status: JOB_STATUS_ENUM.CANCELLED },
		);
		await eventRepo.save(
			eventRepo.create({ JobID: job.JobID, Event: "cancelled" }),
		);

		res.json({ jobId: job.JobID, status: JOB_STATUS_ENUM.CANCELLED });
	});

	// GET /jobs/:id/stream — SSE stream until terminal state
	router.get("/:id/stream", async (req, res) => {
		const job = await jobRepo.findOne({ where: { JobID: req.params.id } });
		if (!job) {
			res.status(404).json({ error: "job not found" });
			return;
		}

		// Already done — respond immediately without holding a connection
		if (TERMINAL_STATUSES.has(job.Status as JOB_STATUS_ENUM)) {
			res.setHeader("Content-Type", "application/json");
			res.json(job);
			return;
		}

		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.flushHeaders();

		const sendEvent = (data: object) => {
			res.write(`data: ${JSON.stringify(data)}\n\n`);
		};

		sendEvent({ status: job.Status, jobId: job.JobID });

		const deadline = setTimeout(() => {
			sendEvent({ error: "stream timeout" });
			res.end();
		}, SSE_TIMEOUT_MS);

		const poll = setInterval(async () => {
			const current = await jobRepo.findOne({
				where: { JobID: req.params.id },
			});
			if (!current) {
				clearInterval(poll);
				clearTimeout(deadline);
				res.end();
				return;
			}

			sendEvent({
				status: current.Status,
				jobId: current.JobID,
				result: current.Result,
			});

			if (TERMINAL_STATUSES.has(current.Status as JOB_STATUS_ENUM)) {
				clearInterval(poll);
				clearTimeout(deadline);
				res.end();
			}
		}, SSE_POLL_INTERVAL_MS);

		req.on("close", () => {
			clearInterval(poll);
			clearTimeout(deadline);
		});
	});

	return router;
}
