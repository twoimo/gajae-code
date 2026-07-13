/**
 * Notify CLI command handlers.
 *
 * Handles `gjc notify` setup/status and the hidden daemon entrypoint.
 */
import { createInterface } from "node:readline/promises";
import { APP_NAME } from "@gajae-code/utils/dirs";
import chalk from "chalk";
import { Settings } from "../config/settings";
import { type EnsureChatDaemonResult, ensureDiscordDaemon, ensureSlackDaemon } from "../sdk/bus/chat-daemon-control";
import { maskToken } from "../sdk/bus/config";
import {
	buildNotificationStatusReport,
	checkNotificationHealth,
	formatNotificationHealthReport,
	formatNotificationRecoveryReport,
	formatNotificationStatusReport,
	formatNotificationTestResult,
	recoverNotifications,
	sendNotificationTest,
} from "../sdk/bus/notification-service";
import { runDaemonInternal } from "../sdk/bus/telegram-daemon-cli";

export type NotifyAction = "setup" | "status" | "health" | "test" | "recovery" | "daemon-internal";
export type NotifySetupProvider = "telegram" | "discord" | "slack";

export interface NotifyCommandArgs {
	action: NotifyAction;
	smoke?: boolean;
	rawArgs: string[];
	provider?: NotifySetupProvider;
	token?: string;
	chatId?: string;
	discordBotToken?: string;
	discordApplicationId?: string;
	discordGuildId?: string;
	discordParentChannelId?: string;
	slackBotToken?: string;
	slackAppToken?: string;
	slackWorkspaceId?: string;
	slackChannelId?: string;
	slackAuthorizedUserId?: string;
	redact?: boolean;
	probe?: boolean;
	message?: string;
}

export interface NotifyCommandDeps {
	fetchImpl?: typeof fetch;
	apiBase?: string;
	settings?: Settings;
	setupToken?: string;
	pollTimeoutMs?: number;
	pollIntervalMs?: number;
	setupChatId?: string;
	setupRedact?: boolean;
	setupInteractive?: boolean;
	threadedModePrompt?: (message: string) => Promise<string>;
	tokenPrompt?: () => Promise<string>;
	setExitCode?: (code: number) => void;
	exitProcess?: (code: number) => void;
	ensureProviderDaemon?: (
		provider: "discord" | "slack",
		settings: Settings,
	) => Promise<EnsureChatDaemonResult | "failed">;
}

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
}

interface TelegramUpdate {
	update_id: number;
	message?: {
		chat?: {
			id?: number | string;
			type?: string;
		};
	};
}

interface TelegramUser {
	id: number;
	is_bot?: boolean;
	first_name?: string;
	username?: string;
	has_topics_enabled?: boolean;
	allows_users_to_create_topics?: boolean;
}

interface TelegramChat {
	id?: number | string;
	type?: string;
}

type ThreadedModeState = "enabled" | "disabled" | "unknown";
type ThreadedModeFinalLabel = "verified" | "unverified" | "unknown";

