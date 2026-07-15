#!/usr/bin/env bun
import { $ } from "bun";
import { parse } from "@babel/parser";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const SHA = /^[0-9a-f]{40}$/i;
export const GUARD_CONTRACT_VERSION = 2;
const telegramContract = "packages/coding-agent/src/sdk/bus/telegram-daemon-contract.ts";
const chatControl = "packages/coding-agent/src/sdk/bus/chat-daemon-control.ts";

type Family = "telegram" | "discord" | "slack";
type Inventory = Readonly<Record<Family, Readonly<Record<string, readonly string[]>>>>;
type Declaration = { text: string; valid: boolean } | undefined;

/**
 * This is a deliberately small, exact lifecycle contract. Do not include session
 * endpoint or provider generations: they do not replace daemon owners.
 */
export const protectedInventory = {
	telegram: {
		[telegramContract]: ["DAEMON_GENERATION"],
		"packages/coding-agent/src/sdk/bus/notification-service.ts": ["daemonGenerationRelation"],
		"packages/coding-agent/src/sdk/bus/telegram-daemon.ts": [
			"TelegramDaemonOwnershipPhase",
			"DaemonState",
			"ownerIdentityMatches",
			"isReadyDaemonOwner",
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
			"stopOrReload",
			"spawnAndWait",
			"waitForPidDeath",
			"signalCapturedOwner",
			"clearOwnRequest",
		],
	},
	discord: {
		[chatControl]: [
			"CHAT_DAEMON_GENERATIONS",
			"chatDaemonGeneration",
			"ChatDaemonState",
			"readChatDaemonState",
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
		"packages/coding-agent/src/sdk/bus/discord-daemon.ts": ["DiscordNotificationDaemon", "start", "stop", "notify", "handleInbound", "close", "resume"],
	},
	slack: {
		[chatControl]: [
			"CHAT_DAEMON_GENERATIONS",
			"chatDaemonGeneration",
			"ChatDaemonState",
			"readChatDaemonState",
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
		"packages/coding-agent/src/sdk/bus/slack-daemon.ts": ["SlackNotificationDaemon", "start", "stop", "handleEnvelope", "postRoot", "notify", "close", "resume"],
	},
} as const satisfies Inventory;

function bootstrapGuardContract(): void {
	if (GUARD_CONTRACT_VERSION !== 2) throw new Error("telegram-daemon-generation-guard: unsupported guard contract version");
	for (const [family, files] of Object.entries(protectedInventory)) {
		for (const [file, symbols] of Object.entries(files)) {
			if (!file || symbols.length === 0 || new Set(symbols).size !== symbols.length)
				throw new Error(`telegram-daemon-generation-guard: invalid ${family} contract inventory`);
		}
	}
}

export function validateSha(name: string, value: string | undefined): string {
	if (!value || !SHA.test(value)) throw new Error(`telegram-daemon-generation-guard: ${name} must be an exact 40-hex commit SHA`);
	return value.toLowerCase();
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validateCiInputs(input: {
	eventName: "pull_request" | "push" | "workflow_dispatch";
	baseSha: string | undefined;
	headSha: string | undefined;
	baseRepository: string | undefined;
	headRepository: string | undefined;
	repository: string | undefined;
}): void {
	validateSha("base SHA", input.baseSha);
	validateSha("head SHA", input.headSha);
	for (const [name, value] of Object.entries({ baseRepository: input.baseRepository, headRepository: input.headRepository, repository: input.repository })) {
		if (!value || !REPOSITORY.test(value)) throw new Error(`telegram-daemon-generation-guard: ${name} must be an owner/repository name`);
	}
	if (input.baseRepository !== input.repository) throw new Error("telegram-daemon-generation-guard: base repository must be this repository");
	if ((input.eventName === "push" || input.eventName === "workflow_dispatch") && input.headRepository !== input.repository)
		throw new Error(`telegram-daemon-generation-guard: ${input.eventName} head repository must be this repository`);
}

function nodeName(node: any): string | undefined {
	if (node?.id?.type === "Identifier") return node.id.name;
	if (node?.key?.type === "Identifier") return node.key.name;
	if (node?.key?.type === "StringLiteral") return node.key.value;
}

function declarationNode(node: any, name: string): any | undefined {
	if (!node || typeof node !== "object") return undefined;
	if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") return declarationNode(node.declaration, name);
	if (node.type === "VariableDeclaration") {
		return node.declarations.some((declaration: any) => declaration.id?.type === "Identifier" && declaration.id.name === name)
			? node
			: undefined;
	}
	if (nodeName(node) === name && /(?:Declaration|Method|Property)$/.test(node.type)) return node;
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const child of value) {
				const found = declarationNode(child, name);
				if (found) return found;
			}
		} else if (value && typeof value === "object" && typeof (value as any).type === "string") {
			const found = declarationNode(value, name);
			if (found) return found;
		}
	}
}

