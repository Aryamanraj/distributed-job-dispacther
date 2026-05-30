import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ChaosAction,
	ChaosService,
} from "../../../coordinator/services/chaos.service";

describe("ChaosService", () => {
	let svc: ChaosService;

	beforeEach(() => {
		svc = new ChaosService();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("pause_dispatch", () => {
		it("pauses dispatch for N ms and auto-clears after expiry", () => {
			expect(svc.isDispatchPaused()).toBe(false);
			svc.apply(ChaosAction.PauseDispatch, { ms: 1000 });
			expect(svc.isDispatchPaused()).toBe(true);

			vi.advanceTimersByTime(999);
			expect(svc.isDispatchPaused()).toBe(true);

			vi.advanceTimersByTime(2);
			expect(svc.isDispatchPaused()).toBe(false);
		});

		it("resume_dispatch lifts the pause immediately", () => {
			svc.apply(ChaosAction.PauseDispatch, { ms: 60_000 });
			expect(svc.isDispatchPaused()).toBe(true);
			svc.apply(ChaosAction.ResumeDispatch);
			expect(svc.isDispatchPaused()).toBe(false);
		});
	});

	describe("drop_acks", () => {
		it("consumeDropAck returns true exactly N times then false", () => {
			svc.apply(ChaosAction.DropAcks, { n: 3 });
			expect(svc.consumeDropAck()).toBe(true);
			expect(svc.consumeDropAck()).toBe(true);
			expect(svc.consumeDropAck()).toBe(true);
			expect(svc.consumeDropAck()).toBe(false);
			expect(svc.consumeDropAck()).toBe(false);
		});

		it("consumeDropAck returns false when no fault is active", () => {
			expect(svc.consumeDropAck()).toBe(false);
		});

		it("re-applying drop_acks overwrites the remaining count", () => {
			svc.apply(ChaosAction.DropAcks, { n: 2 });
			svc.consumeDropAck();
			svc.apply(ChaosAction.DropAcks, { n: 5 });
			expect(svc.getState().dropAcksRemaining).toBe(5);
		});
	});

	describe("partition_db", () => {
		it("partitions DB for N ms and auto-clears", () => {
			svc.apply(ChaosAction.PartitionDb, { ms: 500 });
			expect(svc.isDbPartitioned()).toBe(true);
			vi.advanceTimersByTime(501);
			expect(svc.isDbPartitioned()).toBe(false);
		});

		it("restore_db lifts the partition immediately", () => {
			svc.apply(ChaosAction.PartitionDb, { ms: 60_000 });
			svc.apply(ChaosAction.RestoreDb);
			expect(svc.isDbPartitioned()).toBe(false);
		});
	});

	describe("clock_skew", () => {
		it("clock_skew converts seconds to ms (positive and negative)", () => {
			svc.apply(ChaosAction.ClockSkew, { seconds: 30 });
			expect(svc.getClockSkewMs()).toBe(30_000);

			svc.apply(ChaosAction.ClockSkew, { seconds: -120 });
			expect(svc.getClockSkewMs()).toBe(-120_000);
		});

		it("now() shifts by the skew offset", () => {
			const realNow = Date.now();
			svc.apply(ChaosAction.ClockSkew, { seconds: 60 });
			expect(svc.now()).toBe(realNow + 60_000);

			svc.apply(ChaosAction.ClockSkew, { seconds: 0 });
			expect(svc.now()).toBe(realNow);
		});

		it("clock_skew survives even with the timer faults active", () => {
			svc.apply(ChaosAction.ClockSkew, { seconds: 10 });
			svc.apply(ChaosAction.PauseDispatch, { ms: 1000 });
			svc.apply(ChaosAction.DropAcks, { n: 2 });
			expect(svc.getClockSkewMs()).toBe(10_000);
		});
	});

	describe("getState", () => {
		it("reports the combined live state of all faults", () => {
			svc.apply(ChaosAction.PauseDispatch, { ms: 60_000 });
			svc.apply(ChaosAction.DropAcks, { n: 4 });
			svc.apply(ChaosAction.PartitionDb, { ms: 60_000 });
			svc.apply(ChaosAction.ClockSkew, { seconds: -5 });

			const s = svc.getState();
			expect(s.dispatchPaused).toBe(true);
			expect(s.dropAcksRemaining).toBe(4);
			expect(s.dbPartitioned).toBe(true);
			expect(s.clockSkewMs).toBe(-5_000);
		});

		it("starts in the all-clear state", () => {
			expect(svc.getState()).toEqual({
				dispatchPaused: false,
				dropAcksRemaining: 0,
				dbPartitioned: false,
				clockSkewMs: 0,
			});
		});
	});
});
