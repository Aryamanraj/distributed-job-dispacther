export interface ResultWithError<T = unknown> {
	data: T | null;
	error: Error | null;
}
