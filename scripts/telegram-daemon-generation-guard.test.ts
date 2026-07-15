import { describe, expect, test } from "bun:test";
import { declaration, evaluate, isLegacyBootstrapBase, protectedInventory, validateCiInputs, validateInventory, validateManifest, validateSha } from "./telegram-daemon-generation-guard";

const telegramContract = "packages/coding-agent/src/sdk/bus/telegram-daemon-contract.ts";
const telegramDaemon = "packages/coding-agent/src/sdk/bus/telegram-daemon.ts";
const chatControl = "packages/coding-agent/src/sdk/bus/chat-daemon-control.ts";
const inventory = {
	telegram: { [telegramContract]: ["DAEMON_GENERATION"], [telegramDaemon]: ["acquireDaemonOwnership"] },
	discord: { [chatControl]: ["CHAT_DAEMON_GENERATIONS", "chatDaemonGeneration", "operate"] },
	slack: { [chatControl]: ["CHAT_DAEMON_GENERATIONS", "chatDaemonGeneration", "operate"] },
} as const;

function files(input: {
	telegramGeneration?: number;
	discordGeneration?: number;
	slackGeneration?: number;
	telegramOwnership?: string;
	chatLifecycle?: string;
} = {}): Map<string, string> {
	return new Map([
		[
			telegramContract,
			input.telegramGeneration === undefined ? "" : `export const DAEMON_GENERATION = ${input.telegramGeneration};\n`,
		],
		[
			telegramDaemon,
			input.telegramOwnership === undefined ? "" : `export function acquireDaemonOwnership() { ${input.telegramOwnership} }\n`,
		],
		[
			chatControl,
			[
				`export const CHAT_DAEMON_GENERATIONS = { discord: ${input.discordGeneration ?? 1}, slack: ${input.slackGeneration ?? 1} } as const;`,
				"export function chatDaemonGeneration(kind: \"discord\" | \"slack\") { return CHAT_DAEMON_GENERATIONS[kind]; }",
				input.chatLifecycle === undefined ? "" : `class ChatDaemonController { async operate() { ${input.chatLifecycle} } }`,
			].join("\n"),
		],
	]);
}

const decide = (base: Map<string, string>, head: Map<string, string>) => evaluate(base, head, inventory);

