export interface StatsDto {
	workers_connected: number;
	workers_busy: number;
	jobs_pending: number;
	jobs_dispatched: number;
	jobs_completed: number;
	jobs_failed: number;
	jobs_cancelled: number;
}
