import { describe, expect, test } from "bun:test";
import { evaluate, validateSha } from "./telegram-daemon-generation-guard";

const telegramContract = "packages/coding-agent/src/sdk/bus/telegram-daemon-contract.ts";
const telegramDaemon = "packages/coding-agent/src/sdk/bus/telegram-daemon.ts";
const chatControl = "packages/coding-agent/src/sdk/bus/chat-daemon-control.ts";

function files(input: {
	telegramGeneration?: number;
	chatGeneration?: number;
	telegramOwnership?: string;
	chatLifecycle?: string;
} = {}): Map<string, string> {
	return new Map([
		[
			telegramContract,
			input.telegramGeneration === undefined
				? ""
				: `export const NOTIFICATION_PROTOCOL_VERSION = 3;\nexport const DAEMON_GENERATION = ${input.telegramGeneration};\n`,
		],
		[
			telegramDaemon,
			input.telegramOwnership === undefined
				? ""
				: `export function acquireDaemonOwnership() { ${input.telegramOwnership} }\n`,
		],
		[
			chatControl,
			[
				input.chatGeneration === undefined ? "" : `export const CHAT_DAEMON_GENERATION = ${input.chatGeneration};`,
				input.chatLifecycle === undefined ? "" : `function isPhysicalLiveState() { ${input.chatLifecycle} }`,
			].join("\n"),
		],
	]);
}

describe("daemon generation release guard", () => {
	test("requires a Telegram bump for protected ownership changes", () => {
		const missingBump = evaluate(
			files({ telegramGeneration: 4, telegramOwnership: "return true;" }),
			files({ telegramGeneration: 4, telegramOwnership: "return false;" }),
		);
		expect(missingBump.protectedChanges).toContain(`telegram:${telegramDaemon}:acquireDaemonOwnership`);
		expect(missingBump.telegramGenerationBumped).toBe(false);
		expect(missingBump.chatGenerationBumped).toBe(false);

		const bumped = evaluate(
			files({ telegramGeneration: 4, telegramOwnership: "return true;" }),
			files({ telegramGeneration: 5, telegramOwnership: "return false;" }),
		);
		expect(bumped.telegramGenerationBumped).toBe(true);
	});

	test("requires a chat bump for protected lifecycle changes", () => {
		const missingBump = evaluate(
			files({ chatGeneration: 1, chatLifecycle: "return true;" }),
			files({ chatGeneration: 1, chatLifecycle: "return false;" }),
		);
		expect(missingBump.protectedChanges).toContain(`chat:${chatControl}:isPhysicalLiveState`);
		expect(missingBump.chatGenerationBumped).toBe(false);

		const bumped = evaluate(
			files({ chatGeneration: 1, chatLifecycle: "return true;" }),
			files({ chatGeneration: 2, chatLifecycle: "return false;" }),
		);
		expect(bumped.chatGenerationBumped).toBe(true);
	});

	test("does not allow a cross-family generation bump", () => {
		const decision = evaluate(
			files({ telegramGeneration: 4, chatGeneration: 1, telegramOwnership: "return true;" }),
			files({ telegramGeneration: 4, chatGeneration: 2, telegramOwnership: "return false;" }),
		);
		expect(decision.telegramGenerationBumped).toBe(false);
		expect(decision.chatGenerationBumped).toBe(true);
	});

	test("ignores protocol, SDK/bus, and guard-only changes", () => {
		const base = files({ telegramGeneration: 4, chatGeneration: 1 });
		const head = files({ telegramGeneration: 4, chatGeneration: 1 });
		head.set(telegramContract, "export const NOTIFICATION_PROTOCOL_VERSION = 4;\nexport const DAEMON_GENERATION = 4;\n");
		head.set("packages/coding-agent/src/sdk/bus/unrelated.ts", "export const changed = true;\n");
		expect(evaluate(base, head)).toEqual({
			protectedChanges: [],
			telegramGenerationBumped: false,
			chatGenerationBumped: false,
		});
	});

	test("fails closed when a previously protected symbol disappears", () => {
		const decision = evaluate(
			files({ telegramGeneration: 4, telegramOwnership: "return true;" }),
			files({ telegramGeneration: 4 }),
		);
		expect(decision.protectedChanges).toContain(`telegram:${telegramDaemon}:acquireDaemonOwnership`);
		expect(decision.telegramGenerationBumped).toBe(false);
	});

	test("rejects missing or abbreviated commit objects before diffing", () => {
		expect(() => validateSha("base SHA", undefined)).toThrow("exact 40-hex commit SHA");
		expect(() => validateSha("head SHA", "abc123")).toThrow("exact 40-hex commit SHA");
		expect(validateSha("head SHA", "A".repeat(40))).toBe("a".repeat(40));
	});
});
