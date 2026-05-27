function num(key: string, fallback: number): number {
	const raw = process.env[key];
	if (!raw) return fallback;
	const parsed = parseInt(raw, 10);
	if (Number.isNaN(parsed))
		throw new Error(`Env var ${key} must be an integer, got: "${raw}"`);
	return parsed;
}

export const config = {
	nodeEnv: process.env.NODE_ENV ?? "development",
	logLevel: process.env.LOG_LEVEL ?? "debug",

	port: num("PORT", 8080),
	coordinatorId: process.env.COORDINATOR_ID ?? "1",

	db: {
		host: process.env.DB_HOST ?? "localhost",
		port: num("DB_PORT", 5432),
		name: process.env.DB_NAME ?? "dispatcher",
		user: process.env.DB_USER ?? "postgres",
		pass: process.env.DB_PASS ?? "postgres",
	},
} as const;
