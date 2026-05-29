import { Router } from "express";
import { ResponseCode } from "../../shared/errors";
import { makeResponse } from "../../util/response";
import {
	commitAttemptRepo,
	jobTransitionRepo,
	leaseHistoryRepo,
} from "../db/repo";

/**
 * GET /audit?job_id=<uuid>
 *
 * Returns the full audit trail for a single job.  The chaos harness reads:
 *   body.transitions   — [{from, to, at_ms, coordinator}]
 *   body.commits       — [{accepted: bool, fence: int, worker, at_ms}]
 *   body.lease_history — [{fence: int, worker, issued_at_ms, expired_at_ms}]
 *
 * IMPORTANT: `fence` values and timestamps must be JS numbers (not strings).
 * pg returns BIGINT columns as strings, so we convert with Number() below.
 */
export function createAuditRouter(): Router {
	const router = Router();

	router.get("/", async (req, res) => {
		const jobId = req.query.job_id as string | undefined;
		if (!jobId) {
			makeResponse(
				res,
				400,
				false,
				"job_id query param required",
				null,
				ResponseCode.VALIDATION_ERROR,
			);
			return;
		}

		const [{ data: transitions }, { data: commits }, { data: leases }] =
			await Promise.all([
				jobTransitionRepo.getAll(
					{ where: { JobID: jobId }, order: { AtMs: "ASC" } },
					false,
				),
				commitAttemptRepo.getAll(
					{ where: { JobID: jobId }, order: { AtMs: "ASC" } },
					false,
				),
				leaseHistoryRepo.getAll(
					{
						where: { JobID: jobId },
						order: { IssuedAtMs: "ASC", Fence: "ASC" },
					},
					false,
				),
			]);

		makeResponse(
			res,
			200,
			true,
			"audit",
			{
				transitions: (transitions ?? []).map((t) => ({
					from: t.FromStatus,
					to: t.ToStatus,
					at_ms: Number(t.AtMs),
					coordinator: t.CoordinatorId,
				})),
				commits: (commits ?? []).map((c) => ({
					accepted: Boolean(c.Accepted),
					fence: Number(c.Fence),
					worker: c.WorkerID,
					at_ms: Number(c.AtMs),
				})),
				lease_history: (leases ?? []).map((l) => ({
					fence: Number(l.Fence),
					worker: l.WorkerID,
					issued_at_ms: Number(l.IssuedAtMs),
					expired_at_ms:
						l.TerminatedAtMs !== null ? Number(l.TerminatedAtMs) : null,
				})),
			},
			ResponseCode.OK,
		);
	});

	return router;
}
