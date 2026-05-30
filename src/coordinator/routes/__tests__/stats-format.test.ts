import { describe, expect, it } from "vitest";
import { formatUptime } from "../stats";

describe("formatUptime", () => {
	it("formats sub-minute durations as seconds", () => {
		expect(formatUptime(0)).toBe("0s");
		expect(formatUptime(999)).toBe("0s");
		expect(formatUptime(1_000)).toBe("1s");
		expect(formatUptime(59_999)).toBe("59s");
	});

	it("formats minute-scale durations as MmSs", () => {
		expect(formatUptime(60_000)).toBe("1m0s");
		expect(formatUptime(125_000)).toBe("2m5s");
	});

	it("formats hour-scale durations as HhMm (drops seconds)", () => {
		expect(formatUptime(3_600_000)).toBe("1h0m");
		expect(formatUptime(4 * 3_600_000 + 12 * 60_000)).toBe("4h12m"); // matches spec example
	});

	it("formats day-scale durations as DdHhMm", () => {
		expect(formatUptime(86_400_000)).toBe("1d0h0m");
		expect(formatUptime(86_400_000 + 5 * 3_600_000 + 30 * 60_000)).toBe(
			"1d5h30m",
		);
	});
});
