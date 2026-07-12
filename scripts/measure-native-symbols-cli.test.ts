import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const scriptPath = path.join(repoRoot, "scripts/measure-native-symbols.ts");
const target = `${process.platform}-${process.arch}`;

async function fixture(): Promise<{ directory: string; tools: string; baseline: string; candidate: string; output: string }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "native-symbol-cli-"));
	const tools = path.join(directory, "tools");
	await fs.mkdir(tools);
	const baseline = path.join(directory, "baseline.js");
	const candidate = path.join(directory, "candidate.js");
	const source = "module.exports = { nativePanicUnwindProbe: () => true, nativeDebugSidecarBacktraceProbe: () => 'native_debug_sidecar_backtrace_probe' };\n";
	await Promise.all([fs.writeFile(baseline, source), fs.writeFile(candidate, source)]);
	await fs.writeFile(path.join(tools, "nm"), "#!/bin/sh\ncase \"$*\" in *candidate*) echo napi_candidate ;; *) echo napi_baseline ;; esac\n");
	const buildIdTool = process.platform === "darwin" ? "dwarfdump" : process.platform === "linux" ? "readelf" : "dumpbin";
	const buildIdOutput = process.platform === "darwin" ? "UUID: 11111111-1111-1111-1111-111111111111\n" : process.platform === "linux" ? "Build ID: 1111111111111111111111111111111111111111\n" : "Debug Directories GUID 11111111-1111-1111-1111-111111111111\n";
	await fs.writeFile(path.join(tools, buildIdTool), `#!/bin/sh\nprintf '${buildIdOutput}'\n`);
	await Promise.all([fs.chmod(path.join(tools, "nm"), 0o755), fs.chmod(path.join(tools, buildIdTool), 0o755)]);
	return { directory, tools, baseline, candidate, output: path.join(directory, "report.json") };
}

async function measure(options: { baseline: string; candidate: string; output: string; profile?: string; path?: string }): Promise<{ exitCode: number; stderr: string }> {
	const proc = Bun.spawn([process.execPath, scriptPath, "--target", target, "--baseline-addon", options.baseline, "--candidate-addon", options.candidate, "--profile", options.profile ?? "dist-symbols", "--output", options.output], {
		cwd: repoRoot,
		env: { ...process.env, PATH: options.path ?? process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	return { exitCode, stderr };
}

describe("native symbol measurement CLI exit classification", () => {
	test("writes a completed compatibility rejection and exits zero after passing probes", async () => {
		const value = await fixture();
		try {
			const result = await measure({ ...value, path: `${value.tools}:${process.env.PATH}` });
			expect(result.exitCode).toBe(0);
			const report = await Bun.file(value.output).json();
			expect(report.status).toBe("failed");
			expect(report.unwind).toBe("passed");
			expect(report.debugSidecarBacktrace).toBe("passed");
			expect(report.reason).toContain("unexpected export: napi_candidate");
		} finally { await fs.rm(value.directory, { recursive: true, force: true }); }
	});

	test("treats missing input, malformed profile, absent provenance, and missing nm as fatal", async () => {
		const value = await fixture();
		try {
			expect((await measure({ ...value, candidate: path.join(value.directory, "missing.node"), path: `${value.tools}:${process.env.PATH}` })).exitCode).not.toBe(0);
			expect((await measure({ ...value, profile: "dist", path: `${value.tools}:${process.env.PATH}` })).exitCode).not.toBe(0);
			expect((await measure({ ...value, path: value.tools })).exitCode).not.toBe(0);
			const git = path.join(value.tools, "git");
			await fs.writeFile(git, "#!/bin/sh\nprintf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'\n");
			await fs.chmod(git, 0o755);
			await fs.rm(path.join(value.tools, "nm"));
			expect((await measure({ ...value, path: value.tools })).exitCode).not.toBe(0);
		} finally { await fs.rm(value.directory, { recursive: true, force: true }); }
	});

	test("writes a diagnostic report and exits nonzero when a required probe is missing or emits malformed output", async () => {
		const value = await fixture();
		try {
			await fs.writeFile(value.candidate, "module.exports = { nativeDebugSidecarBacktraceProbe: () => 'native_debug_sidecar_backtrace_probe' };\n");
			const missing = await measure({ ...value, path: `${value.tools}:${process.env.PATH}` });
			expect(missing.exitCode).not.toBe(0);
			expect((await Bun.file(value.output).json()).reason).toContain("Native probe failed");
			await fs.writeFile(value.candidate, "module.exports = { nativePanicUnwindProbe: () => { console.log('noise'); return true; }, nativeDebugSidecarBacktraceProbe: () => 'native_debug_sidecar_backtrace_probe' };\n");
			const malformed = await measure({ ...value, path: `${value.tools}:${process.env.PATH}` });
			expect(malformed.exitCode).not.toBe(0);
			expect((await Bun.file(value.output).json()).reason).toContain("Native probe failed");
		} finally { await fs.rm(value.directory, { recursive: true, force: true }); }
	});

	test("writes a diagnostic report and exits nonzero when a required probe executes but returns false", async () => {
		const value = await fixture();
		try {
			await fs.writeFile(value.candidate, "module.exports = { nativePanicUnwindProbe: () => false, nativeDebugSidecarBacktraceProbe: () => 'native_debug_sidecar_backtrace_probe' };\n");
			const result = await measure({ ...value, path: `${value.tools}:${process.env.PATH}` });
			expect(result.exitCode).not.toBe(0);
			expect((await Bun.file(value.output).json()).reason).toContain("returned false");
		} finally { await fs.rm(value.directory, { recursive: true, force: true }); }
	});
});
