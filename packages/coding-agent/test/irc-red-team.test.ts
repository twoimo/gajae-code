import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel, type MockModel, registerMockApi } from "@gajae-code/ai/providers/mock";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { BashExecutionComponent } from "@gajae-code/coding-agent/modes/components/bash-execution";
import { IrcSplitViewComponent } from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { getThemeByName, initTheme, setThemeInstance, theme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import type { CustomMessage } from "@gajae-code/coding-agent/session/messages";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Container, ImageProtocol, TERMINAL, type TUI } from "@gajae-code/tui";

const SIXEL_START = "\x1bPq";
const SIXEL_END = "\x1b\\";
const SIXEL_PLACEHOLDER = "[SIXEL image hidden while IRC sidebar is visible]";
const artifactDir = path.join(os.tmpdir(), "gjc-irc-red-team-artifacts");
await fs.mkdir(artifactDir, { recursive: true });
const terminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
const originalProtocol = TERMINAL.imageProtocol;
const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;

registerMockApi();

const rosterSessions: AgentSession[] = [];

type RosterHarness = {
	session: AgentSession;
	registry: AgentRegistry;
	snapshots: Array<readonly unknown[]>;
};

function createRosterHarness(model: MockModel, sessionManager = SessionManager.inMemory()): RosterHarness {
	const snapshots: RosterHarness["snapshots"] = [];
	const registry = new AgentRegistry();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["system"], messages: [], tools: [] },
		streamFn: model.stream,
		convertToLlm: async messages => {
			snapshots.push(messages);
			return convertToLlm(messages);
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: { getApiKey: async () => "test-key", getAvailable: () => [model] } as never,
		agentId: "0-Main",
		agentRegistry: registry,
		convertToLlm: async messages => {
			snapshots.push(messages);
			return convertToLlm(messages);
		},
	});
	rosterSessions.push(session);
	registry.register({
		id: "1-Worker",
		displayName: "Worker",
		rosterLabel: "red-team",
		kind: "sub",
		session: null,
		status: "running",
	});
	return { session, registry, snapshots };
}

function rosterDeliveries(harness: RosterHarness): string[] {
	return harness.snapshots.flatMap(snapshot => {
		const serialized = JSON.stringify(snapshot);
		return serialized.includes('"customType":"irc-peer-roster"') ? [serialized] : [];
	});
}

beforeAll(async () => {
	initTheme();
	const theme = await getThemeByName("red-claw");
	if (!theme) throw new Error("Expected red-claw theme");
	setThemeInstance(theme);
});

