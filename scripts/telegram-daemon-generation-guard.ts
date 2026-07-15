#!/usr/bin/env bun
import { $ } from "bun";
import { parse } from "@babel/parser";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const SHA = /^[0-9a-f]{40}$/i;
export const GUARD_CONTRACT_VERSION = 4;
const telegramContract = "packages/coding-agent/src/sdk/bus/telegram-daemon-contract.ts";
const chatControl = "packages/coding-agent/src/sdk/bus/chat-daemon-control.ts";
const guardScript = "scripts/telegram-daemon-generation-guard.ts";


type Family = "telegram" | "discord" | "slack";
type Inventory = Readonly<Record<Family, Readonly<Record<string, readonly string[]>>>>;
 type Declaration = { text: string; canonical: string; valid: boolean } | undefined;

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
			"reloadForGenerationUpgrade",
			"spawnAndWait",
			"waitForPidDeath",
			"signalCapturedOwner",
			"clearOwnRequest",
		],
	},
	discord: {
		[chatControl]: [
			"ChatDaemonKind",
			"ChatDaemonAction",
			"CHAT_DAEMON_GENERATIONS",
			"chatDaemonGeneration",
			"ChatDaemonState",
			"chatDaemonPaths",
			"readChatDaemonState",
			"readChatDaemonControlRequest",
			"writeChatDaemonControlRequest",
			"clearChatDaemonControlRequest",
			"buildChatDaemonSpawnArgs",
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
			"withStateWriteLock",
			"acquireChatDaemonOwnership",
			"createChatDaemonOwnerLock",
			"reclaimChatDaemonOwnerLock",
			"acquireChatDaemonReclaimLock",
			"canReclaimChatDaemonOwnerLock",
			"isStaleChatDaemonLock",
			"releaseChatDaemonOwnership",
			"renewChatDaemonHeartbeat",
			"ensureDiscordDaemon",
			"ensureSlackDaemon",
		],
		"packages/coding-agent/src/sdk/bus/chat-daemon-cli.ts": ["runChatDaemonInternal"],
		"packages/coding-agent/src/sdk/bus/discord-daemon.ts": ["DiscordNotificationDaemon", "start", "stop", "notify", "handleInbound", "close", "resume"],
	},
	slack: {
		[chatControl]: [
			"ChatDaemonKind",
			"ChatDaemonAction",
			"CHAT_DAEMON_GENERATIONS",
			"chatDaemonGeneration",
			"ChatDaemonState",
			"chatDaemonPaths",
			"readChatDaemonState",
			"readChatDaemonControlRequest",
			"writeChatDaemonControlRequest",
			"clearChatDaemonControlRequest",
			"buildChatDaemonSpawnArgs",
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
			"withStateWriteLock",
			"acquireChatDaemonOwnership",
			"createChatDaemonOwnerLock",
			"reclaimChatDaemonOwnerLock",
			"acquireChatDaemonReclaimLock",
			"canReclaimChatDaemonOwnerLock",
			"isStaleChatDaemonLock",
			"releaseChatDaemonOwnership",
			"renewChatDaemonHeartbeat",
			"ensureDiscordDaemon",
			"ensureSlackDaemon",
		],
		"packages/coding-agent/src/sdk/bus/chat-daemon-cli.ts": ["runChatDaemonInternal"],
		"packages/coding-agent/src/sdk/bus/slack-daemon.ts": ["SlackNotificationDaemon", "start", "stop", "handleEnvelope", "postRoot", "notify", "close", "resume"],
	},
} as const satisfies Inventory;

export function validateInventory(inventory: Inventory = protectedInventory): void {
	if (GUARD_CONTRACT_VERSION !== 4) throw new Error("telegram-daemon-generation-guard: unsupported guard contract version");
	for (const [family, files] of Object.entries(inventory)) {
		for (const [file, symbols] of Object.entries(files)) {
			if (!file || symbols.length === 0 || new Set(symbols).size !== symbols.length)
				throw new Error(`telegram-daemon-generation-guard: invalid ${family} contract inventory`);
		}
	}
}

function bootstrapGuardContract(): void {
	validateInventory();
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

const AST_METADATA = new Set(["start", "end", "loc", "comments", "leadingComments", "trailingComments", "innerComments", "extra"]);

function canonicalAst(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalAst);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key]) => !AST_METADATA.has(key))
			.map(([key, child]) => [key, canonicalAst(child)]),
	);
}

function canonicalSource(source: string): string | undefined {
	try {
		return JSON.stringify(canonicalAst(parse(source, { sourceType: "module", plugins: ["typescript"] }).program));
	} catch {
		return undefined;
	}
}

function extractDeclaration(source: string, name: string): Declaration {
	try {
		const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
		const node = declarationNode(ast.program, name);
		return node && typeof node.start === "number" && typeof node.end === "number"
			? { text: source.slice(node.start, node.end), canonical: JSON.stringify(canonicalAst(node)), valid: true }
			: undefined;
	} catch {
		return { text: "<malformed>", canonical: "<malformed>", valid: false };
	}
}

