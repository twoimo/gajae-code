import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getSplitAddonFilenames, loadSplitNative } from "../native/loader-state.js";

describe("N1 capability topology", () => {
	it("uses variant-aware split artifact names", () => {
		expect(getSplitAddonFilenames({ tag: "darwin-arm64", arch: "arm64", variant: null, capability: "core" })).toEqual(
			["pi_natives_core.darwin-arm64.node"],
		);
		expect(getSplitAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "modern", capability: "shell" })).toEqual(
			["pi_natives_shell.linux-x64-modern.node", "pi_natives_shell.linux-x64-baseline.node"],
		);
	});

	it("loads core eagerly and shell only on first shell export access", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-n1-"));
		try {
			const corePath = path.join(directory, "pi_natives_core.darwin-arm64.node");
			const shellPath = path.join(directory, "pi_natives_shell.darwin-arm64.node");
			await Promise.all([fs.writeFile(corePath, ""), fs.writeFile(shellPath, "")]);
			const loaded: string[] = [];
			const bindings = loadSplitNative({
				require_: ((candidate: string) => {
					loaded.push(candidate);
					return candidate === corePath ? { visibleWidth: () => 4 } : { executeShell: () => "shell" };
				}) as NodeRequire,
				directories: [directory],
				tag: "darwin-arm64",
				arch: "arm64",
				variant: null,
			});
			expect(loaded).toEqual([corePath]);
			expect((bindings?.visibleWidth as () => number)()).toBe(4);
			expect(loaded).toEqual([corePath]);
			expect((bindings?.executeShell as () => string)()).toBe("shell");
			expect(loaded).toEqual([corePath, shellPath]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("falls back to one validated monolith when split core is corrupt", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-n1-corrupt-"));
		try {
			const corePath = path.join(directory, "pi_natives_core.darwin-arm64.node");
			await fs.writeFile(corePath, "");
			const loaded: string[] = [];
			const fallback = { visibleWidth: () => 9 };
			const bindings = loadSplitNative({
				require_: ((candidate: string) => {
					loaded.push(candidate);
					throw new Error("corrupt core");
				}) as unknown as NodeRequire,
				directories: [directory],
				tag: "darwin-arm64",
				arch: "arm64",
				variant: null,
				loadFallback: () => fallback,
			});
			expect(bindings).toBeNull();
			expect(loaded).toEqual([corePath]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects version-skewed shell and switches atomically to monolith", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-n1-skew-"));
		try {
			const corePath = path.join(directory, "pi_natives_core.darwin-arm64.node");
			const shellPath = path.join(directory, "pi_natives_shell.darwin-arm64.node");
			await Promise.all([fs.writeFile(corePath, ""), fs.writeFile(shellPath, "")]);
			const fallback = { visibleWidth: () => 10, executeShell: () => "monolith" };
			const bindings = loadSplitNative({
				require_: ((candidate: string) =>
					candidate === corePath
						? { generation: "current", visibleWidth: () => 4 }
						: { generation: "stale", executeShell: () => "split" }) as NodeRequire,
				directories: [directory],
				tag: "darwin-arm64",
				arch: "arm64",
				variant: null,
				validate: bindings => {
					if ((bindings as { generation: string }).generation !== "current") throw new Error("version skew");
				},
				loadFallback: () => fallback,
			});
			expect((bindings?.executeShell as () => string)()).toBe("monolith");
			expect((bindings?.visibleWidth as () => number)()).toBe(10);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("reports both missing optional shell and failed monolith fallback", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-n1-missing-shell-"));
		try {
			const corePath = path.join(directory, "pi_natives_core.darwin-arm64.node");
			await fs.writeFile(corePath, "");
			const bindings = loadSplitNative({
				require_: (() => ({ visibleWidth: () => 4 })) as unknown as NodeRequire,
				directories: [directory],
				tag: "darwin-arm64",
				arch: "arm64",
				variant: null,
				loadFallback: () => {
					throw new Error("No monolithic native addon candidate could be loaded.");
				},
			});
			expect(() => (bindings?.executeShell as () => string)()).toThrow(
				/Optional split shell addon is unavailable.*No split shell addon candidate.*monolithic fallback also failed.*No monolithic native addon candidate/,
			);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
