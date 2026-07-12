import { describe, expect, it } from "bun:test";
import { ToolPolicyCoordinator } from "../../../src/session/coordinators/tool-policy-coordinator";

describe("ToolPolicyCoordinator", () => {
	it("caches per policy version and refreshes after invalidation", () => {
		let composed = 0;
		const tool = { name: "test" } as never;
		const coordinator = new ToolPolicyCoordinator(
			() => "policy",
			value => ({ ...value, composed: ++composed }) as never,
		);

		const initial = coordinator.prepareTool(tool);
		expect(initial).toBe(coordinator.prepareTool(tool));
		expect(composed).toBe(1);
		coordinator.invalidate();
		expect(coordinator.prepareTool(tool)).not.toBe(initial);
		expect(composed).toBe(2);
	});
});