const DEFAULT_API_BASE = "https://api.telegram.org";
const DEFAULT_POLL_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export function parseNotifyArgs(args: string[]): NotifyCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "notify") {
		return undefined;
	}

	const action = args[1];
	if (action === "setup" || action === "status") {
		const rest = args.slice(2);
		const flag = (name: string): string | undefined => {
			const i = rest.indexOf(name);
			return i >= 0 ? rest[i + 1] : undefined;
		};
		const provider = rest[0]?.startsWith("--") ? undefined : rest[0];
		if (provider !== undefined && provider !== "telegram" && provider !== "discord" && provider !== "slack") {
			return undefined;
		}
		return {
			action,
			rawArgs: rest,
			...(provider ? { provider } : {}),
			token: flag("--token"),
			chatId: flag("--chat-id"),
			...(flag("--discord-bot-token") ? { discordBotToken: flag("--discord-bot-token") } : {}),
			...(flag("--discord-application-id") ? { discordApplicationId: flag("--discord-application-id") } : {}),
			...(flag("--discord-guild-id") ? { discordGuildId: flag("--discord-guild-id") } : {}),
			...(flag("--discord-parent-channel-id")
				? { discordParentChannelId: flag("--discord-parent-channel-id") }
				: {}),
			...(flag("--slack-bot-token") ? { slackBotToken: flag("--slack-bot-token") } : {}),
			...(flag("--slack-app-token") ? { slackAppToken: flag("--slack-app-token") } : {}),
			...(flag("--slack-workspace-id") ? { slackWorkspaceId: flag("--slack-workspace-id") } : {}),
			...(flag("--slack-channel-id") ? { slackChannelId: flag("--slack-channel-id") } : {}),
			...(flag("--slack-authorized-user-id") ? { slackAuthorizedUserId: flag("--slack-authorized-user-id") } : {}),
			redact: rest.includes("--redact"),
		};
	}
	if (action === "health" || action === "test" || action === "recovery") {
		const rest = args.slice(2);
		const flag = (name: string): string | undefined => {
			const i = rest.indexOf(name);
			return i >= 0 ? rest[i + 1] : undefined;
		};
		return {
			action,
			rawArgs: rest,
			probe: rest.includes("--probe"),
			message: flag("--message"),
		};
	}
	if (action === "daemon-internal") {
		return {
			action,
			smoke: args.slice(2).includes("--smoke"),
			rawArgs: args.slice(2),
		};
	}

	return { action: "status", rawArgs: args.slice(1) };
}

export async function runNotifyCommand(cmd: NotifyCommandArgs, deps: NotifyCommandDeps = {}): Promise<void> {
	switch (cmd.action) {
		case "setup":
			await runSetup(cmd, {
				...deps,
				setupToken: deps.setupToken ?? cmd.token,
				setupChatId: deps.setupChatId ?? cmd.chatId,
				setupRedact: deps.setupRedact ?? cmd.redact,
			});
			return;
		case "status":
			await runStatus(deps);
			return;
		case "health":
			await runHealth(deps, cmd);
			return;
		case "test":
			await runTest(deps, cmd);
			return;
		case "recovery":
			await runRecovery(deps);
			return;
		case "daemon-internal":
			if (cmd.smoke) {
				await runDaemonInternal(["--smoke"]);
			} else {
				await runDaemonInternal(cmd.rawArgs);
			}
			return;
	}
}

export async function runNotifyCliCommand(cmd: NotifyCommandArgs, deps: NotifyCommandDeps = {}): Promise<void> {
	try {
		await runNotifyCommand(cmd, deps);
	} catch (error) {
		if (cmd.action !== "setup" || !(error instanceof Error)) {
			throw error;
		}

		const cancelled = error.message === "Telegram bot token prompt cancelled.";
		process.stderr.write(cancelled ? "Notify setup cancelled.\n" : `Error: ${error.message}\n`);
		const code = cancelled ? 130 : 1;
		if (deps.setExitCode) {
			deps.setExitCode(code);
		} else {
			process.exitCode = code;
		}
		const exitProcess = deps.exitProcess ?? (deps.setExitCode ? undefined : process.exit);
		exitProcess?.(code);
	}
}

async function getSettings(deps: NotifyCommandDeps): Promise<Settings> {
	if (deps.settings) return deps.settings;
	return await Settings.init();
}

async function runSetup(cmd: NotifyCommandArgs, deps: NotifyCommandDeps): Promise<void> {
	const provider = cmd.provider ?? "telegram";
	if (provider === "discord") {
		await runDiscordSetup(cmd, deps);
		return;
	}
	if (provider === "slack") {
		await runSlackSetup(cmd, deps);
		return;
	}
	await runTelegramSetup(cmd, deps);
}

function requiredSetupValue(value: string | undefined, flag: string): string {
	if (!value?.trim()) throw new Error(`${flag} is required for non-interactive setup.`);
	return value.trim();
}

