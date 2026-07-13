import { afterEach, expect, test } from "bun:test";
import * as path from "node:path";
import { createLifecycleFixture, type LifecycleFixture } from "./helpers/sdk-lifecycle-fixture";

const cliEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");
const fixtures: LifecycleFixture[] = [];

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
});

async function fixture(): Promise<LifecycleFixture> {
	const value = await createLifecycleFixture();
	fixtures.push(value);
	return value;
}

function result(value: unknown): { ok: boolean; result?: Record<string, unknown>; error?: { code?: string } } {
	if (!value || typeof value !== "object")
		throw new Error(`Expected lifecycle result, received ${JSON.stringify(value)}`);
	return value as { ok: boolean; result?: Record<string, unknown>; error?: { code?: string } };
}

async function mcpGlobal(
	repo: string,
	agentDir: string,
	operation: string,
	input: Record<string, unknown>,
	idempotencyKey: string,
) {
	const child = Bun.spawn([process.execPath, "run", cliEntrypoint, "mcp-serve", "sdk"], {
		cwd: repo,
		env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir, GJC_AGENT_DIR: agentDir },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "gjc_session_global", arguments: { operation, input, idempotencyKey } } })}\n`,
	);
	await child.stdin.end();
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	const response = JSON.parse(stdout.trim()) as { result?: { content?: Array<{ text?: string }> } };
	return result(JSON.parse(response.result?.content?.[0]?.text ?? "null"));
}

async function daemonGlobal(
	repo: string,
	agentDir: string,
	operation: string,
	input: Record<string, unknown>,
	idempotencyKey: string,
) {
	const child = Bun.spawn(
		[
			process.execPath,
			"run",
			cliEntrypoint,
			"daemon",
			"session",
			"global",
			"--op",
			operation,
			"--json-input",
			JSON.stringify(input),
			"--idempotency-key",
			idempotencyKey,
		],
		{
			cwd: repo,
			env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir, GJC_AGENT_DIR: agentDir },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	const output = result(JSON.parse(stdout));
	expect(exitCode, stderr).toBe(output.ok ? 0 : 1);
	expect(stderr).not.toContain("token");
	return output;
}

async function acpGlobal(
	repo: string,
	agentDir: string,
	operation: string,
	input: Record<string, unknown>,
	idempotencyKey: string,
) {
	const child = Bun.spawn([process.execPath, cliEntrypoint, "--mode", "acp"], {
		cwd: repo,
		env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir, GJC_AGENT_DIR: agentDir, PI_NO_TITLE: "1", NO_COLOR: "1" },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = new Response(child.stderr).text();
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	const readFrame = async (): Promise<{
		id?: number;
		result?: unknown;
		error?: { code?: string; message?: string };
	}> => {
		while (true) {
			const newline = buffered.indexOf("\n");
			if (newline >= 0) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (line)
					return JSON.parse(line) as {
						id?: number;
						result?: unknown;
						error?: { code?: string; message?: string };
					};
			}
			const chunk = await reader.read();
			if (chunk.done) throw new Error("ACP stdout closed before response.");
			buffered += decoder.decode(chunk.value, { stream: true });
		}
	};
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })}\n`,
	);
	child.stdin.flush();
	await readFrame();
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "_gjc/sdk/global", params: { operation, input, idempotencyKey } })}\n`,
	);
	child.stdin.flush();
	const response = await readFrame();
	await child.stdin.end();
	const exitCode = await child.exited;
	const stderrText = await stderr;
	expect(exitCode, stderrText).toBe(0);
	return result(response.result ?? { ok: false, error: response.error ?? { code: "unknown" } });
}

test("shipped ACP rejects raw generic lifecycle ingress in favor of typed session methods", async () => {
	const life = await fixture();
	try {
		await expect(
			acpGlobal(
				life.repo,
				life.agentDir,
				"session.create",
				{ cwd: life.repo, target: { path: life.repo }, stateRoot: life.stateRoot },
				"raw-lifecycle-must-not-reach-broker",
			),
		).resolves.toMatchObject({ ok: false, error: { code: "operation_prohibited" } });
	} finally {
		await life.cleanup();
	}
}, 120_000);

test("shipped mcp-serve sdk stdio drives authenticated G03-G07 lifecycle topology with durable effects", async () => {
	const life = await fixture();
	await life.invokeScenario((operation, input, idempotencyKey) =>
		mcpGlobal(life.repo, life.agentDir, operation, input, idempotencyKey),
	);
}, 120_000);

test("shipped daemon session CLI drives authenticated G03-G07 lifecycle topology with durable effects", async () => {
	const life = await fixture();
	await life.invokeScenario((operation, input, idempotencyKey) =>
		daemonGlobal(life.repo, life.agentDir, operation, input, idempotencyKey),
	);
}, 120_000);
