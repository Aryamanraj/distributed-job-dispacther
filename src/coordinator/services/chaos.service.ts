import { logger } from "../../util/logger";

export enum ChaosAction {
	PauseDispatch = "pause_dispatch",
	ResumeDispatch = "resume_dispatch",
	DropAcks = "drop_acks",
	PartitionDb = "partition_db",
	RestoreDb = "restore_db",
	ClockSkew = "clock_skew",
}

export interface ChaosState {
	dispatchPaused: boolean;
	dropAcksRemaining: number;
	dbPartitioned: boolean;
	clockSkewMs: number;
}

export class ChaosService {
	// Timestamps (ms since epoch) until which faults are active. 0 = inactive.
	private dispatchPausedUntil = 0;
	private dropAcksRemaining = 0;
	private dbPartitionedUntil = 0;
	private clockSkewMs = 0;

	apply(action: ChaosAction, params: Record<string, number> = {}): void {
		switch (action) {
			case ChaosAction.PauseDispatch:
				this.dispatchPausedUntil = Date.now() + (params.ms ?? 0);
				logger.warn({ ms: params.ms }, "Chaos: dispatch paused");
				break;
			case ChaosAction.ResumeDispatch:
				this.dispatchPausedUntil = 0;
				logger.warn("Chaos: dispatch resumed manually");
				break;
			case ChaosAction.DropAcks:
				this.dropAcksRemaining = params.count ?? 0;
				logger.warn({ count: params.count }, "Chaos: will drop next N acks");
				break;
			case ChaosAction.PartitionDb:
				this.dbPartitionedUntil = Date.now() + (params.ms ?? 0);
				logger.warn({ ms: params.ms }, "Chaos: DB partitioned");
				break;
			case ChaosAction.RestoreDb:
				this.dbPartitionedUntil = 0;
				logger.warn("Chaos: DB partition restored manually");
				break;
			case ChaosAction.ClockSkew:
				this.clockSkewMs = (params.offsetSeconds ?? 0) * 1000;
				logger.warn(
					{ offsetSeconds: params.offsetSeconds },
					"Chaos: clock skew set",
				);
				break;
		}
	}

	isDispatchPaused(): boolean {
		return Date.now() < this.dispatchPausedUntil;
	}

	isDbPartitioned(): boolean {
		return Date.now() < this.dbPartitionedUntil;
	}

	getClockSkewMs(): number {
		return this.clockSkewMs;
	}

	/**
	 * Returns true if this ack should be dropped (and decrements the counter).
	 * Returns false if the ack should be sent normally.
	 */
	consumeDropAck(): boolean {
		if (this.dropAcksRemaining <= 0) return false;
		this.dropAcksRemaining--;
		logger.warn(
			{ remaining: this.dropAcksRemaining },
			"Chaos: dropping job.ack",
		);
		return true;
	}

	getState(): ChaosState {
		return {
			dispatchPaused: this.isDispatchPaused(),
			dropAcksRemaining: this.dropAcksRemaining,
			dbPartitioned: this.isDbPartitioned(),
			clockSkewMs: this.clockSkewMs,
		};
	}
}
