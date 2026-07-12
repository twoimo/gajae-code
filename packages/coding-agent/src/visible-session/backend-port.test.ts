import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	VisibleSessionBackendContext,
	VisibleSessionBackendId,
	VisibleSessionBackendPort,
	VisibleSessionBackendSessionCommandInput,
} from "./backend";
import { type VisibleSessionCommandError, VisibleSessionCommandService } from "./command-service";
import type { VisibleSessionRegistry } from "./registry";
import type { VisibleSessionGeneration } from "./types";

function registry(
	backend: "conpty" | "tmux" | "wsl-tmux" = "tmux",
	active: Partial<VisibleSessionGeneration> = {},
): VisibleSessionRegistry {
	return {
		read: async () => ({
			schemaVersion: 1,
			revision: 7,
			nextGenerationCounter: 1,
			managedPublicBases: [],
			entries: [
				{
					name: { displayName: "alpha", key: "alpha" },
					repository: "C:\\repo",
					worktree: "C:\\worktree",
					backend,
					active: {
						generationId: "1-aaaaaaaaaaaaaaaaaaaaaaaa",
						counter: 1,
						status: "active",
						startIdentity: "a".repeat(64),
						leaseId: "b".repeat(32),
						publicBaseId: "default",
						publicRoot: "C:\\public",
						privateRoot: "C:\\private",
						manifestFilePath: "C:\\private\\manifest.json",
						createdAt: new Date(0).toISOString(),
						tokenFilePath: "C:\\private\\control-token",
						tokenSha256: "c".repeat(64),
						...active,
					},
					history: [],
				},
			],
		}),
	} as unknown as VisibleSessionRegistry;
}

function ports(
	...entries: readonly (readonly [VisibleSessionBackendId, VisibleSessionBackendPort])[]
): ReadonlyMap<VisibleSessionBackendId, VisibleSessionBackendPort> {
	return new Map(entries);
}

async function withToken(callback: (token: Buffer, privateRoot: string) => Promise<void>): Promise<void> {
	const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "visible-session-backend-port-"));
	const token = Buffer.alloc(32, 9);
	await Bun.write(path.join(privateRoot, "control-token"), token);
	try {
		await callback(token, privateRoot);
	} finally {
		await fs.rm(privateRoot, { recursive: true, force: true });
	}
}

test("dispatches matching non-ConPTY session commands, probes, and cancels through its exact backend port", async () => {
	const calls: string[] = [];
	const sessionInputs: VisibleSessionBackendSessionCommandInput[] = [];
	const contexts: VisibleSessionBackendContext[] = [];
	const port: VisibleSessionBackendPort = {
		id: "tmux",
		capabilities: { localControl: true, interactiveAttach: true, routerWatch: true },
		sessionCommand: async input => {
			calls.push("sessionCommand");
			sessionInputs.push(input);
			return ["tmux", "attach-session", "-r", "-t", "=alpha:"];
		},
		probe: async context => {
			calls.push("probe");
			contexts.push(context);
			return { kind: "running", backend: "tmux" };
		},
		cancel: async context => {
			calls.push("cancel");
			contexts.push(context);
			return { kind: "accepted", backend: "tmux" };
		},
	};
	const service = new VisibleSessionCommandService({
		registry: registry(),
		backendPorts: ports(["tmux", port]),
	});

	await expect(service.sessionCommand("alpha", { readOnly: true })).resolves.toEqual([
		"tmux",
		"attach-session",
		"-r",
		"-t",
		"=alpha:",
	]);
	await expect(service.status("alpha")).resolves.toMatchObject({
		phase: "running",
		terminal: null,
		recreatable: false,
	});
	await expect(service.cancel("alpha")).resolves.toEqual({ cancelled: true, phase: "live" });

	expect(calls).toEqual(["sessionCommand", "probe", "probe", "cancel"]);
	expect(sessionInputs).toHaveLength(1);
	expect(sessionInputs[0]).toMatchObject({
		readOnly: true,
		context: { entry: { backend: "tmux" }, generation: { generationId: "1-aaaaaaaaaaaaaaaaaaaaaaaa" } },
	});
	expect(sessionInputs[0]!.context.generation).toBe(sessionInputs[0]!.context.entry.active);
	expect(contexts).toHaveLength(3);
	for (const context of contexts) {
		expect(context.entry.backend).toBe("tmux");
		expect(context.generation).toBe(context.entry.active);
	}
});

