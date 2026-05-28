import { Router } from "express";
import { type GenericError, ResponseCode } from "../../shared/errors";
import { JOB_STATUS_ENUM } from "../../shared/job-status";
import { makeResponse } from "../../util/response";
import { jobEventRepo, jobRepo } from "../db/repo";

const TERMINAL_STATUSES = new Set([
	JOB_STATUS_ENUM.COMPLETED,
	JOB_STATUS_ENUM.FAILED,
	JOB_STATUS_ENUM.CANCELLED,
]);

const SSE_POLL_INTERVAL_MS = 500;
const SSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function createJobsRouter(): Router {
	const router = Router();

	// POST /jobs — submit a job
	router.post("/", async (req, res) => {
		try {
			const { idempotencyKey, payload } = req.body as {
				idempotencyKey?: string;
				payload?: Record<string, unknown>;
			};

			if (!idempotencyKey || typeof idempotencyKey !== "string") {
				makeResponse(
					res,
					400,
					false,
					"idempotencyKey is required",
					null,
					ResponseCode.VALIDATION_ERROR,
				);
				return;
			}
			// Spec §3.3: idempotency keys are opaque strings up to 128 bytes
			if (Buffer.byteLength(idempotencyKey, "utf8") > 128) {
				makeResponse(
					res,
					400,
					false,
					"idempotencyKey must be 128 bytes or fewer",
					null,
					ResponseCode.VALIDATION_ERROR,
				);
				return;
			}
			if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
				makeResponse(
					res,
					400,
					false,
					"payload must be a JSON object",
					null,
					ResponseCode.VALIDATION_ERROR,
				);
				return;
			}

			// Idempotency: return existing job if key already seen
			const { data: existing } = await jobRepo.get(
				{ where: { IdempotencyKey: idempotencyKey } },
				false,
			);
			if (existing) {
				makeResponse(
					res,
					200,
					true,
					"job already submitted",
					existing,
					ResponseCode.JOB_DUPLICATE,
				);
				return;
			}

			const { data: job, error: createErr } = await jobRepo.create({
				IdempotencyKey: idempotencyKey,
				Payload: payload,
			});
			if (createErr) throw createErr;

			await jobEventRepo.create({ JobID: job?.JobID, Event: "submitted" });

			makeResponse(
				res,
				201,
				true,
				"job created",
				job,
				ResponseCode.JOB_CREATED,
			);
		} catch (err: unknown) {
			// Unique constraint violation — race with another coordinator, return the winner
			const pgErr = err as { code?: string; status?: number; message?: string };
			if (pgErr.code === "23505") {
				const { data: winner } = await jobRepo.get(
					{
						where: {
							IdempotencyKey: (req.body as { idempotencyKey: string })
								.idempotencyKey,
						},
					},
					false,
				);
				makeResponse(
					res,
					200,
					true,
					"job already submitted",
					winner,
					ResponseCode.JOB_DUPLICATE,
				);
				return;
			}
			const status = pgErr.status ?? 500;
			makeResponse(
				res,
				status,
				false,
				pgErr.message ?? "Internal server error",
				null,
				ResponseCode.INTERNAL_ERROR,
			);
		}
	});

	// GET /jobs/:id — fetch job
	router.get("/:id", async (req, res) => {
		try {
			const { data: job } = await jobRepo.get(
				{ where: { JobID: req.params.id } },
				false,
			);
			if (!job) {
				makeResponse(
					res,
					404,
					false,
					"job not found",
					null,
					ResponseCode.JOB_NOT_FOUND,
				);
				return;
			}
			makeResponse(res, 200, true, "job found", job, ResponseCode.OK);
		} catch (err: unknown) {
			const e = err as GenericError;
			makeResponse(
				res,
				e.status ?? 500,
				false,
				e.message ?? "Internal server error",
				null,
				e.code ?? ResponseCode.INTERNAL_ERROR,
			);
		}
	});

	// DELETE /jobs/:id — cancel a job
	router.delete("/:id", async (req, res) => {
		try {
			const { data: job } = await jobRepo.get(
				{ where: { JobID: req.params.id } },
				false,
			);
			if (!job) {
				makeResponse(res, 404, false, "job not found");
				return;
			}
			if (TERMINAL_STATUSES.has(job.Status as JOB_STATUS_ENUM)) {
				makeResponse(res, 409, false, `job is already ${job.Status}`);
				return;
			}

			await jobRepo.update(
				{ JobID: job.JobID },
				{ Status: JOB_STATUS_ENUM.CANCELLED },
			);
			await jobEventRepo.create({ JobID: job.JobID, Event: "cancelled" });

			makeResponse(
				res,
				200,
				true,
				"job cancelled",
				{
					jobId: job.JobID,
					status: JOB_STATUS_ENUM.CANCELLED,
				},
				ResponseCode.JOB_CANCELLED,
			);
		} catch (err: unknown) {
			const e = err as GenericError;
			makeResponse(
				res,
				e.status ?? 500,
				false,
				e.message ?? "Internal server error",
				null,
				e.code ?? ResponseCode.INTERNAL_ERROR,
			);
		}
	});

	// GET /jobs/:id/stream — SSE stream until terminal state
	router.get("/:id/stream", async (req, res) => {
		try {
			const { data: job } = await jobRepo.get(
				{ where: { JobID: req.params.id } },
				false,
			);
			if (!job) {
				makeResponse(
					res,
					404,
					false,
					"job not found",
					null,
					ResponseCode.JOB_NOT_FOUND,
				);
				return;
			}

			// Already done — respond immediately without holding a connection
			if (TERMINAL_STATUSES.has(job.Status as JOB_STATUS_ENUM)) {
				makeResponse(res, 200, true, "job complete", job, ResponseCode.OK);
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
				const { data: current } = await jobRepo.get(
					{ where: { JobID: req.params.id } },
					false,
				);
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
		} catch (err: unknown) {
			const e = err as GenericError;
			makeResponse(
				res,
				e.status ?? 500,
				false,
				e.message ?? "Internal server error",
				null,
				e.code ?? ResponseCode.INTERNAL_ERROR,
			);
		}
	});

	return router;
}
