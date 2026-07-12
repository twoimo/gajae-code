import { expect, test } from "bun:test";
import * as path from "node:path";

test("importing agent-wire loads no workspace consumer, domain, or native modules", async () => {
	const source = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
await import("@gajae-code/agent-wire");
const forbidden = ["packages/coding-agent", "packages/bridge-client", "packages/agent-core", "packages/ai", "packages/utils", "packages/natives", ".node"];
const loaded = Object.keys(require.cache).filter(key => forbidden.some(part => key.includes(part)));
if (loaded.length) throw new Error(JSON.stringify(loaded));
console.log("ok");
`;
	const proc = Bun.spawn([process.execPath, "-e", source], {
		cwd: path.resolve(import.meta.dir, ".."),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toContain("ok");
});