test("maps terminal probe discriminants without using ConPTY terminal evidence", async () => {
	let cancelCalls = 0;
	const port: VisibleSessionBackendPort = {
		id: "tmux",
		capabilities: { localControl: true, interactiveAttach: true, routerWatch: true },
		sessionCommand: async () => ["tmux", "attach-session"],
		probe: async () => ({ kind: "terminal", backend: "tmux", status: "vanished" }),
		cancel: async () => {
			cancelCalls += 1;
			return { kind: "accepted", backend: "tmux" };
		},
	};
	const service = new VisibleSessionCommandService({ registry: registry(), backendPorts: ports(["tmux", port]) });

	await expect(service.status("alpha")).resolves.toMatchObject({
		phase: "terminal",
		terminal: "vanished",
		recreatable: false,
	});
	await expect(service.cancel("alpha")).resolves.toEqual({ cancelled: false, phase: "terminal" });
	expect(cancelCalls).toBe(0);
});

test("fails closed for missing, mismatched, and unavailable backend ports", async () => {
	const missing = new VisibleSessionCommandService({ registry: registry() });
	await expect(missing.sessionCommand("alpha")).rejects.toMatchObject({
		code: "control_unavailable",
	} satisfies Partial<VisibleSessionCommandError>);

	let mismatchedCalls = 0;
	const mismatched: VisibleSessionBackendPort = {
		id: "wsl-tmux",
		capabilities: { localControl: true, interactiveAttach: true, routerWatch: true },
		sessionCommand: async () => {
			mismatchedCalls += 1;
			return ["tmux"];
		},
		probe: async () => {
			mismatchedCalls += 1;
			return { kind: "running", backend: "wsl-tmux" };
		},
		cancel: async () => {
			mismatchedCalls += 1;
			return { kind: "accepted", backend: "wsl-tmux" };
		},
	};
	const mismatchedService = new VisibleSessionCommandService({
		registry: registry(),
		backendPorts: ports(["tmux", mismatched]),
	});
	await expect(mismatchedService.status("alpha")).rejects.toMatchObject({
		code: "control_unavailable",
	} satisfies Partial<VisibleSessionCommandError>);
	expect(mismatchedCalls).toBe(0);

	const unavailableCalls: string[] = [];
	const unavailable: VisibleSessionBackendPort = {
		id: "tmux",
		capabilities: { localControl: true, interactiveAttach: true, routerWatch: true },
		sessionCommand: async () => {
			unavailableCalls.push("sessionCommand");
			return { kind: "unavailable", backend: "tmux", reason: "offline" };
		},
		probe: async () => {
			unavailableCalls.push("probe");
			return { kind: "running", backend: "tmux" };
		},
		cancel: async () => {
			unavailableCalls.push("cancel");
			return { kind: "unavailable", backend: "tmux", reason: "offline" };
		},
	};
	const unavailableService = new VisibleSessionCommandService({
		registry: registry(),
		backendPorts: ports(["tmux", unavailable]),
	});
	await expect(unavailableService.sessionCommand("alpha")).rejects.toMatchObject({
		code: "control_unavailable",
	} satisfies Partial<VisibleSessionCommandError>);
	await expect(unavailableService.cancel("alpha")).rejects.toMatchObject({
		code: "control_unavailable",
	} satisfies Partial<VisibleSessionCommandError>);
	expect(unavailableCalls).toEqual(["sessionCommand", "probe", "cancel"]);
});

