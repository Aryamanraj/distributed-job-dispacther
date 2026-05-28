import { Router } from "express";
import { LessThan, MoreThan } from "typeorm";
import { JOB_STATUS_ENUM } from "../../shared/job-status";
import { config } from "../config";
import { AppDataSource } from "../db/data-source";
import { Job } from "../db/entities/job.entity";
import { JobEvent } from "../db/entities/job-event.entity";
import { Lease } from "../db/entities/lease.entity";
import type { WorkerHubService } from "../services/worker-hub.service";

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
	hub: WorkerHubService,
	startedAt: Date,
): Router {
	const router = Router();

	router.get("/", async (_req, res) => {
		const now = new Date();
		const db = AppDataSource;

		const [
			pending,
			dispatched,
			activeLeases,
			stuckLeases,
			expiringLeases,
			recentEvents,
		] = await Promise.all([
			db
				.getRepository(Job)
				.count({ where: { Status: JOB_STATUS_ENUM.PENDING } }),
			db
				.getRepository(Job)
				.count({ where: { Status: JOB_STATUS_ENUM.DISPATCHED } }),
			// All active leases
			db.getRepository(Lease).count(),
			// stuck>30s: lease issued >30s ago = ExpiresAt < now + (TTL - 30s)
			db.getRepository(Lease).count({
				where: {
					ExpiresAt: LessThan(new Date(now.getTime() + LEASE_TTL_MS - 30_000)),
				},
			}),
			// expiring<5s: ExpiresAt within next 5 seconds
			db.getRepository(Lease).count({
				where: { ExpiresAt: LessThan(new Date(now.getTime() + 5_000)) },
			}),
			// last 60s events from JobEvents table
			db.getRepository(JobEvent).find({
				where: { Ts: MoreThan(new Date(now.getTime() - 60_000)) },
				select: { Event: true },
			}),
		]);

		const submitted60 = recentEvents.filter(
			(e) => e.Event === "submitted",
		).length;
		const completed60 = recentEvents.filter(
			(e) => e.Event === "completed",
		).length;
		const failed60 = recentEvents.filter((e) => e.Event === "failed").length;
		const lost60 = Math.max(0, submitted60 - completed60 - failed60);

		const workers = hub.getWorkerStats();
		const workerDetail =
			workers.length === 0
				? "none"
				: workers
						.map((w) => `${w.workerId}:${w.inFlight}/${w.concurrencyLimit}`)
						.join("  ");

		const uptimeMs = now.getTime() - startedAt.getTime();

		const lines = [
			`coordinator: ${config.coordinatorId}  uptime: ${formatUptime(uptimeMs)}`,
			`workers:     ${workers.length} connected  ( ${workerDetail} )`,
			`queue:       ${pending} pending  ${dispatched} in-flight  ${stuckLeases} stuck>30s`,
			`leases:      ${activeLeases} active   ${expiringLeases} expiring<5s`,
			`last 60s:    ${submitted60} submitted  ${completed60} completed  ${failed60} failed  ${lost60} lost`,
		];

		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.status(200).send(`${lines.join("\n")}\n`);
	});

	return router;
}
