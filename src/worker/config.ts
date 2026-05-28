function num(key: string, fallback: number): number {
	const raw = process.env[key];
	if (!raw) return fallback;
	const parsed = parseInt(raw, 10);
	if (Number.isNaN(parsed))
		throw new Error(`Env var ${key} must be an integer, got: "${raw}"`);
	return parsed;
}

export const config = {
	workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
	concurrencyLimit: num("CONCURRENCY_LIMIT", 4),
	coordinatorUrl: process.env.COORDINATOR_URL ?? "ws://localhost:8080",
	reconnectDelayMs: num("RECONNECT_DELAY_MS", 2_000),
} as const;
