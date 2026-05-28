export enum MsgType {
	// Coordinator → Worker
	JobDispatch = "job.dispatch",
	JobAck = "job.ack",
	ControlSetConcurrency = "control.set_concurrency",
	Ping = "ping",
	// Worker → Coordinator
	WorkerHello = "worker.hello",
	JobResult = "job.result",
	JobFailed = "job.failed",
	Pong = "pong",
}

// Messages sent from coordinator → worker
export type CoordToWorkerMsg =
	| {
			type: MsgType.JobDispatch;
			jobId: string;
			token: string;
			payload: Record<string, unknown>;
			timeoutMs: number;
	  }
	| { type: MsgType.JobAck; jobId: string }
	| { type: MsgType.ControlSetConcurrency; limit: number }
	| { type: MsgType.Ping };

// Messages sent from worker → coordinator
export type WorkerToCoordMsg =
	| { type: MsgType.WorkerHello; workerId: string; concurrencyLimit: number }
	| {
			type: MsgType.JobResult;
			jobId: string;
			token: string;
			result: Record<string, unknown>;
	  }
	| { type: MsgType.JobFailed; jobId: string; token: string; error: string }
	| { type: MsgType.Pong };
