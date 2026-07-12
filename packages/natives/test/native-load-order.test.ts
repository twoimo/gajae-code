import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const localId = `${process.platform}-${process.arch}`;
const suffix = process.arch === "x64" ? "-baseline" : "";
const coreName = `pi_natives_core.${localId}${suffix}.node`;
const shellName = `pi_natives_shell.${localId}${suffix}.node`;
const monolithName = `pi_natives.${localId}${suffix}.node`;
async function run(source: string, topology = "N1") {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-native-load-"));
	const report = path.join(directory, "loads.jsonl");
	try {
		const proc = Bun.spawn([process.execPath, "-e", source], {
			cwd: path.join(import.meta.dir, "../../.."),
			env: { ...process.env, GJC_NATIVE_TOPOLOGY: topology, GJC_NATIVE_LOADER_REPORT: report },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		expect(exitCode, stderr).toBe(0);
		return (await fs.readFile(report, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line).path as string);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

describe("native public entrypoint load order", () => {
	it("imports core without loading shell or monolith", async () => {
		const loaded = await run('await import("./packages/natives/native/index.js")');
		expect(loaded.map(file => path.basename(file))).toEqual([coreName]);
	});

	it("loads shell on first shell property use", async () => {
		const loaded = await run(
			'const natives = await import("./packages/natives/native/index.js"); void natives.Shell.fromPid',
		);
		expect(loaded.map(file => path.basename(file))).toEqual([coreName, shellName]);
	});

	it("loads one monolith in forced fallback mode", async () => {
		const loaded = await run('await import("./packages/natives/native/index.js")', "monolith");
		expect(loaded).toHaveLength(1);
		expect(path.basename(loaded[0])).toBe(monolithName);
	});
});
