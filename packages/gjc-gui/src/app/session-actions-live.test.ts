import { describe, expect, it } from "bun:test";
import { flattenSessionTree, provenanceLabel, validateRenameTitle } from "./session-actions-logic";

describe("live session action logic", () => {

	it("flattens tree with monospace-ready indentation and active bullet", () => {
		const flat = flattenSessionTree([
			{ id: "root", type: "message", preview: "root", active: true, children: [
				{ id: "child", type: "message", preview: "child", active: true, children: [] },
			] },
		]);
		expect(flat.map(n => [n.depth, n.marker, n.text])).toEqual([
			[0, "•", "• root"],
			[1, "•", "  • child"],
		]);
	});

	it("validates rename titles after trim", () => {
		expect(validateRenameTitle("  Project title  ")).toBeNull();
		expect(validateRenameTitle("   ")).toBe("Title is required.");
		expect(validateRenameTitle("x".repeat(201))).toBe("Title must be 200 characters or fewer.");
	});

	it("formats export provenance display", () => {
		expect(provenanceLabel({ exportedAt: "2026-07-06T00:00:00.000Z", redacted: true, tool: "gjc-app-server" })).toBe("gjc-app-server · redacted · 2026-07-06T00:00:00.000Z");
	});
});