afterEach(async () => {
	for (const session of rosterSessions.splice(0)) await session.dispose();
	vi.useRealTimers();
	terminal.imageProtocol = originalProtocol;
	if (originalForceProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForceProtocol;
	if (originalAllowPassthrough === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllowPassthrough;
});

function ircMessage(observationId: string, timestamp: number, text: string): CustomMessage {
	return {
		role: "custom",
		customType: "irc:incoming",
		content: text,
		display: true,
		details: { observationId, from: "peer", to: "0-Main", message: text },
		attribution: "agent",
		timestamp,
	};
}

function eventContext(setting: { enabled: boolean }) {
	const chatContainer = new Container();
	const ledger = new IrcObservationLedger();
	const ctx = {
		isInitialized: true,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		ui: { requestRender: vi.fn() },
		chatContainer,
		settings: { get: () => setting.enabled },
		captureIrcArrivalSnapshot: () => ({
			panelVisible: setting.enabled,
			panelRequestedVisible: setting.enabled,
			sidebarAvailable: true,
			resolvedToggleKey: "Alt+I",
		}),
		ircLedger: ledger,
		session: {},
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	const addMessageToChat = vi.fn((message: CustomMessage) => helpers.addMessageToChat(message));
	ctx.addMessageToChat = addMessageToChat;
	const addLiveIrcObservationToChat = vi.fn((message, arrival) =>
		helpers.addLiveIrcObservationToChat(message, arrival),
	);
	ctx.addLiveIrcObservationToChat = addLiveIrcObservationToChat;
	return { ctx, chatContainer, ledger, addMessageToChat, addLiveIrcObservationToChat };
}

function visibleSplit(component: BashExecutionComponent): IrcSplitViewComponent {
	const split = new IrcSplitViewComponent(component, new IrcObservationLedger(), theme);
	split.setVisible(true);
	return split;
}

describe("IRC visualization red-team", () => {
	it("keeps same-millisecond/same-customType observations distinct, dedupes persisted delivery, and records both", async () => {
		const setting = { enabled: false };
		const { ctx, chatContainer, ledger, addLiveIrcObservationToChat } = eventContext(setting);
		const controller = new EventController(ctx);
		const first = ircMessage("red-one", 1234, "first");
		const second = ircMessage("red-two", 1234, "second");

		await controller.handleEvent({ type: "irc_message", message: first });
		await controller.handleEvent({ type: "irc_message", message: second });
		await controller.handleEvent({ type: "message_start", message: first });

		expect(addLiveIrcObservationToChat).toHaveBeenCalledTimes(2);
		expect(chatContainer.children).toHaveLength(4);
		expect(ledger.getSidebarRecords().map(record => record.text)).toEqual(["first", "second"]);
	});

	it("removes rendered IRC components on a sidebar-session reset and allows a fresh observation", async () => {
		const setting = { enabled: false };
		const { ctx, chatContainer, ledger } = eventContext(setting);
		const controller = new EventController(ctx);
		const split = new IrcSplitViewComponent(chatContainer, ledger, theme);
		split.setVisible(true);
		const resetIrcSidebarSession = () => {
			ledger.reset();
			controller.resetIrcObservations();
			split.setVisible(false);
		};

		await controller.handleEvent({ type: "irc_message", message: ircMessage("before-reset", 1, "before reset") });
		expect(chatContainer.children).toHaveLength(2);

		resetIrcSidebarSession();
		expect(chatContainer.children).toHaveLength(0);
		expect(ledger.getSidebarRecords()).toEqual([]);

		await controller.handleEvent({ type: "irc_message", message: ircMessage("after-reset", 2, "after reset") });
		expect(chatContainer.children).toHaveLength(2);
		expect(ledger.getSidebarRecords().map(record => record.text)).toEqual(["after reset"]);
	});

	it("captures immutable event-time policy across a live setting flip", async () => {
		vi.useFakeTimers({ now: 0 });
		const setting = { enabled: false };
		const { ctx, chatContainer, ledger } = eventContext(setting);
		const controller = new EventController(ctx);
		await controller.handleEvent({ type: "irc_message", message: ircMessage("before", 0, "persistent") });
		setting.enabled = true;
		await controller.handleEvent({ type: "irc_message", message: ircMessage("after", 1, "ephemeral") });

		expect(ledger.getSidebarRecords().map(record => record.mode)).toEqual(["persistent", "ephemeral"]);
		vi.advanceTimersByTime(10_000);
		expect(ledger.getInlineProjection(Date.now()).map(record => record.observationId)).toEqual(["before"]);
		expect(chatContainer.children).toHaveLength(2);
	});

	it("replaces a SIXEL sequence whose visible collapsed slice starts inside it exactly once, with footer and no DCS", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const ui = { requestRender: () => {} } as unknown as TUI;
		const component = new BashExecutionComponent("emit sixel", ui, false);
		const output = [
			...Array.from({ length: 18 }, (_, index) => `ordinary ${index}`),
			`${SIXEL_START}payload-begins`,
			"payload-continues",
			`payload-ends${SIXEL_END}`,
			...Array.from({ length: 5 }, (_, index) => `tail ${index}`),
		].join("\n");
		component.setComplete(0, false, { output });
		const raw = visibleSplit(component).render(160).join("\n");
		await fs.writeFile(path.join(artifactDir, "collapsed-sixel-visible.ansi"), raw);
		const plain = Bun.stripANSI(raw);

		expect(plain.split(SIXEL_PLACEHOLDER).length - 1).toBe(1);
		expect(plain).toMatch(/more lines/u);
		expect(raw).not.toContain("\x1bP");
	});

	it("with rapid visibility toggles, never leaks raw DCS into visible renders or stale cached output", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const ui = { requestRender: () => {} } as unknown as TUI;
		const component = new BashExecutionComponent("emit sixel", ui, false);
		component.setComplete(0, false, { output: `${SIXEL_START}cached${SIXEL_END}` });
		const split = new IrcSplitViewComponent(component, new IrcObservationLedger(), theme);
		const frames: string[] = [];
		for (let index = 0; index < 20; index++) {
			split.setVisible(true);
			frames.push(split.render(100).join("\n"));
			split.setVisible(false);
			frames.push(split.render(100).join("\n"));
		}
		await fs.writeFile(path.join(artifactDir, "toggle-spam.ansi"), frames.join("\n---FRAME---\n"));
		expect(frames.filter((_, index) => index % 2 === 0).every(frame => !frame.includes("\x1bP"))).toBe(true);
		expect(frames.filter((_, index) => index % 2 === 1).every(frame => frame.includes("\x1bP"))).toBe(true);
	});

	it("allows one normal-or-ephemeral roster carrier, retries a failed claim, and rejects a late reset claimant", async () => {
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const concurrent = createRosterHarness(
			createMockModel({
				handler: async () => {
					calls += 1;
					if (calls === 1) await release.promise;
					return { content: ["ok"] };
				},
			}),
		);
		const normal = concurrent.session.prompt("normal");
		await Bun.sleep(0);
		const ephemeral = concurrent.session.runEphemeralTurn({ promptText: "ephemeral" });
		release.resolve();
		await Promise.all([normal, ephemeral]);
		expect(rosterDeliveries(concurrent)).toHaveLength(1);

		let fail = true;
		const retry = createRosterHarness(
			createMockModel({ handler: () => (fail ? { throw: "temporary failure" } : { content: ["ok"] }) }),
		);
		await expect(retry.session.runEphemeralTurn({ promptText: "fails" })).rejects.toThrow("temporary failure");
		fail = false;
		await retry.session.runEphemeralTurn({ promptText: "retry" });
		expect(rosterDeliveries(retry)).toHaveLength(2);

		const lateRelease = Promise.withResolvers<void>();
		const reset = createRosterHarness(
			createMockModel({
				handler: async () => {
					await lateRelease.promise;
					return { content: ["ok"] };
				},
			}),
		);
		const pending = reset.session.runEphemeralTurn({ promptText: "pending" });
		await Bun.sleep(0);
		await reset.session.newSession();
		lateRelease.resolve();
		await pending;
		await reset.session.runEphemeralTurn({ promptText: "after reset" });
		expect(rosterDeliveries(reset)).toHaveLength(2);
	});

	it("preserves a delivered roster across same-session reload", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-irc-red-team-reload-"));
		const harness = createRosterHarness(
			createMockModel({ handler: () => ({ content: ["ok"] }) }),
			SessionManager.create(directory, directory),
		);
		await harness.session.prompt("before reload");
		await harness.session.reload();
		await harness.session.prompt("after reload");
		expect(rosterDeliveries(harness)).toHaveLength(1);
	});

	it("reloads a delivered roster then sends exactly one changed roster", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-irc-red-team-reload-change-"));
		const harness = createRosterHarness(
			createMockModel({ handler: () => ({ content: ["ok"] }) }),
			SessionManager.create(directory, directory),
		);
		await harness.session.prompt("before reload");
		await harness.session.reload();
		harness.registry.register({
			id: "2-Worker",
			displayName: "Worker Two",
			rosterLabel: "changed",
			kind: "sub",
			session: null,
			status: "running",
		});
		await harness.session.prompt("after roster change");

		const deliveries = rosterDeliveries(harness);
		expect(deliveries).toHaveLength(2);
		expect(deliveries.at(-1)).toContain("2-Worker (changed)");
	});

	it("keeps an unbounded append-only ledger and fork failure leaves the caller-owned ledger untouched", async () => {
		const ledger = new IrcObservationLedger();
		for (let index = 0; index < 1_001; index++) {
			ledger.observe(
				{
					observationId: `record-${index}`,
					kind: "incoming",
					from: "peer",
					to: "main",
					text: String(index),
					timestamp: index,
				},
				false,
			);
		}
		expect(ledger.getSidebarRecords()).toHaveLength(1_001);
		expect(ledger.getSidebarRecords().at(-1)?.text).toBe("1000");
		const beforeFailure = ledger.getSidebarRecords();
		await expect(Promise.reject(new Error("fork failure"))).rejects.toThrow("fork failure");
		expect(ledger.getSidebarRecords()).toEqual(beforeFailure);
		ledger.reset();
		expect(ledger.getSidebarRecords()).toEqual([]);
	});
});

export const ircRedTeamArtifactDir = artifactDir;
