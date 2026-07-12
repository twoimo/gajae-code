import { describe, expect, it } from "bun:test";
import {
	BASELINE_TOLERANCE,
	budgetFromBaseline,
	INTERACTIVE_FIRST_FRAME_MARKER,
	median,
	MODELS_PARSE_MARKER,
	summarizeInteractiveSamples,
	WORKSPACE_SCAN_COMPLETED_MARKER,
	WORKSPACE_SCAN_MARKER,
} from "./measure-first-frame";

describe("measure-first-frame", () => {
	it("calculates stable medians for odd and even sample counts", () => {
		expect(median([9, 1, 5])).toBe(5);
		expect(median([10, 2, 8, 4])).toBe(6);
	});

	it("uses distinct hard-assertion markers", () => {
		expect(MODELS_PARSE_MARKER).toBe("startup:models-catalog-parsed");
		expect(WORKSPACE_SCAN_MARKER).toBe("startup:workspace-scan-");
	});

	it("derives budgets from recorded baselines with 50% tolerance", () => {
		expect(BASELINE_TOLERANCE).toBe(0.5);
		expect(budgetFromBaseline(100)).toBe(150);
	});

	it("uses distinct interactive milestone markers", () => {
		expect(INTERACTIVE_FIRST_FRAME_MARKER).toBe("startup:interactive-first-frame");
		expect(WORKSPACE_SCAN_COMPLETED_MARKER).toBe("startup:workspace-scan-completed");
	});

	it("rejects a bad trace even when another sample has correct marker order", () => {
		const goodTrace = [
			"startup:workspace-scan-started",
			INTERACTIVE_FIRST_FRAME_MARKER,
			WORKSPACE_SCAN_COMPLETED_MARKER,
		].join("\n");
		const badTrace = [
			"startup:workspace-scan-started",
			WORKSPACE_SCAN_COMPLETED_MARKER,
			INTERACTIVE_FIRST_FRAME_MARKER,
		].join("\n");

		expect(() =>
			summarizeInteractiveSamples([
				{ durationMs: 10, trace: goodTrace },
				{ durationMs: 20, trace: badTrace },
			]),
		).toThrow("Interactive sample 2 completed workspace scanning before its first frame");
	});
});