function extractDeclarations(source: string, names: readonly string[]): Map<string, Declaration> {
	try {
		const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
		return new Map(
			names.map(name => {
				const node = declarationNode(ast.program, name);
				return [
					name,
					node && typeof node.start === "number" && typeof node.end === "number"
						? { text: source.slice(node.start, node.end), canonical: JSON.stringify(canonicalAst(node)), valid: true }
						: undefined,
				] as const;
			}),
		);
	} catch {
		return new Map(names.map(name => [name, { text: "<malformed>", canonical: "<malformed>", valid: false }] as const));
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

function guardContractVersion(source: string | undefined): number | undefined {
	if (!source) return undefined;
	try {
		const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
		const variable = declarationNode(ast.program, "GUARD_CONTRACT_VERSION");
		const declaration = variable?.declarations?.find((item: any) => item.id?.name === "GUARD_CONTRACT_VERSION");
		return declaration?.init?.type === "NumericLiteral" ? declaration.init.value : undefined;
	} catch {
		return undefined;
	}
}


export type Evaluation = {
	protectedChanges: string[];
	telegramGenerationBumped: boolean;
	chatGenerationBumped: Record<"discord" | "slack", boolean>;
	malformedDeclarations: string[];
	guardPolicyChanged: boolean;
	guardContractBumped: boolean;
};

export function evaluate(
	base: ReadonlyMap<string, string | undefined>,
	head: ReadonlyMap<string, string | undefined>,
	inventory: Inventory = protectedInventory,
): Evaluation {
	const protectedChanges: string[] = [];
	const malformedDeclarations: string[] = [];
	const bootstrapping = base.get(guardScript) === undefined;
	for (const [family, files] of Object.entries(inventory) as [Family, Inventory[Family]][]) {
		for (const [file, symbols] of Object.entries(files)) {
			const beforeDeclarations = extractDeclarations(base.get(file) ?? "", symbols);
			const afterDeclarations = extractDeclarations(head.get(file) ?? "", symbols);
			for (const symbol of symbols) {
				const before = beforeDeclarations.get(symbol);
				const after = afterDeclarations.get(symbol);
				const label = `${family}:${file}:${symbol}`;
				if (!after?.valid || !after || (!bootstrapping && (!before?.valid || !before)))
					malformedDeclarations.push(label);
				if (before?.canonical !== after?.canonical) protectedChanges.push(label);
			}
		}
	}
	const guardPolicyChanged = !bootstrapping && canonicalSource(base.get(guardScript) ?? "") !== canonicalSource(head.get(guardScript) ?? "");
	const baseGuardContractVersion = guardContractVersion(base.get(guardScript));
	const headGuardContractVersion = guardContractVersion(head.get(guardScript));
	const guardContractBumped =
		headGuardContractVersion !== undefined &&
		(headGuardContractVersion > (baseGuardContractVersion ?? Number.POSITIVE_INFINITY));

	const oldTelegramGeneration = generation(base.get(telegramContract));
	const newTelegramGeneration = generation(head.get(telegramContract));
	const telegramGenerationBumped =
		newTelegramGeneration !== undefined && newTelegramGeneration > (oldTelegramGeneration ?? (bootstrapping ? 0 : Number.POSITIVE_INFINITY));
	const chatGenerationBumped = Object.fromEntries(
		(["discord", "slack"] as const).map(kind => {
			const before = generation(base.get(chatControl), kind);
			const after = generation(head.get(chatControl), kind);
			return [
				kind,
				after !== undefined && after > (before ?? (bootstrapping ? 0 : Number.POSITIVE_INFINITY)),
			];
		}),
	) as Evaluation["chatGenerationBumped"];
	return { protectedChanges, telegramGenerationBumped, chatGenerationBumped, malformedDeclarations, guardPolicyChanged, guardContractBumped };
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
	if (result.exitCode === 128 || result.stderr.toString().includes("does not exist")) return undefined;
	throw new Error(`telegram-daemon-generation-guard: unable to read ${file} from ${revision}`);
}

export async function run(baseInput: string | undefined, headInput: string | undefined): Promise<void> {
	bootstrapGuardContract();
	const base = validateSha("base SHA", baseInput);
	const head = validateSha("head SHA", headInput);
	const eventName = process.env.GUARD_EVENT_NAME;
	if (eventName) {
		if (eventName !== "pull_request" && eventName !== "push" && eventName !== "workflow_dispatch")
			throw new Error("telegram-daemon-generation-guard: unsupported CI event");
		validateCiInputs({
			eventName,
			baseSha: baseInput,
			headSha: headInput,
			baseRepository: process.env.BASE_REPOSITORY,
			headRepository: process.env.HEAD_REPOSITORY,
			repository: process.env.GUARD_REPOSITORY,
		});
	}
	await verifyObject("base", base);
	await verifyObject("head", head);
	if (process.env.GJC_DAEMON_GUARD_DEBUG === "1") console.error("daemon-generation-guard: objects verified");
	const files = [guardScript, ...new Set(Object.values(protectedInventory).flatMap(inventory => Object.keys(inventory)))];
	const baseFiles: Array<readonly [string, string | undefined]> = [];
	const headFiles: Array<readonly [string, string | undefined]> = [];
	for (const file of files) {
		baseFiles.push([file, await blob(base, file)]);
		headFiles.push([file, await blob(head, file)]);
	}
	if (process.env.GJC_DAEMON_GUARD_DEBUG === "1") {
		for (const [file, source] of headFiles) console.error(`daemon-generation-guard: head ${file} ${source?.length ?? -1}`);
		console.error(`daemon-generation-guard: base-guard ${baseFiles.find(([file]) => file === guardScript)?.[1]?.length ?? -1}`);
	}
	if (process.env.GJC_DAEMON_GUARD_DEBUG === "1") console.error("daemon-generation-guard: blobs loaded");
	const baseMap = new Map(baseFiles);
	const decision = evaluate(baseMap, new Map(headFiles));
	if (process.env.GJC_DAEMON_GUARD_DEBUG === "1") console.error("daemon-generation-guard: declarations evaluated");
	if (baseMap.get(guardScript) !== undefined && decision.guardPolicyChanged && !decision.guardContractBumped)
		throw new Error(`telegram-daemon-generation-guard: guard policy change requires a strictly higher GUARD_CONTRACT_VERSION`);
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
