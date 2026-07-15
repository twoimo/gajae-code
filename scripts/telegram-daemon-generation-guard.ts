#!/usr/bin/env bun
import { $ } from "bun";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const SHA = /^[0-9a-f]{40}$/i;
const telegramContract = "packages/coding-agent/src/sdk/bus/telegram-daemon-contract.ts";
const chatControl = "packages/coding-agent/src/sdk/bus/chat-daemon-control.ts";

type Family = "telegram" | "chat";

type Inventory = Readonly<Record<Family, Readonly<Record<string, readonly string[]>>>>;

/**
 * Explicit lifecycle inventory only. Session endpoint generations and provider SDK
 * implementations are deliberately excluded: they do not replace daemon owners.
 */
export const protectedInventory = {
	telegram: {
		[telegramContract]: ["DAEMON_GENERATION"],
		"packages/coding-agent/src/sdk/bus/notification-service.ts": ["daemonGenerationRelation"],
		"packages/coding-agent/src/sdk/bus/telegram-daemon.ts": [
			"DaemonState",
			"ownerIdentityMatches",
			"liveOwnerUsesDifferentIdentity",
			"isFreshLiveOwner",
			"isCurrentCompatibleOwner",
			"acquireDaemonOwnership",
			"renewDaemonHeartbeat",
			"retireProvisionalDaemonOwnership",
			"waitForTelegramDaemonReady",
			"confirmTelegramDaemonSpawn",
			"releaseDaemonOwnership",
			"spawnTelegramDaemonOwner",
			"ensureTelegramDaemonRunningDetailed",
			"ensureTelegramDaemonRunning",
		],
		"packages/coding-agent/src/sdk/bus/telegram-daemon-control.ts": [
			"TelegramDaemonController",
			"status",
			"spawnAndWait",
			"stopOrReload",
			"waitForPidDeath",
			"signalCapturedOwner",
			"clearOwnRequest",
		],
	},
	chat: {
		[chatControl]: [
			"CHAT_DAEMON_GENERATION",
			"ChatDaemonState",
			"readChatDaemonState",
			"writeJson",
			"ChatDaemonController",
			"status",
			"ensure",
			"operate",
			"isPhysicalLiveState",
			"isCurrentCompatibleState",
			"stopForReplacement",
			"ownsCapturedState",
			"signalIfOwner",
			"waitForDeath",
			"spawn",
			"acquireChatDaemonOwnership",
			"renewChatDaemonHeartbeat",
			"releaseChatDaemonOwnership",
		],
		"packages/coding-agent/src/sdk/bus/chat-daemon-cli.ts": ["runChatDaemonInternal"],
	},
} as const satisfies Inventory;

export function validateSha(name: string, value: string | undefined): string {
	if (!value || !SHA.test(value)) throw new Error(`telegram-daemon-generation-guard: ${name} must be an exact 40-hex commit SHA`);
	return value.toLowerCase();
}

function skip(source: string, at: number): number {
	const quote = source[at];
	if (quote === "'" || quote === '"' || quote === "`") {
		for (at++; at < source.length; at++) {
			if (source[at] === "\\") at++;
			else if (source[at] === quote) return at + 1;
		}
	}
	if (source.startsWith("//", at)) {
		const end = source.indexOf("\n", at + 2);
		return end === -1 ? source.length : end + 1;
	}
	if (source.startsWith("/*", at)) {
		const end = source.indexOf("*/", at + 2);
		return end === -1 ? source.length : end + 2;
	}
	return at;
}

function matching(source: string, open: number, left: string, right: string): number | undefined {
	let depth = 0;
	for (let at = open; at < source.length; at++) {
		const next = skip(source, at);
		if (next !== at) { at = next - 1; continue; }
		if (source[at] === left) depth++;
		if (source[at] === right && --depth === 0) return at + 1;
	}
}

/** Extract a TypeScript declaration with balanced delimiters; comments and strings do not affect its shape. */
export function declaration(source: string, name: string): string | undefined {
	const found = new RegExp(`(?:export\\s+)?(?:async\\s+)?(?:function|class|interface|type|const)\\s+${name}\\b|(?:async\\s+)?${name}\\s*\\(`).exec(source);
	if (!found || found.index === undefined) return undefined;
	const start = found.index;
	const from = start + found[0].length;
	if (found[0].includes("const ")) {
		const end = source.indexOf(";", from);
		return end === -1 ? undefined : source.slice(start, end + 1);
	}
	const paren = source.indexOf("(", from - 1);
	const brace = source.indexOf("{", from - 1);
	if (paren !== -1 && (brace === -1 || paren < brace)) {
		const params = matching(source, paren, "(", ")");
		if (!params) return undefined;
		const body = source.indexOf("{", params);
		if (body === -1) return source.slice(start, source.indexOf(";", params) + 1);
		const end = matching(source, body, "{", "}");
		return end === undefined ? undefined : source.slice(start, end);
	}
	if (brace !== -1) {
		const end = matching(source, brace, "{", "}");
		return end === undefined ? undefined : source.slice(start, end);
	}
	const end = source.indexOf(";", from);
	return end === -1 ? undefined : source.slice(start, end + 1);
}