describe("daemon generation release guard", () => {
	test("requires a Telegram bump for protected ownership changes", () => {
		const missingBump = decide(files({ telegramGeneration: 4, telegramOwnership: "return true;" }), files({ telegramGeneration: 4, telegramOwnership: "return false;" }));
		expect(missingBump.protectedChanges).toContain(`telegram:${telegramDaemon}:acquireDaemonOwnership`);
		expect(missingBump.telegramGenerationBumped).toBe(false);

		const bumped = decide(files({ telegramGeneration: 4, telegramOwnership: "return true;" }), files({ telegramGeneration: 5, telegramOwnership: "return false;" }));
		expect(bumped.telegramGenerationBumped).toBe(true);
	});

	test("requires a bump for the affected chat kind, not the other kind", () => {
		const missingBump = decide(files({ discordGeneration: 1, slackGeneration: 1, chatLifecycle: "return true;" }), files({ discordGeneration: 1, slackGeneration: 2, chatLifecycle: "return false;" }));
		expect(missingBump.protectedChanges).toContain(`discord:${chatControl}:operate`);
		expect(missingBump.chatGenerationBumped).toEqual({ discord: false, slack: true });

		const bumped = decide(files({ discordGeneration: 1, slackGeneration: 1, chatLifecycle: "return true;" }), files({ discordGeneration: 2, slackGeneration: 1, chatLifecycle: "return false;" }));
		expect(bumped.chatGenerationBumped.discord).toBe(true);
	});

	test("AST extraction ignores strings and comments while preserving typed declarations", () => {
		const source = `// export function acquireDaemonOwnership() {}\nconst message = "acquireDaemonOwnership()";\nexport async function acquireDaemonOwnership<T>(value: T): Promise<T> { return value; }`;
		expect(declaration(source, "acquireDaemonOwnership")).toContain("Promise<T>");
		expect(declaration("const message = 'acquireDaemonOwnership';", "acquireDaemonOwnership")).toBeUndefined();
	});

	test("canonical AST comparison ignores declaration comments and formatting", () => {
		const base = files({ telegramGeneration: 4, telegramOwnership: "// stable\nreturn true;" });
		const head = files({ telegramGeneration: 4, telegramOwnership: "return /* stable */ true;" });
		expect(decide(base, head).protectedChanges).toEqual([]);
	});

	test("canonical AST comparison ignores guard policy comments and formatting", () => {
		const base = files();
		const head = files();
		base.set("scripts/telegram-daemon-generation-guard.ts", "// policy\nexport const GUARD_CONTRACT_VERSION = 2;");
		head.set("scripts/telegram-daemon-generation-guard.ts", "export const GUARD_CONTRACT_VERSION=2 /* policy */;");
		expect(decide(base, head).guardPolicyChanged).toBe(false);
	});

	test("requires a contract-version bump for an existing guard policy change without a daemon bump", () => {
		const base = files({ telegramGeneration: 4, telegramOwnership: "return true;" });
		const head = files({ telegramGeneration: 4, telegramOwnership: "return true;" });
		base.set("scripts/telegram-daemon-generation-guard.ts", "export const GUARD_CONTRACT_VERSION = 2;\nexport const policy = true;");
		head.set("scripts/telegram-daemon-generation-guard.ts", "export const GUARD_CONTRACT_VERSION = 2;\nexport const policy = false;");
		const unbumped = decide(base, head);
		expect(unbumped.guardPolicyChanged).toBe(true);
		expect(unbumped.guardContractBumped).toBe(false);
		expect(unbumped.telegramGenerationBumped).toBe(false);
		head.set("scripts/telegram-daemon-generation-guard.ts", "export const GUARD_CONTRACT_VERSION = 3;\nexport const policy = false;");
		expect(decide(base, head).guardContractBumped).toBe(true);
	});

	test("only bootstraps when the guard is absent and rejects duplicate inventory symbols", () => {
		const base = files({ telegramGeneration: 4, telegramOwnership: "return true;" });
		const head = files({ telegramGeneration: 5 });
		base.set("scripts/telegram-daemon-generation-guard.ts", "export const unrelated = 1;");
		head.set("scripts/telegram-daemon-generation-guard.ts", "export const unrelated = 1;");
		expect(decide(base, head).malformedDeclarations).toContain(`telegram:${telegramDaemon}:acquireDaemonOwnership`);
		expect(() => validateInventory({ telegram: { [telegramContract]: ["DAEMON_GENERATION", "DAEMON_GENERATION"] }, discord: {}, slack: {} } as any)).toThrow("invalid telegram contract inventory");
	});

	test("bootstraps only the complete legacy protocol-3 topology", () => {
		const base = files({ telegramOwnership: "return true;" });
		base.delete("scripts/telegram-daemon-generation-guard.ts");
		base.set(telegramContract, "export const NOTIFICATION_PROTOCOL_VERSION = 3;\nexport const DAEMON_GENERATION = NOTIFICATION_PROTOCOL_VERSION;");
		base.set(chatControl, "");
		const head = files({ telegramGeneration: 4, telegramOwnership: "return true;", chatLifecycle: "return true;" });
		expect(isLegacyBootstrapBase(base)).toBe(true);
		expect(decide(base, head).malformedDeclarations).toEqual([]);

		for (const mutate of [
			(candidate: Map<string, string>) => candidate.set(telegramContract, "export const NOTIFICATION_PROTOCOL_VERSION = 3;\nexport const DAEMON_GENERATION = 3;"),
			(candidate: Map<string, string>) => candidate.set(telegramDaemon, "export function acquireDaemonOwnership() { return true; }\nconst ownershipPhase = 'ready';"),
			(candidate: Map<string, string>) => candidate.set(chatControl, "export const CHAT_DAEMON_GENERATIONS = { discord: 1, slack: 1 };"),
			(candidate: Map<string, string>) => candidate.set(telegramDaemon, ""),
		]) {
			const candidate = new Map(base);
			mutate(candidate);
			expect(isLegacyBootstrapBase(candidate)).toBe(false);
			expect(decide(candidate, head).malformedDeclarations.length).toBeGreaterThan(0);
		}
	});

	test("semantic manifest rejects duplicate, moved, and narrowed inventories", () => {
		expect(() => validateManifest()).not.toThrow();
		const duplicate = structuredClone(protectedInventory) as typeof protectedInventory;
		(duplicate.telegram[telegramContract] as string[]).push("DAEMON_GENERATION");
		expect(() => validateInventory(duplicate)).toThrow("invalid telegram contract inventory");
		expect(() => validateManifest({ contractVersion: 5, inventory: duplicate })).toThrow("invalid telegram contract inventory");
		const moved = structuredClone(protectedInventory) as typeof protectedInventory;
		moved.telegram["moved.ts"] = moved.telegram[telegramContract];
		delete moved.telegram[telegramContract];
		expect(() => validateManifest({ contractVersion: 5, inventory: moved })).toThrow("does not match the protected inventory");
		const narrowed = structuredClone(protectedInventory) as typeof protectedInventory;
		(narrowed.telegram[telegramDaemon] as string[]).pop();
		expect(() => validateManifest({ contractVersion: 5, inventory: narrowed })).toThrow("does not match the protected inventory");
	});

	test("fails closed for malformed protected declarations", () => {
		const base = files({ telegramGeneration: 4, telegramOwnership: "return true;" });
		const head = files({ telegramGeneration: 4, telegramOwnership: "return true;" });
		head.set(telegramDaemon, "export function acquireDaemonOwnership( {");
		const result = decide(base, head);
		expect(result.malformedDeclarations).toContain(`telegram:${telegramDaemon}:acquireDaemonOwnership`);
		head.set(telegramDaemon, "");
		expect(decide(base, head).malformedDeclarations).toContain(`telegram:${telegramDaemon}:acquireDaemonOwnership`);
	});

	test("rejects missing or abbreviated commit objects before diffing", () => {
		expect(() => validateSha("base SHA", undefined)).toThrow("exact 40-hex commit SHA");
		expect(() => validateSha("head SHA", "abc123")).toThrow("exact 40-hex commit SHA");
		expect(validateSha("head SHA", "A".repeat(40))).toBe("a".repeat(40));
	});
	test("accepts same-repository push and dispatch, and permits a fork PR head", () => {
		const sha = "a".repeat(40);
		for (const input of [
			{ eventName: "push", baseRepository: "owner/repo", headRepository: "owner/repo" },
			{ eventName: "workflow_dispatch", baseRepository: "owner/repo", headRepository: "owner/repo" },
			{ eventName: "pull_request", baseRepository: "owner/repo", headRepository: "fork/repo" },
		] as const) validateCiInputs({ ...input, baseSha: sha, headSha: sha, repository: "owner/repo" });
	});

	test("rejects a missing dispatch base, malformed refs, and foreign push heads", () => {
		const sha = "a".repeat(40);
		expect(() => validateCiInputs({ eventName: "workflow_dispatch", baseSha: undefined, headSha: sha, baseRepository: "owner/repo", headRepository: "owner/repo", repository: "owner/repo" })).toThrow("base SHA");
		expect(() => validateCiInputs({ eventName: "push", baseSha: sha, headSha: "short", baseRepository: "owner/repo", headRepository: "owner/repo", repository: "owner/repo" })).toThrow("head SHA");
		expect(() => validateCiInputs({ eventName: "push", baseSha: sha, headSha: sha, baseRepository: "owner/repo", headRepository: "fork/repo", repository: "owner/repo" })).toThrow("push head repository");
	});


	test("isolates shared chat generation-map changes to the matching family", () => {
		const sharedInventory = {
			telegram: {},
			discord: { [chatControl]: ["CHAT_DAEMON_GENERATIONS.discord"] },
			slack: { [chatControl]: ["CHAT_DAEMON_GENERATIONS.slack"] },
		} as const;
		const base = files({ discordGeneration: 1, slackGeneration: 1 });
		const head = files({ discordGeneration: 2, slackGeneration: 1 });
		const result = evaluate(base, head, sharedInventory);
		expect(result.protectedChanges).toEqual([`discord:${chatControl}:CHAT_DAEMON_GENERATIONS.discord`]);
		expect(result.chatGenerationBumped).toEqual({ discord: true, slack: false });
	});

	test("rejects duplicate top-level protected declarations", () => {
		const source = "export function acquireDaemonOwnership() {}\nexport function acquireDaemonOwnership() {}";
		expect(declaration(source, "acquireDaemonOwnership")).toBe("<malformed>");
	});
});
