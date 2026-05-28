/**
 * Simulates job execution.
 *
 * Reads `payload.durationMs` (default 200 ms) to mimic variable-length work.
 * Returns a result envelope that echoes the payload — real implementations
 * would replace this with actual business logic.
 */
export async function executeJob(
	jobId: string,
	payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const durationMs =
		typeof payload.durationMs === "number" ? payload.durationMs : 200;

	await new Promise<void>((resolve) => setTimeout(resolve, durationMs));

	return {
		jobId,
		processedAt: new Date().toISOString(),
		echo: payload,
	};
}