async function runDiscordSetup(cmd: NotifyCommandArgs, deps: NotifyCommandDeps): Promise<void> {
	const botToken = requiredSetupValue(cmd.discordBotToken, "--discord-bot-token");
	const applicationId = requiredSetupValue(cmd.discordApplicationId, "--discord-application-id");
	const guildId = requiredSetupValue(cmd.discordGuildId, "--discord-guild-id");
	const parentChannelId = requiredSetupValue(cmd.discordParentChannelId, "--discord-parent-channel-id");
	const settings = await getSettings(deps);
	settings.set("notifications.discord.botToken", botToken);
	settings.set("notifications.discord.applicationId", applicationId);
	settings.set("notifications.discord.guildId", guildId);
	settings.set("notifications.discord.parentChannelId", parentChannelId);
	settings.set("notifications.enabled", true);
	if (cmd.redact) settings.set("notifications.redact", true);
	await settings.flushOrThrow();
	const daemon = await ensureConfiguredProviderDaemon("discord", settings, deps);
	process.stdout.write(
		`Discord notifications enabled. botToken=${maskToken(botToken)} applicationId=${applicationId} guildId=${guildId} parentChannelId=${parentChannelId} daemon=${daemon}\n`,
	);
}

async function runSlackSetup(cmd: NotifyCommandArgs, deps: NotifyCommandDeps): Promise<void> {
	const botToken = requiredSetupValue(cmd.slackBotToken, "--slack-bot-token");
	const appToken = requiredSetupValue(cmd.slackAppToken, "--slack-app-token");
	const workspaceId = requiredSetupValue(cmd.slackWorkspaceId, "--slack-workspace-id");
	const channelId = requiredSetupValue(cmd.slackChannelId, "--slack-channel-id");
	const authorizedUserId = cmd.slackAuthorizedUserId?.trim() || undefined;
	const settings = await getSettings(deps);
	settings.set("notifications.slack.botToken", botToken);
	settings.set("notifications.slack.appToken", appToken);
	settings.set("notifications.slack.workspaceId", workspaceId);
	settings.set("notifications.slack.channelId", channelId);
	settings.set("notifications.slack.authorizedUserId", authorizedUserId);
	settings.set("notifications.enabled", true);
	if (cmd.redact) settings.set("notifications.redact", true);
	await settings.flushOrThrow();
	const daemon = await ensureConfiguredProviderDaemon("slack", settings, deps);
	process.stdout.write(
		`Slack notifications enabled. botToken=${maskToken(botToken)} appToken=${maskToken(appToken)} workspaceId=${workspaceId} channelId=${channelId} authorizedUserId=${authorizedUserId ?? "(unset; inbound denied)"} daemon=${daemon}\n`,
	);
}

async function ensureConfiguredProviderDaemon(
	provider: "discord" | "slack",
	settings: Settings,
	deps: NotifyCommandDeps,
): Promise<EnsureChatDaemonResult | "failed"> {
	try {
		if (deps.ensureProviderDaemon) return await deps.ensureProviderDaemon(provider, settings);
		return provider === "discord" ? await ensureDiscordDaemon(settings) : await ensureSlackDaemon(settings);
	} catch {
		return "failed";
	}
}

