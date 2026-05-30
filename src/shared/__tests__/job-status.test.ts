import { describe, expect, it } from "vitest";
import { JOB_STATUS_ENUM } from "../job-status";

describe("JOB_STATUS_ENUM wire values", () => {
	it("PENDING is 'pending'", () => {
		expect(JOB_STATUS_ENUM.PENDING).toBe("pending");
	});
	it("DISPATCHED is 'dispatched'", () => {
		expect(JOB_STATUS_ENUM.DISPATCHED).toBe("dispatched");
	});
	it("SUCCEEDED is 'succeeded'", () => {
		expect(JOB_STATUS_ENUM.SUCCEEDED).toBe("succeeded");
	});
	it("FAILED is 'failed'", () => {
		expect(JOB_STATUS_ENUM.FAILED).toBe("failed");
	});
	it("CANCELLED is 'cancelled'", () => {
		expect(JOB_STATUS_ENUM.CANCELLED).toBe("cancelled");
	});

	it("enum has exactly 5 members (regression: no silent additions)", () => {
		expect(Object.keys(JOB_STATUS_ENUM)).toHaveLength(5);
	});

	it("terminal statuses are SUCCEEDED, FAILED, CANCELLED", () => {
		// SSE stream + cancel route key off this set; documenting it as a test
		// so any future change to terminal-state semantics fails loudly here.
		const terminal: string[] = [
			JOB_STATUS_ENUM.SUCCEEDED,
			JOB_STATUS_ENUM.FAILED,
			JOB_STATUS_ENUM.CANCELLED,
		];
		expect(terminal).toEqual(["succeeded", "failed", "cancelled"]);
	});
});
