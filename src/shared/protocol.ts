// Messages sent from coordinator → worker
export type CoordToWorkerMsg =
	| {
			type: "job.dispatch";
			jobId: string;
			token: string;
			payload: Record<string, unknown>;
			timeoutMs: number;
	  }
	| { type: "job.ack"; jobId: string }
	| { type: "control.set_concurrency"; limit: number }
	| { type: "ping" };

// Messages sent from worker → coordinator
export type WorkerToCoordMsg =
	| { type: "worker.hello"; workerId: string; concurrencyLimit: number }
	| {
			type: "job.result";
			jobId: string;
			token: string;
			result: Record<string, unknown>;
	  }
	| { type: "job.failed"; jobId: string; token: string; error: string }
	| { type: "pong" };
