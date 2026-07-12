import { describe, expect, it } from "bun:test";
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "../src/tools";
import {
	BUILTIN_TOOL_CAPABILITIES,
	classifyToolOperation,
	registerToolCapability,
	resolveToolCapability,
} from "../src/tools/capabilities";

describe("tool capability registry", () => {
	it("describes every registered built-in and hidden tool", () => {
		for (const name of [...Object.keys(BUILTIN_TOOLS), ...Object.keys(HIDDEN_TOOLS)]) {
			expect(BUILTIN_TOOL_CAPABILITIES[name], name).toBeDefined();
		}
	});

	it("defaults unclassified and untrusted tools to unknown", () => {
		for (const provenance of ["builtin", "discovered", "mcp", "plugin"] as const) {
			const tool = { name: "third_party" } as never;
			registerToolCapability(tool, provenance, "third_party");
			const capability = resolveToolCapability(tool);
			expect(capability.filesystem).toBe("unknown");
			expect(capability.external).toBe("unknown");
			expect(capability.execution).toBe("unknown");
		}
	});

	it("binds provenance to tool identity instead of a colliding builtin name", () => {
		const extensionTool = { name: "read" } as never;
		registerToolCapability(extensionTool, "plugin");
		const capability = resolveToolCapability(extensionTool);
		expect(capability.provenance).toBe("plugin");
		expect(capability.filesystem).toBe("unknown");
	});

	it("classifies supported operations totally and fails unmatched operations closed", () => {
		const classified = (name: string, args: unknown) => {
			const tool = { name } as never;
			registerToolCapability(tool, "builtin", name);
			return classifyToolOperation(resolveToolCapability(tool), args);
		};
		for (const command of ["git status --short", "git log -1", "ls -la", "cat package.json", "rg pattern src"]) {
			expect(classified("bash", { command }).filesystem, command).toBe("read");
		}
		for (const command of [
			"curl -X POST https://example.com",
			"git commit -m x",
			"bun test",
			"npm run build",
			"env rm victim",
			"find x -delete",
			"find . -exec rm {} +",
			"rg --pre rm pattern",
			"rg --pre-glob '*.ts' pattern",
			"rg --hostname-bin rm pattern",
			"rg --hostname-bin=rm pattern",
			"rg --pre=rm pattern",
			"rg --search-zip pattern",
			"rg --search-zip=always pattern",
			"rg -z pattern",
			"rg -iz pattern",
			"rg '-z' pattern",
			'rg "-z" pattern',
			"rg '--pre=rm' pattern",
			"rg --'pre'=rm pattern",
			"rg '--pre'=rm pattern",
			"rg --pre'='rm pattern",
			"'rg' --'pre'=rm pattern",
			"r'g' -z pattern",
			"rg -'z' pattern",
			"rg \\-z pattern",
			"git diff --output=target",
			"git diff --output target",
			"git log --output=target",
			"git diff --ext-diff",
			"git log --format=%H --output=target",
		]) {
			expect(classified("bash", { command }).execution, command).toBe("unknown");
		}
		expect(classified("browser", { action: "open", app: { path: "/bin/rm", args: ["victim"] } }).execution).toBe(
			"process",
		);
		expect(classified("browser", { action: "act" }).interactive).toBe(true);
		expect(classified("browser", { action: "unknown" }).external).toBe("unknown");
		expect(classified("resolve", { action: "apply" }).execution).toBe("unknown");
		expect(classified("resolve", { action: "discard" }).execution).toBe("none");
		expect(classified("github", { op: "repo_view" }).external).toBe("read");
		expect(classified("cron", { op: "list" }).external).toBe("read");
		expect(classified("job", { list: true }).external).toBe("read");
		expect(classified("job", { tail: ["1"] }).external).toBe("read");
	});

	it("trusted operation classifiers cannot downgrade static metadata", () => {
		const capability = classifyToolOperation(
			{
				provenance: "builtin",
				filesystem: "write",
				external: "read",
				execution: "process",
				destructive: true,
				interactive: true,
				classifyOperation: () => ({
					filesystem: "none",
					external: "none",
					execution: "none",
					destructive: false,
					interactive: false,
				}),
			},
			{},
		);
		expect(capability).toMatchObject({
			filesystem: "write",
			external: "read",
			execution: "process",
			destructive: true,
			interactive: true,
		});
	});
});