async function runTelegramSetup(cmd: NotifyCommandArgs, deps: NotifyCommandDeps): Promise<void> {
	const settings = await getSettings(deps);
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const apiBase = deps.apiBase ?? DEFAULT_API_BASE;
	const token = deps.setupToken ?? cmd.token ?? (await (deps.tokenPrompt ?? promptForToken)());
	if (!token.trim()) throw new Error("Telegram bot token is required.");

	const user = await getMe(fetchImpl, apiBase, token);
	const threadedState = await verifyThreadedMode(fetchImpl, apiBase, token, user, {
		interactive: resolveSetupInteractive(deps),
		prompt: deps.threadedModePrompt ?? promptForThreadedMode,
	});
	process.stdout.write(
		"Token validated. Message your bot now from the private Telegram chat to pair notifications.\n",
	);

	let chatId: string;
	const suppliedChatId = deps.setupChatId ?? cmd.chatId;
	if (suppliedChatId?.trim()) {
		chatId = suppliedChatId.trim();
		await verifyPrivateChatId(fetchImpl, apiBase, token, chatId);
		process.stdout.write(`Using provided chat id ${chatId} (non-interactive).\n`);
	} else {
		const stale = await getUpdates(fetchImpl, apiBase, token, { timeout: 0, allowed_updates: ["message"] });
		chatId = await waitForPrivateChat(fetchImpl, apiBase, token, {
			offset: nextOffset(stale),
			pollTimeoutMs: deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
			pollIntervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
		});
	}
	settings.set("notifications.telegram.botToken", token);
	settings.set("notifications.telegram.chatId", chatId);
	settings.set("notifications.enabled", true);
	if (deps.setupRedact ?? cmd.redact) settings.set("notifications.redact", true);
	await settings.flushOrThrow();
	process.stdout.write(
		`Notifications enabled. botToken=${maskToken(token)} chatId=${chatId} threaded=${threadedLabel(threadedState)}\n`,
	);
}

type TokenPromptInput = NodeJS.ReadStream & {
	isRaw?: boolean;
	setRawMode?: (mode: boolean) => unknown;
	pause?: () => unknown;
};

type TokenPromptOutput = Pick<NodeJS.WriteStream, "write">;

export async function promptForToken(
	input: TokenPromptInput = process.stdin,
	output: TokenPromptOutput = process.stdout,
): Promise<string> {
	if (!input.isTTY) {
		throw new Error("notify setup requires an interactive TTY unless setupToken is injected.");
	}
	if (typeof input.setRawMode !== "function") {
		throw new Error("notify setup requires a TTY with raw input support unless setupToken is injected.");
	}

	output.write("Telegram BotFather token: ");
	const wasRaw = input.isRaw === true;
	input.setRawMode(true);

	return await new Promise<string>((resolve, reject) => {
		let value = "";
		let settled = false;

		const cleanup = () => {
			input.off("data", onData);
			input.off("error", onError);
			input.setRawMode?.(wasRaw);
			input.pause?.();
			output.write("\n");
		};

		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};

		const accept = () => finish(() => resolve(value.trim()));
		const cancel = () => finish(() => reject(new Error("Telegram bot token prompt cancelled.")));
		const onError = (error: Error) => finish(() => reject(error));
		const onData = (chunk: Buffer | string) => {
			for (const char of String(chunk)) {
				if (char === "\r" || char === "\n") {
					accept();
					return;
				}
				if (char === "\u0003") {
					cancel();
					return;
				}
				if (char === "\u0004") {
					if (value) accept();
					else cancel();
					return;
				}
				if (char === "\u007f" || char === "\b") {
					value = value.slice(0, -1);
					continue;
				}
				if (char >= " ") value += char;
			}
		};

		input.on("data", onData);
		input.once("error", onError);
		input.resume();
	});
}

const THREADED_ENABLED_SUCCESS =
	"Telegram Threaded Mode capability verified for this bot. GJC will request a private-chat topic per session; if Telegram ever refuses topic creation, notifications fall back to this flat chat with inline ask buttons only and a one-time Threaded Mode nudge.\n";

const THREADED_MISSING_WARNING =
	"Warning: Telegram getMe did not include has_topics_enabled, so GJC cannot verify private-chat Threaded Mode capability for this bot. Setup will continue; flat private-chat fallback supports outbound notifications and inline ask buttons only. Free-text replies and session commands require Threaded Mode/topic routing.\n";

const THREADED_NONINTERACTIVE_WARNING =
	"Warning: Telegram Threaded Mode capability is OFF for this bot. Setup will be saved because this run is non-interactive. Flat private-chat fallback supports outbound notifications and inline ask buttons only; free-text replies and session commands require enabling Threaded Mode in @BotFather > Bot Settings > Threads Settings.\n";