test("requires each backend capability before dispatching its operation", async () => {
	let sessionCommandCalls = 0;
	const interactiveDisabled: VisibleSessionBackendPort = {
		id: "tmux",
		capabilities: { localControl: true, interactiveAttach: false, routerWatch: true },
		sessionCommand: async () => {
			sessionCommandCalls += 1;
			return ["tmux"];
		},
		probe: async () => ({ kind: "running", backend: "tmux" }),
		cancel: async () => ({ kind: "accepted", backend: "tmux" }),
	};
	const interactiveService = new VisibleSessionCommandService({
		registry: registry(),
		backendPorts: ports(["tmux", interactiveDisabled]),
	});
	await expect(interactiveService.sessionCommand("alpha")).rejects.toMatchObject({
		code: "control_unavailable",
	} satisfies Partial<VisibleSessionCommandError>);
	expect(sessionCommandCalls).toBe(0);

	let probeCalls = 0;
	const watchDisabled: VisibleSessionBackendPort = {
		id: "tmux",
		capabilities: { localControl: true, interactiveAttach: true, routerWatch: false },
		sessionCommand: async () => ["tmux"],
		probe: async () => {
			probeCalls += 1;
			return { kind: "running", backend: "tmux" };
		},
		cancel: async () => ({ kind: "accepted", backend: "tmux" }),
	};
	const watchService = new VisibleSessionCommandService({
		registry: registry(),
		backendPorts: ports(["tmux", watchDisabled]),
	});
	await expect(watchService.status("alpha")).rejects.toMatchObject({
		code: "control_unavailable",
	} satisfies Partial<VisibleSessionCommandError>);
	expect(probeCalls).toBe(0);

	let cancelCalls = 0;
	const localControlDisabled: VisibleSessionBackendPort = {
		id: "tmux",
		capabilities: { localControl: false, interactiveAttach: true, routerWatch: true },
		sessionCommand: async () => ["tmux"],
		probe: async () => ({ kind: "running", backend: "tmux" }),
		cancel: async () => {
			cancelCalls += 1;
			return { kind: "accepted", backend: "tmux" };
		},
	};
	const localControlService = new VisibleSessionCommandService({
		registry: registry(),
		backendPorts: ports(["tmux", localControlDisabled]),
	});
	await expect(localControlService.cancel("alpha")).rejects.toMatchObject({
		code: "control_unavailable",
	} satisfies Partial<VisibleSessionCommandError>);
	expect(cancelCalls).toBe(0);
});

test("preserves ConPTY status and cancel control behavior without a backend port", async () => {
	await withToken(async (token, privateRoot) => {
		const calls: string[] = [];
		const generationId = "2-bbbbbbbbbbbbbbbbbbbbbbbb";
		const service = new VisibleSessionCommandService({
			registry: registry("conpty", {
				generationId,
				privateRoot,
				manifestFilePath: path.join(privateRoot, "manifest.json"),
				tokenFilePath: path.join(privateRoot, "control-token"),
				tokenSha256: createHash("sha256").update(token).digest("hex"),
			}),
			createReader: () =>
				({
					read: async () => ({
						metadata: {
							schemaVersion: 1,
							revision: 1,
							generationId,
							createdAt: new Date(0).toISOString(),
							normalSummary: "running",
						},
						runtime: null,
						promptAccepted: null,
						final: null,
						vanished: null,
						pane: { text: "", lines: 0, truncated: false },
					}),
				}) as never,
			createClient: () =>
				({
					call: async (request: { action: string }) => {
						calls.push(request.action);
						if (request.action === "status") {
							return {
								ok: true,
								result: { generation: generationId, ready: true, running: true, cancelRequested: false },
							};
						}
						return { ok: true, result: {} };
					},
				}) as never,
		});

		await expect(service.status("alpha")).resolves.toMatchObject({ phase: "ready" });
		await expect(service.cancel("alpha")).resolves.toEqual({ cancelled: true, phase: "live" });
		expect(calls).toEqual(["status", "status", "cancel"]);
	});
});
