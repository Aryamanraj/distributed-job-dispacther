export enum JOB_STATUS_ENUM {
	PENDING = "pending",
	DISPATCHED = "dispatched",
	COMPLETED = "completed",
	FAILED = "failed",
	CANCELLED = "cancelled",
}

export type JobStatus = `${JOB_STATUS_ENUM}`;