const THREADED_DISABLED_GUIDANCE =
	"Telegram Threaded Mode is OFF for this bot. GJC needs Telegram private-chat topics so each session can use its own thread.\n" +
	"GJC cannot enable this through the Bot API. Open @BotFather > Bot Settings > Threads Settings for this bot, enable Threaded Mode / forum topics for private chats, then return here.\n" +
	"Without Threaded Mode, flat private-chat fallback supports outbound notifications and inline ask buttons only; free-text replies and session commands require topic routing.\n";

const THREADED_DISABLED_PROMPT =
	"Press Enter after enabling Threaded Mode, or type skip to finish setup with a warning: ";

const THREADED_STILL_OFF = "Telegram still reports Threaded Mode OFF for this bot.\n";

const THREADED_RETRY_PROMPT = "Press Enter to check again, or type skip to finish setup with a warning: ";

const THREADED_SKIP_WARNING =
	"Warning: continuing without verified Telegram Threaded Mode capability. Setup will be saved. Flat private-chat fallback supports outbound notifications and inline ask buttons only; free-text replies and session commands require enabling Threaded Mode in BotFather.\n";

const THREADED_INVALID_INPUT = "Type Enter to retry or skip to continue with a warning.\n";

const THREADED_RETRY_INPUTS = new Set(["", "y", "yes", "r", "retry"]);
const THREADED_SKIP_INPUTS = new Set(["s", "skip", "n", "no"]);

function isTelegramUser(value: unknown): value is TelegramUser {
	return Boolean(value) && typeof value === "object" && typeof (value as { id?: unknown }).id === "number";
}

async function getMe(fetchImpl: typeof fetch, apiBase: string, token: string): Promise<TelegramUser> {
	const user = await callTelegram<unknown>(fetchImpl, apiBase, token, "getMe", {});
	if (!isTelegramUser(user)) {
		throw new Error("Telegram getMe returned invalid Telegram response: missing valid User result.");
	}
	return user;
}

async function verifyPrivateChatId(
	fetchImpl: typeof fetch,
	apiBase: string,
	token: string,
	chatId: string,
): Promise<void> {
	const chat = (await callTelegram<unknown>(fetchImpl, apiBase, token, "getChat", { chat_id: chatId })) as
		| TelegramChat
		| undefined;
	if (!chat || typeof chat !== "object") {
		throw new Error("Telegram getChat returned invalid Telegram response: missing valid Chat result.");
	}
	if (chat.type !== "private") {
		const type = typeof chat.type === "string" && chat.type ? chat.type : "unknown";
		throw new Error(`Provided chat id ${chatId} is a ${type} chat; pairing requires a private Telegram chat.`);
	}
}

function threadedModeState(user: TelegramUser): ThreadedModeState {
	if (user.has_topics_enabled === true) return "enabled";
	if (user.has_topics_enabled === false) return "disabled";
	return "unknown";
}

function threadedLabel(state: ThreadedModeState): ThreadedModeFinalLabel {
	if (state === "enabled") return "verified";
	if (state === "disabled") return "unverified";
	return "unknown";
}

function resolveSetupInteractive(deps: NotifyCommandDeps): boolean {
	if (deps.setupInteractive !== undefined) return deps.setupInteractive;
	return Boolean(process.stdin.isTTY) && !deps.setupChatId?.trim();
}

async function promptForThreadedMode(message: string): Promise<string> {
	if (!process.stdin.isTTY) return "skip";
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	try {
		return (await rl.question(message)).trim();
	} finally {
		rl.close();
	}
}