function generation(source: string, name: string): number | undefined {
	const value = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(\\d+)\\s*;`).exec(source)?.[1];
	return value === undefined ? undefined : Number(value);
}

export function evaluate(
	base: ReadonlyMap<string, string | undefined>,
	head: ReadonlyMap<string, string | undefined>,
	inventory: Inventory = protectedInventory,
): { protectedChanges: string[]; telegramGenerationBumped: boolean; chatGenerationBumped: boolean } {
	const protectedChanges: string[] = [];
	for (const [family, files] of Object.entries(inventory) as [Family, Inventory[Family]][]) {
		for (const [file, symbols] of Object.entries(files)) {
			for (const symbol of symbols) {
				if (declaration(base.get(file) ?? "", symbol) !== declaration(head.get(file) ?? "", symbol))
					protectedChanges.push(`${family}:${file}:${symbol}`);
			}
		}
	}
	const oldTelegramGeneration = generation(base.get(telegramContract) ?? "", "DAEMON_GENERATION") ?? 0;
	const newTelegramGeneration = generation(head.get(telegramContract) ?? "", "DAEMON_GENERATION");
	const oldChatGeneration = generation(base.get(chatControl) ?? "", "CHAT_DAEMON_GENERATION") ?? 0;
	const newChatGeneration = generation(head.get(chatControl) ?? "", "CHAT_DAEMON_GENERATION");
	const telegramGenerationBumped = newTelegramGeneration !== undefined && newTelegramGeneration > oldTelegramGeneration;
	const chatGenerationBumped = newChatGeneration !== undefined && newChatGeneration > oldChatGeneration;
	return { protectedChanges, telegramGenerationBumped, chatGenerationBumped };
}

async function git(args: string[]): Promise<string> {
	const result = await $`git ${args}`.cwd(root).quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
	return result.stdout.toString();
}

async function verifyObject(name: string, sha: string): Promise<void> {
	const actual = (await git(["rev-parse", "--verify", `${sha}^{commit}`])).trim().toLowerCase();
	if (actual !== sha) throw new Error(`telegram-daemon-generation-guard: ${name} object is unavailable or does not resolve exactly to ${sha}`);
}

async function blob(revision: string, file: string): Promise<string | undefined> {
	const result = await $`git show ${`${revision}:${file}`}`.cwd(root).quiet().nothrow();
	if (result.exitCode === 0) return result.stdout.toString();
	if (result.stderr.toString().includes("does not exist")) return undefined;
	throw new Error(`telegram-daemon-generation-guard: unable to read ${file} from ${revision}`);
}

export async function run(baseInput: string | undefined, headInput: string | undefined): Promise<void> {
	const base = validateSha("base SHA", baseInput);
	const head = validateSha("head SHA", headInput);
	await verifyObject("base", base);
	await verifyObject("head", head);
	const files = [...new Set(Object.values(protectedInventory).flatMap(inventory => Object.keys(inventory)))];
	const [baseFiles, headFiles] = await Promise.all([
		Promise.all(files.map(async file => [file, await blob(base, file)] as const)),
		Promise.all(files.map(async file => [file, await blob(head, file)] as const)),
	]);
	const decision = evaluate(new Map(baseFiles), new Map(headFiles));
	const telegramChanges = decision.protectedChanges.filter(change => change.startsWith("telegram:"));
	const chatChanges = decision.protectedChanges.filter(change => change.startsWith("chat:"));
	if (telegramChanges.length > 0 && !decision.telegramGenerationBumped)
		throw new Error(`telegram-daemon-generation-guard: protected Telegram lifecycle change requires a strictly higher DAEMON_GENERATION: ${telegramChanges.join(", ")}`);
	if (chatChanges.length > 0 && !decision.chatGenerationBumped)
		throw new Error(`telegram-daemon-generation-guard: protected chat lifecycle change requires a strictly higher CHAT_DAEMON_GENERATION: ${chatChanges.join(", ")}`);
	console.log(`telegram-daemon-generation-guard: ${decision.protectedChanges.length === 0 ? "no protected changes" : "required generation bump verified"}`);
}

if (import.meta.main) {
	try { await run(process.env.GITHUB_BASE_SHA ?? process.argv[2], process.env.GITHUB_HEAD_SHA ?? process.argv[3]); }
	catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
