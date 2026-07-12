#!/usr/bin/env bun
import * as path from "node:path";

const packageDir = path.resolve(import.meta.dir, "../packages/coding-agent");
const manifest = await Bun.file(path.join(packageDir, "package.json")).json() as { bin: { gjc: string }; exports: Record<string, { import: string; types: string }>; files: string[] };
const expected = [".", "./sdk", "./cli"];
if (JSON.stringify(Object.keys(manifest.exports).sort()) !== JSON.stringify(expected.sort())) {
	throw new Error("coding-agent export map is not the reviewed stable surface");
}
for (const [specifier, target] of Object.entries(manifest.exports)) {
	for (const value of [target.import, target.types]) {
		if (!(await Bun.file(path.join(packageDir, value)).exists())) throw new Error(`${specifier} target is missing: ${value}`);
	}
}
if (!(await Bun.file(path.join(packageDir, manifest.bin.gjc)).exists())) throw new Error("CLI bin entry is missing");
const root = await import(path.join(packageDir, "src/index.ts"));
for (const symbol of ["createAgentSession", "SessionManager", "AuthStorage", "ModelRegistry", "RpcClient", "defineRpcClientTool"]) {
	if (!(symbol in root)) throw new Error(`root stable symbol is missing: ${symbol}`);
}
const packed = Bun.spawnSync({ cmd: [process.execPath, "pm", "pack", "--dry-run"], cwd: packageDir, stdout: "pipe", stderr: "pipe" });
if (packed.exitCode !== 0) throw new Error(packed.stderr.toString() || packed.stdout.toString());
for (const quarantined of ["./tools", "./session/agent-session", "./modes"]) {
	try {
		await import(`@gajae-code/coding-agent${quarantined}`);
		throw new Error(`quarantined export resolved: ${quarantined}`);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("quarantined export resolved")) throw error;
	}
}
