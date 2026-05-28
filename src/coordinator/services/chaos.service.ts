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
	private dispatchPaused = false;
	private dropAcksRemaining = 0;
	private dbPartitioned = false;
	private clockSkewMs = 0;

	apply(action: ChaosAction, value = 0): void {
		switch (action) {
			case ChaosAction.PauseDispatch:
				this.dispatchPaused = true;
				logger.warn("Chaos: dispatch paused");
				break;
			case ChaosAction.ResumeDispatch:
				this.dispatchPaused = false;
				logger.warn("Chaos: dispatch resumed");
				break;
			case ChaosAction.DropAcks:
				this.dropAcksRemaining = value;
				logger.warn({ count: value }, "Chaos: will drop next N acks");
				break;
			case ChaosAction.PartitionDb:
				this.dbPartitioned = true;
				logger.warn("Chaos: DB partitioned");
				break;
			case ChaosAction.RestoreDb:
				this.dbPartitioned = false;
				logger.warn("Chaos: DB partition restored");
				break;
			case ChaosAction.ClockSkew:
				this.clockSkewMs = value;
				logger.warn({ skewMs: value }, "Chaos: clock skew set");
				break;
		}
	}

	isDispatchPaused(): boolean {
		return this.dispatchPaused;
	}

	isDbPartitioned(): boolean {
		return this.dbPartitioned;
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
			dispatchPaused: this.dispatchPaused,
			dropAcksRemaining: this.dropAcksRemaining,
			dbPartitioned: this.dbPartitioned,
			clockSkewMs: this.clockSkewMs,
		};
	}
}
