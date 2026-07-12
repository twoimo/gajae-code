import { describe, expect, it } from "bun:test";
import { evaluatePlanningCapability } from "../src/session/planning-capability-guard";
import { registerToolCapability, resolveToolCapability } from "../src/tools/capabilities";

const decide = (name: string, args: unknown = {}, provenance: "builtin" | "mcp" | "plugin" = "builtin") => {
	const tool = { name } as never;
	registerToolCapability(tool, provenance, name);
	return evaluatePlanningCapability({
		tool,
		args,
		capability: resolveToolCapability(tool),
		activeSkill: "ralplan",
		phase: "planning",
	});
};

describe("planning capability guard", () => {
	it("does not let MCP or plugin hints unlock planning", () => {
		expect(decide("read", {}, "mcp").allowed).toBe(false);
		expect(decide("read", {}, "plugin").allowed).toBe(false);
	});
	it("blocks unknown capabilities", () => expect(decide("unclassified").allowed).toBe(false));
	it("allows provably read-only operations", () => {
		expect(decide("read", { path: "src/a.ts" }).allowed).toBe(true);
		expect(decide("bash", { command: "git status --short" }).allowed).toBe(true);
	});
	it("blocks eval, browser run, and computer input", () => {
		expect(decide("eval", { code: "1+1" }).allowed).toBe(false);
		expect(decide("browser", { op: "run" }).allowed).toBe(false);
		expect(decide("computer", { op: "click" }).allowed).toBe(false);
	});
	it("fails closed for missing or invalid live ultragoal phases", () => {
		const tool = { name: "edit" } as never;
		registerToolCapability(tool, "builtin", "edit");
		for (const phase of [undefined, "", "not-a-real-phase"]) {
			const decision = evaluatePlanningCapability({
				tool,
				args: { path: "victim", content: "x" },
				capability: resolveToolCapability(tool),
				activeSkill: "ultragoal",
				phase,
			});
			expect(decision.allowed, String(phase)).toBe(false);
		}
	});
});