async function verifyThreadedMode(
	fetchImpl: typeof fetch,
	apiBase: string,
	token: string,
	initialUser: TelegramUser,
	opts: { interactive: boolean; prompt: (message: string) => Promise<string> },
): Promise<ThreadedModeState> {
	const classify = (user: TelegramUser): ThreadedModeState | undefined => {
		const state = threadedModeState(user);
		if (state === "enabled") {
			process.stdout.write(THREADED_ENABLED_SUCCESS);
			return "enabled";
		}
		if (state === "unknown") {
			process.stdout.write(THREADED_MISSING_WARNING);
			return "unknown";
		}
		return undefined;
	};

	const initial = classify(initialUser);
	if (initial) return initial;

	if (!opts.interactive) {
		process.stdout.write(THREADED_NONINTERACTIVE_WARNING);
		return "disabled";
	}

	process.stdout.write(THREADED_DISABLED_GUIDANCE);
	let firstPrompt = true;
	for (;;) {
		const answer = (await opts.prompt(firstPrompt ? THREADED_DISABLED_PROMPT : THREADED_RETRY_PROMPT))
			.trim()
			.toLowerCase();
		firstPrompt = false;
		if (THREADED_SKIP_INPUTS.has(answer)) {
			process.stdout.write(THREADED_SKIP_WARNING);
			return "disabled";
		}
		if (!THREADED_RETRY_INPUTS.has(answer)) {
			process.stdout.write(THREADED_INVALID_INPUT);
			continue;
		}
		const resolved = classify(await getMe(fetchImpl, apiBase, token));
		if (resolved) return resolved;
		process.stdout.write(THREADED_STILL_OFF);
	}
}

async function runStatus(deps: NotifyCommandDeps): Promise<void> {
	const settings = await getSettings(deps);
	const report = buildNotificationStatusReport(settings);
	process.stdout.write(
		`${chalk.bold("Notifications")}\n${formatNotificationStatusReport(report).split("\n").slice(1).join("\n")}\n`,
	);
}

async function runHealth(deps: NotifyCommandDeps, cmd: NotifyCommandArgs): Promise<void> {
	const settings = await getSettings(deps);
	const report = await checkNotificationHealth({
		settings,
		probe: cmd.probe,
		deps: { fetchImpl: deps.fetchImpl, apiBase: deps.apiBase },
	});
	process.stdout.write(`${formatNotificationHealthReport(report)}\n`);
	if (report.overall === "error" && deps.setExitCode) deps.setExitCode(1);
	else if (report.overall === "error") process.exitCode = 1;
}

async function runTest(deps: NotifyCommandDeps, cmd: NotifyCommandArgs): Promise<void> {
	const settings = await getSettings(deps);
	const result = await sendNotificationTest({
		settings,
		text: cmd.message,
		deps: { fetchImpl: deps.fetchImpl, apiBase: deps.apiBase },
	});
	process.stdout.write(`${formatNotificationTestResult(result)}\n`);
	if (!result.ok && deps.setExitCode) deps.setExitCode(1);
	else if (!result.ok) process.exitCode = 1;
}

async function runRecovery(deps: NotifyCommandDeps): Promise<void> {
	const settings = await getSettings(deps);
	const report = await recoverNotifications({ settings });
	process.stdout.write(`${formatNotificationRecoveryReport(report)}\n`);
}

async function waitForPrivateChat(
	fetchImpl: typeof fetch,
	apiBase: string,
	token: string,
	opts: { offset: number | undefined; pollTimeoutMs: number; pollIntervalMs: number },
): Promise<string> {
	const deadline = Date.now() + opts.pollTimeoutMs;
	let offset = opts.offset;
	let sawRejectedChatType: string | undefined;

	while (Date.now() <= deadline) {
		const updates = await getUpdates(fetchImpl, apiBase, token, { offset, timeout: 0, allowed_updates: ["message"] });
		offset = nextOffset(updates, offset);
		for (const update of updates) {
			const chat = update.message?.chat;
			if (!chat) continue;
			if (chat.type === "private" && chat.id !== undefined) {
				return String(chat.id);
			}
			if (chat.type === "group" || chat.type === "supergroup" || chat.type === "channel") {
				sawRejectedChatType = chat.type;
				process.stderr.write(
					`Rejected ${chat.type} chat. Pairing requires a private Telegram chat with the bot.\n`,
				);
			}
		}
		if (opts.pollIntervalMs > 0) {
			await new Promise(resolve =>
				setTimeout(resolve, Math.min(opts.pollIntervalMs, Math.max(0, deadline - Date.now()))),
			);
		}
	}

	if (sawRejectedChatType) {
		throw new Error(`Pairing rejected ${sawRejectedChatType} chat; message the bot from a private chat.`);
	}
	throw new Error("Timed out waiting for a private Telegram message to pair notifications.");
}

