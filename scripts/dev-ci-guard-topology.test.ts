import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

// The dev-ci workflow wires the Telegram daemon generation guard into the sharded
// aggregate. These assertions pin the exact-revision + fail-closed topology so a
// future edit cannot (a) resurrect the removed Windows notification atomicity
// gate, (b) let a manual workflow_dispatch validate a different commit in the
// guard than the planner/shards test, or (c) drop the guard from the required
// aggregate.
async function workflow(): Promise<Record<string, any>> {
	return parse(await Bun.file(".github/workflows/dev-ci.yml").text());
}

describe("dev-ci Telegram daemon generation guard topology", () => {
	test("does not resurrect the removed Windows notification atomicity gate", async () => {
		const raw = await Bun.file(".github/workflows/dev-ci.yml").text();
		expect(raw).not.toMatch(/notification-atomic-windows/);
		expect(raw).not.toMatch(/windows_atomic/);
		expect(raw).not.toMatch(/atomicity/i);
		const d = await workflow();
		expect(Object.keys(d.jobs)).not.toContain("notification-atomic-windows");
		expect(d.jobs.affected.needs).not.toContain("notification-atomic-windows");
	});

	test("keeps the guard in the required aggregate with a fail-closed check", async () => {
		const d = await workflow();
		expect(d.jobs.affected.needs).toContain("telegram-daemon-generation");
		const aggregate = (d.jobs.affected.steps as any[]).map(s => s.run ?? "").join("\n");
		expect(aggregate).toContain("telegram_guard='${{ needs.telegram-daemon-generation.result }}'");
		expect(aggregate).toMatch(/case "\$telegram_guard" in success\|skipped\)/);
	});

	test("validates the same requested commit in the guard, planner, and shards (no arbitrary dispatch head)", async () => {
		const d = await workflow();
		// The arbitrary dispatch HEAD inputs are removed: a manual run can only pin the
		// diff base, never a head that diverges from what the planner/shards test.
		const dispatchInputs = Object.keys(d.on.workflow_dispatch.inputs);
		expect(dispatchInputs).toEqual(["base_ref", "base_sha", "base_repository"]);
		expect(dispatchInputs).not.toContain("head_sha");
		expect(dispatchInputs).not.toContain("head_ref");
		expect(dispatchInputs).not.toContain("head_repository");

		const guard = d.jobs["telegram-daemon-generation"];
		// The guard head SHA never reads inputs.head_sha; for push/dispatch it is
		// github.sha — exactly the source the planner checks out.
		expect(guard.env.GITHUB_HEAD_SHA).not.toContain("inputs.head_sha");
		expect(guard.env.GITHUB_HEAD_SHA).toContain("github.sha");
		expect(guard.env.HEAD_REF).not.toContain("inputs.head_ref");
		expect(guard.env.HEAD_REPOSITORY).not.toContain("inputs.head_repository");

		const checkoutRef = (steps: any[]): string =>
			steps.find(s => typeof s.uses === "string" && s.uses.includes("actions/checkout")).with.ref;
		const guardRef = checkoutRef(guard.steps);
		const planRef = checkoutRef(d.jobs["affected-plan"].steps);
		// The guard checks out the exact same source expression as the planner, so a
		// push/workflow_dispatch validates github.sha in both, and a PR validates the PR
		// head in both — never divergent revisions.
		expect(guardRef).toBe("${{ github.event.pull_request.head.sha || github.sha }}");
		expect(guardRef).toBe(planRef);
		// The guard's authority head SHA tracks that same source.
		expect(guard.env.GITHUB_HEAD_SHA).toContain("github.event.pull_request.head.sha");
		expect(guard.env.GITHUB_HEAD_SHA).toContain("github.sha");
	});
});
