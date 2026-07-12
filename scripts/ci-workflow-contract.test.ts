import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { releasePlatforms } from "./release-manifest";

type WorkflowStep = {
	name?: string;
	uses?: string;
	with?: Record<string, unknown>;
	run?: string;
};

type WorkflowMatrixEntry = { os?: string; platform?: string };
type WorkflowJob = {
	steps?: WorkflowStep[];
	strategy?: { matrix?: { include?: WorkflowMatrixEntry[] } };
	"runs-on"?: string;
	if?: string;
};
type Workflow = { jobs?: Record<string, WorkflowJob> };

const workflowPath = path.join(import.meta.dir, "../.github/workflows/ci.yml");
const workflowSource = await Bun.file(workflowPath).text();
const workflow = Bun.YAML.parse(workflowSource) as Workflow;

const retainedRssWorkflowPath = path.join(import.meta.dir, "../.github/workflows/session-storage-retained-rss.yml");
const retainedRssWorkflowSource = await Bun.file(retainedRssWorkflowPath).text();
const retainedRssWorkflow = Bun.YAML.parse(retainedRssWorkflowSource) as Workflow;

function jobSteps(name: string): WorkflowStep[] {
	return workflow.jobs?.[name]?.steps ?? [];
}

describe("CI workflow contract", () => {
	test("release-npm downloads exactly the manifest-approved native artifacts", () => {
		const downloads = jobSteps("release-npm").filter(step => step.uses?.includes("actions/download-artifact"));
		const artifactNames = downloads.map(step => step.with?.name).filter((name): name is string => typeof name === "string");
		const hashExpression = "${{ needs.rust-hash.outputs.hash }}";
		const expected = releasePlatforms.map(target => {
			const variant = target.variant ? `-${target.variant}` : "";
			return `pi-natives-${target.platform}-${target.arch}${variant}-h${hashExpression}`;
		});

		expect(artifactNames).toEqual(expected);
		expect(downloads.every(step => step.with?.pattern === undefined)).toBe(true);
		expect(artifactNames.some(name => name.includes("linux-x64-modern"))).toBe(false);
	});

	test("the release footprint gate cannot download preliminary reports", () => {
		const downloads = jobSteps("footprint_release_gate").filter(step => step.uses?.includes("actions/download-artifact"));
		expect(downloads).toHaveLength(1);
		expect(downloads[0].with?.pattern).toBe("arch-review-footprint-release-*");
		expect(String(downloads[0].with?.pattern)).not.toMatch("arch-review-footprint-N1-");

		const finalUploads = jobSteps("release_binary").filter(step => step.name === "Upload final footprint report");
		expect(finalUploads[0]?.with?.name).toBe("arch-review-footprint-release-${{ matrix.target_id }}");
	});
	test("session storage crash matrix covers each supported desktop platform", () => {
		const crashJob = workflow.jobs?.session_storage_crash;
		expect(crashJob?.strategy?.matrix?.include?.map(({ os, platform }) => ({ os, platform }))).toEqual([
			{ os: "ubuntu-latest", platform: "linux" },
			{ os: "macos-latest", platform: "darwin" },
			{ os: "windows-latest", platform: "win32" },
		]);

		const testStep = jobSteps("session_storage_crash").find(step => step.name === "Run session storage crash and format tests");
		expect(testStep?.run).toBe(
			"bun test packages/coding-agent/test/session-storage-crash.test.ts packages/coding-agent/test/session-manager-storage-v2.test.ts packages/coding-agent/test/session-storage-format.test.ts packages/coding-agent/test/session-storage-recovery.test.ts packages/coding-agent/test/session-storage-gc.test.ts packages/natives/test/durable-fs.test.ts",
		);
		expect(jobSteps("session_storage_crash").find(step => step.name === "Check fast session memory budget")?.run).toBe(
			"bun scripts/measure-session-memory.ts --fast --check",
		);
		const memoryUpload = jobSteps("session_storage_crash").find(step => step.name === "Upload session memory report");
		expect(memoryUpload?.with?.path).toBe("artifacts/session-memory-*.json");
	});

	test("TUI retention gates Darwin arm64 and captures an unmeasured Linux x64 baseline", () => {
		const retentionJob = workflow.jobs?.tui_retention;
		expect(retentionJob?.strategy?.matrix?.include?.map(({ os, platform }) => ({ os, platform }))).toEqual([
			{ os: "macos-14", platform: "darwin" },
			{ os: "ubuntu-22.04", platform: "linux" },
		]);
		expect(workflowSource).toContain("Linux x64 intentionally has no\n         # fabricated baseline");
		expect(jobSteps("tui_retention").find(step => step.name === "Check fast TUI retention budget")?.run).toBe(
			"bun scripts/measure-tui-retention.ts --fast --check",
		);
		expect(jobSteps("tui_retention").find(step => step.name === "Upload TUI retention report")?.with?.path).toBe(
			"artifacts/tui-retention-${{ matrix.platform }}-${{ matrix.arch }}.json",
		);
	});


	test("retained RSS slope runs only on the hourly schedule or manual dispatch", () => {
		expect(retainedRssWorkflowSource).toContain('cron: "0 * * * *"');
		expect(retainedRssWorkflowSource).toContain("workflow_dispatch:");
		expect(retainedRssWorkflowSource).not.toContain("pull_request:");
		expect(retainedRssWorkflowSource).not.toContain("push:");

		const retainedRssJob = retainedRssWorkflow.jobs?.retained_rss;
		expect(retainedRssJob?.["runs-on"]).toBe("ubuntu-latest");
		expect(retainedRssJob?.if).toBe("${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}");
		expect(retainedRssJob?.steps?.find(step => step.name === "Check one-hour retained RSS slope")?.run).toBe(
			"bun scripts/measure-retained-rss-slope.ts --check",
		);
		expect(retainedRssJob?.steps?.find(step => step.name === "Upload retained RSS report")?.with?.path).toBe(
			"artifacts/retained-rss-slope-*.json",
		);
	});
});
