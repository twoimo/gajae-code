import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const failures: string[] = [];

function abs(rel: string): string {
	return path.join(root, rel);
}

function read(rel: string): string {
	return fs.readFileSync(abs(rel), "utf8");
}

function assertNo(rel: string, pattern: RegExp, label: string): void {
	if (pattern.test(read(rel))) failures.push(`${label}: ${rel}`);
}

function assertMissing(rel: string, label: string): void {
	if (fs.existsSync(abs(rel))) failures.push(`${label}: ${rel} still exists`);
}

function walk(dirRel: string): string[] {
	const dir = abs(dirRel);
	if (!fs.existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const rel = path.join(dirRel, entry.name);
		if (entry.isDirectory()) {
			out.push(...walk(rel));
		} else if (entry.isFile()) {
			out.push(rel);
		}
	}
	return out;
}

function assertNoInFiles(files: string[], pattern: RegExp, label: string, allow: Set<string> = new Set()): void {
	for (const rel of files) {
		if (allow.has(rel)) continue;
		if (pattern.test(read(rel))) failures.push(`${label}: ${rel}`);
	}
}

function packageMarkdownFiles(): string[] {
	return walk("packages").filter(rel => {
		if (!rel.endsWith(".md")) return false;
		const base = path.basename(rel);
		if (base === "CHANGELOG.md") return false;
		return true;
	});
}
assertNo(
	"packages/coding-agent/src/main.ts",
	/mode\s*===\s*["']rpc["']|mode\s*===\s*["']rpc-ui["']|parsedArgs\.mode\s*===\s*["']rpc["']|parsedArgs\.mode\s*===\s*["']rpc-ui["']/,
	"legacy standalone RPC routing",
);
assertNo(
	"packages/coding-agent/src/cli.ts",
	/["']rpc-ui["']|["']rpc["']/,
	"legacy public mode options",
);
assertNo(
	"packages/coding-agent/src/cli/args.ts",
	/["']rpc-ui["']|["']rpc["']|rpcListen|["']--listen["']/,
	"legacy parsed mode/listen options",
);
assertNo(
	"packages/coding-agent/src/modes/index.ts",
	/RpcClient|defineRpcClientTool|\.\/rpc\/rpc-client/,
	"legacy RpcClient public export",
);
assertMissing("packages/coding-agent/src/modes/rpc/rpc-socket-security.ts", "legacy socket security module");
assertNo(
	"packages/coding-agent/src/modes/rpc/rpc-mode.ts",
	/rpc-socket-security|prepareRpcSocketPath|verifyRpcSocketAfterListen|options\?\.listen|Bun\.listen|transport:\s*["']socket["']/,
	"legacy RPC UDS server path",
);
// The per-session notification WebSocket remains intentionally retained for
// dev's active Telegram/notification surface. It will migrate behind the
// rpc-sdk daemon boundary later; keep the other legacy RPC absence gates strict.
assertNo(
	"packages/coding-agent/src/commands/harness.ts",
	/new\s+GajaeCodeRpc|JSON\.parse\(override\)|GJC_HARNESS_RPC_COMMAND=.*envAssignments/,
	"legacy harness subprocess fallback",
);
assertNo(
	"packages/coding-agent/src/harness-control-plane/rpc-adapter.ts",
	/["']--mode["']\s*,\s*["']rpc["']|--mode rpc --session-dir/,
	"legacy rpc-client server spawn",
);

for (const rel of [
	"packages/coding-agent/test/rpc-socket-server.test.ts",
	"packages/coding-agent/test/rpc-client-uds.test.ts",
	"packages/coding-agent/test/rpc-unattended-stdio.test.ts",
	"packages/coding-agent/test/rpc-stdio-redteam.test.ts",
]) {
	assertMissing(rel, "stale legacy RPC test");
}

assertNoInFiles(
	walk("packages/coding-agent/test").filter(rel => rel.endsWith(".ts")),
	/["']--mode["']\s*,\s*["']rpc["']|--mode rpc(?:\s|$)|["']--listen["']\s*,/,
	"legacy RPC test spawn",
	new Set(["packages/coding-agent/test/harness-control-plane/fixtures/fake-rpc.ts"]),
);
assertNoInFiles(
	walk("docs").filter(rel => rel.endsWith(".md")),
	/RpcClient|defineRpcClientTool|--mode rpc(?:\s|$)|--listen\b/,
	"legacy RPC docs surface",
	new Set(["docs/rpc.md"]),
);
assertNoInFiles(
	packageMarkdownFiles(),
	/RpcClient|defineRpcClientTool|--mode rpc(?:\s|$)|--listen\b/,
	"legacy RPC package docs surface",
);

if (failures.length > 0) {
	process.stderr.write(`${failures.join("\n")}\n`);
	process.exit(1);
}

process.stdout.write("runtime_io_legacy_surface_absence: ok\n");
