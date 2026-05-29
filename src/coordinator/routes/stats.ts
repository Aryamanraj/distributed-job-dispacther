import { Router } from "express";
import { LessThan, MoreThan } from "typeorm";
import { JOB_STATUS_ENUM } from "../../shared/job-status";
import { config } from "../config";
import { AppDataSource } from "../db/data-source";
import { jobRepo } from "../db/repo/job.repo";
import { leaseRepo } from "../db/repo/lease.repo";
import { workerRegRepo } from "../db/repo/worker-reg.repo";
import type { ChaosService } from "../services/chaos.service";

// A worker is considered globally alive if it ponged within 3× the ping interval.
const WORKER_ALIVE_MS = 90_000;

// Must match LEASE_TTL_MS in dispatch.service.ts
const LEASE_TTL_MS = 60_000;

function formatUptime(ms: number): string {
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	const h = Math.floor(m / 60);
	const d = Math.floor(h / 24);
	if (d > 0) return `${d}d${h % 24}h${m % 60}m`;
	if (h > 0) return `${h}h${m % 60}m`;
	if (m > 0) return `${m}m${s % 60}s`;
	return `${s}s`;
}

export function createStatsRouter(
	chaos: ChaosService,
	startedAt: Date,
): Router {
	const router = Router();

	router.get("/", async (_req, res) => {
		const now = new Date(chaos.now());

		const [
			{ data: pendingJobs },
			{ data: dispatchedJobs },
			{ data: activeLeases },
			{ data: stuckLeases },
			{ data: expiringLeases },
		] = await Promise.all([
			jobRepo.count({ where: { Status: JOB_STATUS_ENUM.PENDING } }),
			jobRepo.count({ where: { Status: JOB_STATUS_ENUM.DISPATCHED } }),
			leaseRepo.count({}),
			leaseRepo.count({
				where: {
					ExpiresAt: LessThan(new Date(now.getTime() + LEASE_TTL_MS - 30_000)),
				},
			}),
			leaseRepo.count({
				where: { ExpiresAt: LessThan(new Date(now.getTime() + 5_000)) },
			}),
		]);

		// Use a raw query so we can compare BIGINT AtMs without TypeORM string coercion.
		const windowMs = String(now.getTime() - 60_000);
		const recentTransitions = await AppDataSource.query<
			Array<{ FromStatus: string; ToStatus: string }>
		>(
			`SELECT "FromStatus", "ToStatus" FROM "JobTransitions" WHERE "AtMs" > $1`,
			[windowMs],
		);

		const submitted60 = recentTransitions.filter(
			(t) => t.FromStatus === "" && t.ToStatus === JOB_STATUS_ENUM.PENDING,
		).length;
		const completed60 = recentTransitions.filter(
			(t) => t.ToStatus === JOB_STATUS_ENUM.SUCCEEDED,
		).length;
		const failed60 = recentTransitions.filter(
			(t) => t.ToStatus === JOB_STATUS_ENUM.FAILED,
		).length;
		const lost60 = recentTransitions.filter(
			(t) =>
				t.FromStatus === JOB_STATUS_ENUM.DISPATCHED &&
				t.ToStatus === JOB_STATUS_ENUM.PENDING,
		).length;

		// Global worker view: WorkerReg for all alive workers + Leases count per
		// worker for inFlight. Using Leases as the source of truth means any
		// coordinator can report accurate inFlight for all workers cluster-wide —
		// no coordinator-to-coordinator gossip needed.
		const [{ data: globalWorkers }, { data: allLeases }] = await Promise.all([
			workerRegRepo.getAll(
				{
					where: {
						LastSeenAt: MoreThan(new Date(Date.now() - WORKER_ALIVE_MS)),
					},
					order: { WorkerID: "ASC" },
				},
				false,
			),
			leaseRepo.getAll({ select: { WorkerID: true } }, false),
		]);
		const inFlightMap = new Map<string, number>();
		for (const lease of allLeases ?? []) {
			inFlightMap.set(
				lease.WorkerID,
				(inFlightMap.get(lease.WorkerID) ?? 0) + 1,
			);
		}
		const workerDetail =
			(globalWorkers ?? []).length === 0
				? "none"
				: (globalWorkers ?? [])
						.map((w) => {
							const inFlight = inFlightMap.get(w.WorkerID) ?? 0;
							return `${w.WorkerID}:${inFlight}/${w.ConcurrencyLimit}`;
						})
						.join("  ");

		const uptimeMs = Date.now() - startedAt.getTime();

		const chaosState = chaos.getState();
		const chaosLine = [
			chaosState.dispatchPaused ? "dispatch_paused" : null,
			chaosState.dbPartitioned ? "db_partitioned" : null,
			chaosState.dropAcksRemaining > 0
				? `drop_acks=${chaosState.dropAcksRemaining}`
				: null,
			chaosState.clockSkewMs !== 0
				? `clock_skew=${chaosState.clockSkewMs}ms`
				: null,
		]
			.filter(Boolean)
			.join("  ");

		const lines = [
			`coordinator: ${config.coordinatorId}  uptime: ${formatUptime(uptimeMs)}  mode: leaderless`,
			`workers:     ${globalWorkers.length} connected  ( ${workerDetail} )`,
			`queue:       ${pendingJobs ?? 0} pending  ${dispatchedJobs ?? 0} in-flight  ${stuckLeases ?? 0} stuck>30s`,
			`leases:      ${activeLeases ?? 0} active   ${expiringLeases ?? 0} expiring<5s`,
			`last 60s:    ${submitted60} submitted  ${completed60} completed  ${failed60} failed  ${lost60} lost`,
			`chaos:       ${chaosLine || "none"}`,
		];

		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.status(200).send(`${lines.join("\n")}\n`);
	});

	return router;
}