function nextOffset(updates: TelegramUpdate[], fallback?: number): number | undefined {
	let max = fallback === undefined ? undefined : fallback - 1;
	for (const update of updates) {
		if (typeof update.update_id === "number" && (max === undefined || update.update_id > max)) {
			max = update.update_id;
		}
	}
	return max === undefined ? fallback : max + 1;
}

async function getUpdates(
	fetchImpl: typeof fetch,
	apiBase: string,
	token: string,
	params: Record<string, unknown>,
): Promise<TelegramUpdate[]> {
	return await callTelegram<TelegramUpdate[]>(fetchImpl, apiBase, token, "getUpdates", params);
}

async function callTelegram<T>(
	fetchImpl: typeof fetch,
	apiBase: string,
	token: string,
	method: string,
	body: Record<string, unknown>,
): Promise<T> {
	const response = await fetchImpl(`${apiBase.replace(/\/$/, "")}/bot${token}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	let payload: TelegramApiResponse<T>;
	try {
		payload = (await response.json()) as TelegramApiResponse<T>;
	} catch {
		throw new Error(`Telegram ${method} returned invalid JSON.`);
	}
	if (!response.ok || !payload.ok) {
		throw new Error(`Telegram ${method} failed: ${payload.description ?? response.statusText}`);
	}
	return payload.result as T;
}

export function printNotifyHelp(): void {
	process.stdout.write(`${chalk.bold(`${APP_NAME} notify`)} - Configure Telegram, Discord, or Slack notifications

${chalk.bold("Usage:")}
  ${APP_NAME} notify setup [telegram]
  ${APP_NAME} notify setup discord --discord-bot-token <token> --discord-application-id <id> --discord-guild-id <id> --discord-parent-channel-id <id>
  ${APP_NAME} notify setup slack --slack-bot-token <token> --slack-app-token <token> --slack-workspace-id <id> --slack-channel-id <id> [--slack-authorized-user-id <id>]
  ${APP_NAME} notify status
  ${APP_NAME} notify health [--probe]
  ${APP_NAME} notify test [--message <text>]
  ${APP_NAME} notify recovery

${chalk.bold("Subcommands:")}
  setup     Pair Telegram or save complete non-interactive Discord/Slack notification settings
  status    Show notification configuration without secrets
  health    Report config, daemon-ownership and endpoint health (--probe adds a Telegram reachability check)
  test      Send a one-off test notification through the configured Telegram adapter
  recovery  Clear dead-owner daemon locks and stale per-session endpoint files (never touches a live owner)

${chalk.bold("Examples:")}
  ${APP_NAME} notify setup
  ${APP_NAME} notify setup --token <botToken> --chat-id <chatId> [--redact]
  ${APP_NAME} notify setup discord --discord-bot-token <token> --discord-application-id <id> --discord-guild-id <id> --discord-parent-channel-id <id>
  ${APP_NAME} notify setup slack --slack-bot-token <token> --slack-app-token <token> --slack-workspace-id <id> --slack-channel-id <id> [--slack-authorized-user-id <id>]
  ${APP_NAME} notify status
  ${APP_NAME} notify health --probe
  ${APP_NAME} notify test --message "hello from gjc"
  ${APP_NAME} notify recovery

${chalk.bold("Threaded Mode:")}
  GJC uses Telegram private-chat topics for per-session threads. Setup verifies the bot
  capability via getMe.has_topics_enabled. Enable Threaded Mode in @BotFather > Bot Settings
  > Threads Settings; bots cannot toggle it through the Bot API. If Telegram refuses topic
  creation at runtime, GJC delivers flat to the paired private chat with outbound notifications
  and inline ask buttons only, then nudges you to enable Threaded Mode for free-text replies
  and session commands.
`);
}