/** AST-backed extraction prevents comments, strings, overloads, and similarly named text from matching. */
export function declaration(source: string, name: string): string | undefined {
	const result = extractDeclaration(source, name);
	return result?.text;
}

function extractDeclaration(source: string, name: string): Declaration {
	try {
		const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
		const node = declarationNode(ast.program, name);
		return node && typeof node.start === "number" && typeof node.end === "number"
			? { text: source.slice(node.start, node.end), valid: true }
			: undefined;
	} catch {
		return { text: "<malformed>", valid: false };
	}
}

function generation(source: string | undefined, kind?: "discord" | "slack"): number | undefined {
	if (!source) return undefined;
	try {
		const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
		const variable = declarationNode(ast.program, kind ? "CHAT_DAEMON_GENERATIONS" : "DAEMON_GENERATION");
		if (!variable) return undefined;
		if (!kind) {
			const declaration = variable.declarations?.find((item: any) => item.id?.name === "DAEMON_GENERATION");
			return declaration?.init?.type === "NumericLiteral" ? declaration.init.value : undefined;
		}
		const declaration = variable.declarations?.find((item: any) => item.id?.name === "CHAT_DAEMON_GENERATIONS");
		const object = declaration?.init?.type === "TSAsExpression" ? declaration.init.expression : declaration?.init;
		const property = object?.properties?.find((item: any) => nodeName(item) === kind);
		return property?.value?.type === "NumericLiteral" ? property.value.value : undefined;
	} catch {
		return undefined;
	}
}

export type Evaluation = {
	protectedChanges: string[];
	telegramGenerationBumped: boolean;
	chatGenerationBumped: Record<"discord" | "slack", boolean>;
	malformedDeclarations: string[];
};

export function evaluate(
	base: ReadonlyMap<string, string | undefined>,
	head: ReadonlyMap<string, string | undefined>,
	inventory: Inventory = protectedInventory,
): Evaluation {
	const protectedChanges: string[] = [];
	const malformedDeclarations: string[] = [];
	for (const [family, files] of Object.entries(inventory) as [Family, Inventory[Family]][]) {
		for (const [file, symbols] of Object.entries(files)) for (const symbol of symbols) {
			const before = extractDeclaration(base.get(file) ?? "", symbol);
			const after = extractDeclaration(head.get(file) ?? "", symbol);
			const label = `${family}:${file}:${symbol}`;
			if (!before?.valid || !after?.valid || !before || !after) malformedDeclarations.push(label);
			if (before?.text !== after?.text) protectedChanges.push(label);
		}
	}
	const oldTelegramGeneration = generation(base.get(telegramContract));
	const newTelegramGeneration = generation(head.get(telegramContract));
	const telegramGenerationBumped = oldTelegramGeneration !== undefined && newTelegramGeneration !== undefined && newTelegramGeneration > oldTelegramGeneration;
	const chatGenerationBumped = Object.fromEntries(
		(["discord", "slack"] as const).map(kind => {
			const before = generation(base.get(chatControl), kind);
			const after = generation(head.get(chatControl), kind);
			return [kind, before !== undefined && after !== undefined && after > before];
		}),
	) as Evaluation["chatGenerationBumped"];
	return { protectedChanges, telegramGenerationBumped, chatGenerationBumped, malformedDeclarations };
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
	bootstrapGuardContract();
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
	if (decision.malformedDeclarations.length > 0)
		throw new Error(`telegram-daemon-generation-guard: v${GUARD_CONTRACT_VERSION} protected declaration is missing or malformed: ${decision.malformedDeclarations.join(", ")}`);
	const telegramChanges = decision.protectedChanges.filter(change => change.startsWith("telegram:"));
	if (telegramChanges.length > 0 && !decision.telegramGenerationBumped)
		throw new Error(`telegram-daemon-generation-guard: protected Telegram lifecycle change requires a strictly higher DAEMON_GENERATION: ${telegramChanges.join(", ")}`);
	for (const kind of ["discord", "slack"] as const) {
		const changes = decision.protectedChanges.filter(change => change.startsWith(`${kind}:`));
		if (changes.length > 0 && !decision.chatGenerationBumped[kind])
			throw new Error(`telegram-daemon-generation-guard: protected ${kind} lifecycle change requires a strictly higher CHAT_DAEMON_GENERATIONS.${kind}: ${changes.join(", ")}`);
	}
	console.log(`telegram-daemon-generation-guard: v${GUARD_CONTRACT_VERSION} ${decision.protectedChanges.length === 0 ? "no protected changes" : "required generation bump verified"}`);
}

if (import.meta.main) {
	try { await run(process.env.GITHUB_BASE_SHA ?? process.argv[2], process.env.GITHUB_HEAD_SHA ?? process.argv[3]); }
	catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
