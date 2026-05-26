import fs from "node:fs";
import path from "node:path";
import pino from "pino";

const logsDir = path.resolve(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const isDev = process.env.NODE_ENV !== "production";

const targets: pino.TransportTargetOptions[] = [
	isDev
		? { target: "pino-pretty", options: { colorize: true }, level: "debug" }
		: { target: "pino/file", options: { destination: 1 }, level: "debug" },
	{
		target: "pino/file",
		options: { destination: path.join(logsDir, "combined.log"), append: true },
		level: "debug",
	},
	{
		target: "pino/file",
		options: { destination: path.join(logsDir, "warn.log"), append: true },
		level: "warn",
	},
	{
		target: "pino/file",
		options: { destination: path.join(logsDir, "error.log"), append: true },
		level: "error",
	},
];

export const logger = pino(
	{ level: process.env.LOG_LEVEL ?? "debug" },
	pino.transport({ targets }),
);
