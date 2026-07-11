/**
 * IRC tool — agent-to-agent messaging.
 *
 * Lets any live agent send a short prose message to any other live agent in
 * this process and (optionally) get a prose reply.
 *
 * Routing happens via the global AgentRegistry. Replies are produced by an
 * ephemeral side-channel call (`AgentSession.respondAsBackground`) that
 * mirrors `/btw`: the recipient's current model, system prompt, and message
 * history are used to compute a reply without persisting it through the
 * normal stream path. After the reply is generated, both the incoming
 * message and the auto-reply are queued for injection into the recipient's
 * persisted history (deferred until the recipient is idle), so the model
 * sees the exchange on its next turn.
 *
 * This avoids the deadlock that arises when the recipient is blocked on a
 * long-running tool call: the side-channel call does not depend on the
 * recipient's main agent loop being free.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import ircDescription from "../prompts/tools/irc.md" with { type: "text" };
import type { AgentRef, AgentRegistry } from "../registry/agent-registry";
import { getRalplanIrcCoordinator, MAIN_AGENT_ID, RALPLAN_IRC_SEND_TIMEOUT_MS } from "../gjc-runtime/ralplan-irc-coordinator";
import { hasActiveRalplanIrcRun } from "../gjc-runtime/ralplan-runtime";

import type { ToolSession } from ".";

const ircSchema = z.object({
	op: z.enum(["send", "list", "ralplan_pass_start", "ralplan_pass_end", "ralplan_deliberation_receipt_recorded", "ralplan_status", "ralplan_report_failure", "ralplan_activation_degrade"]).describe("irc operation"),
	to: z.string().optional().describe('recipient agent id or "all"'),
	message: z.string().optional().describe("message body"),
	awaitReply: z.boolean().optional().describe("wait for prose reply"),
	runId: z.string().optional(),
	stageN: z.number().int().optional(),
	cursorGeneration: z.number().int().optional(),
	reason: z.string().optional(),
});

type IrcParams = z.infer<typeof ircSchema>;

interface IrcReply {
	from: string;
	text: string;
}

export interface IrcDetails {
	op: IrcParams["op"];
	from?: string;
	to?: string;
	delivered?: string[];
	replies?: IrcReply[];
	failed?: Array<{ id: string; error: string }>;
	notFound?: string[];
	peers?: Array<{ id: string; displayName: string; kind: string; status: string; parentId?: string }>;
	channels?: string[];
}

export class IrcTool implements AgentTool<typeof ircSchema, IrcDetails> {
	readonly name = "irc";
	readonly label = "IRC";
	readonly summary = "Send and receive messages between agents over IRC-like channels";
	readonly description: string;
	readonly parameters = ircSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(ircDescription);
	}

	static createIf(session: ToolSession): IrcTool | null {
		if (!session.settings.get("irc.enabled")) return null;
		if (!session.agentRegistry || !session.getAgentId) return null;
		return new IrcTool(session);
	}

	async execute(
		_toolCallId: string,
		params: IrcParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<IrcDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<IrcDetails>> {
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? null;
		if (!registry) {
			return errorResult("IRC is unavailable in this session.", { op: params.op });
		}
		if (!senderId) {
			return errorResult("IRC is unavailable: caller has no agent id.", { op: params.op });
		}

		if (params.op === "list") return this.#executeList(registry, senderId);
		if (params.op === "send") return this.#executeSend(registry, senderId, params, signal);
		return await this.#executeRalplanControl(registry, senderId, params);
	}

	async #executeRalplanControl(registry: AgentRegistry, senderId: string, params: Exclude<IrcParams, { op: "send" | "list" }>): Promise<AgentToolResult<IrcDetails>> {
		const coordinator = getRalplanIrcCoordinator(registry);
		const parentSessionId = this.session.getSessionId?.() ?? undefined;
		if (senderId !== MAIN_AGENT_ID || !coordinator || !parentSessionId || !params.runId) {
			return errorResult("Ralplan IRC control is restricted to the owning main session.", { op: params.op, from: senderId });
		}
		if (params.op === "ralplan_activation_degrade") {
			const ok = await coordinator.activationDegrade({ parentSessionId, runId: params.runId, reason: params.reason?.trim() || "activation_failed" });
			return ok ? controlResult(params.op, senderId, "Ralplan IRC activation degraded.") : errorResult("No matching active Ralplan IRC run.", { op: params.op, from: senderId });
		}
		if (!Number.isInteger(params.stageN) || !Number.isInteger(params.cursorGeneration)) return errorResult("Ralplan IRC pass controls require stageN and cursorGeneration.", { op: params.op, from: senderId });
		const cursor = { parentSessionId, runId: params.runId, stageN: params.stageN!, cursorGeneration: params.cursorGeneration! };
		if (params.op === "ralplan_pass_start") {
			const authorized = await hasActiveRalplanIrcRun(this.session.cwd, parentSessionId, params.runId);
			const ok = authorized && coordinator.startPass(cursor);
			return ok ? controlResult(params.op, senderId, "Ralplan IRC pass started.") : errorResult("No matching active Ralplan IRC run.", { op: params.op, from: senderId });
		}
		if (params.op === "ralplan_status") {
			if (!coordinator.matchesActivePass(cursor)) return errorResult("No matching active Ralplan IRC pass.", { op: params.op, from: senderId });
			return controlResult(params.op, senderId, coordinator.state);
		}

		if (params.op === "ralplan_pass_end") {
			const markdown = coordinator.endPass(cursor);
			return markdown === undefined ? errorResult("No matching active Ralplan IRC pass.", { op: params.op, from: senderId }) : controlResult(params.op, senderId, markdown);
		}
		if (params.op === "ralplan_deliberation_receipt_recorded") {
			const ok = await coordinator.recordDeliberationReceipt(cursor);
			return ok
				? controlResult(params.op, senderId, "Ralplan deliberation receipt recorded.")
				: errorResult("No matching completed Ralplan IRC pass or canonical deliberation receipt; its SHA-256 must match the just-completed transcript.", { op: params.op, from: senderId });
		}
		const ok = await coordinator.reportFailure({ ...cursor, reason: params.reason?.trim() || "reported_failure" });
		return ok ? controlResult(params.op, senderId, "Ralplan IRC pass degraded.") : errorResult("No matching active Ralplan IRC pass.", { op: params.op, from: senderId });
	}

	#executeList(registry: AgentRegistry, senderId: string): AgentToolResult<IrcDetails> {
		const peers = registry.listVisibleTo(senderId);
		const lines: string[] = [];
		if (peers.length === 0) {
			lines.push("No other live agents.");
		} else {
			lines.push(`${peers.length} peer(s):`);
			for (const peer of peers) {
				lines.push(`- ${peer.id} [${peer.displayName} · ${peer.kind} · ${peer.status}]`);
			}
		}
		const channels = ["all", ...peers.map(p => p.id)];
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				op: "list",
				from: senderId,
				peers: peers.map(p => ({
					id: p.id,
					displayName: p.displayName,
					kind: p.kind,
					status: p.status,
					parentId: p.parentId,
				})),
				channels,
			},
		};
	}

	async #executeSend(
		registry: AgentRegistry,
		senderId: string,
		params: IrcParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<IrcDetails>> {
		const to = params.to?.trim();
		const message = params.message?.trim();
		if (!to) {
			return errorResult('`to` is required for op="send".', { op: "send", from: senderId });
		}
		if (!message) {
			return errorResult('`message` is required for op="send".', { op: "send", from: senderId });
		}

		// Resolve target peers.
		let targets: AgentRef[];
		const notFound: string[] = [];
		const isBroadcast = to === "all";
		const coordinator = getRalplanIrcCoordinator(registry);
		const senderBinding = coordinator?.isBound(senderId);
		if (isBroadcast) {
			targets = registry.listVisibleTo(senderId).filter(target => {
			const targetBinding = coordinator?.isBound(target.id);
			return senderBinding ? coordinator!.isSameBoundPass(senderId, target.id) : !targetBinding;
		});
		} else {
			const ref = registry.get(to);
			if (!ref || ref.id === senderId || (ref.status !== "running" && ref.status !== "idle")) {
				notFound.push(to);
				targets = [];
			} else if (senderBinding || coordinator?.isBound(ref.id)) {
				if (!senderBinding || !coordinator?.isSameBoundPass(senderId, ref.id)) {
					return errorResult("Ralplan IRC messages may only be sent between peers in the same active pass.", { op: "send", from: senderId, to });
				}
				targets = [ref];
			} else {
				targets = [ref];
			}
		}


		const awaitReply = params.awaitReply ?? !isBroadcast;

		const delivered: string[] = [];
		const replies: IrcReply[] = [];
		const failed: Array<{ id: string; error: string }> = [];

		// Dispatch to each target in parallel via the recipient's ephemeral
		// side-channel. Independent calls so a slow recipient cannot stall the
		// others. The recipient's main loop never has to be unblocked: the
		// side-channel runs alongside any in-flight tool call.
		const dispatches = targets.map(async target => {
			const targetSession = target.session;
			if (!targetSession) {
				notFound.push(target.id);
				return;
			}
			let deliveredAtTransport = false;
			let resolveDelivery!: () => void;
			const delivery = new Promise<void>(resolve => { resolveDelivery = resolve; });
			try {
				const bound = coordinator?.isSameBoundPass(senderId, target.id) === true;
				const dispatch = targetSession.respondAsBackground({
					from: senderId,
					message,
					awaitReply,
					signal,
					onDelivered: () => { deliveredAtTransport = true; resolveDelivery(); },
				});
				if (bound) {
					const completed = dispatch;
					void completed.catch(() => {});
					await raceRalplanSend(Promise.race([delivery, dispatch.then(() => delivery)]), signal, coordinator!.options.sendTimeoutMs);
					delivered.push(target.id);
					coordinator!.recordDelivery({ from: senderId, to: target.id, body: message, delivered: true });
					if (awaitReply) {
						void completed.then(result => { if (result.replyText) replies.push({ from: target.id, text: result.replyText }); }).catch(error => { failed.push({ id: target.id, error: error instanceof Error ? error.message : String(error) }); });
					}
				} else {
					const result = await dispatch;
					delivered.push(target.id);
					if (awaitReply && result.replyText) replies.push({ from: target.id, text: result.replyText });
				}
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				failed.push({ id: target.id, error });
				if (coordinator?.isSameBoundPass(senderId, target.id) || (senderBinding && !deliveredAtTransport)) await coordinator.degrade(error === "Ralplan IRC send timed out." ? "send_timeout" : "delivery_failed");
			}
		});
		await Promise.all(dispatches);
		if (notFound.length > 0 && senderBinding) await coordinator!.degrade("peer_unreachable");

		const lines: string[] = [];
		if (delivered.length === 0) {
			lines.push("No recipients received the message.");
		} else {
			lines.push(`Delivered to ${delivered.length} peer(s): ${delivered.join(", ")}`);
		}
		if (replies.length > 0) {
			lines.push("");
			lines.push("## Replies");
			for (const reply of replies) {
				lines.push(`### ${reply.from}`);
				lines.push(reply.text);
			}
		}
		if (failed.length > 0) {
			lines.push("");
			lines.push("## Failed");
			for (const f of failed) {
				lines.push(`- ${f.id}: ${f.error}`);
			}
		}
		if (notFound.length > 0) {
			lines.push("");
			lines.push(`Unknown / unavailable peers: ${notFound.join(", ")}`);
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				op: "send",
				from: senderId,
				to,
				delivered,
				...(replies.length > 0 ? { replies } : {}),
				...(failed.length > 0 ? { failed } : {}),
				...(notFound.length > 0 ? { notFound } : {}),
			},
		};
	}
}

function controlResult(op: IrcParams["op"], from: string, text: string): AgentToolResult<IrcDetails> {
	return { content: [{ type: "text", text }], details: { op, from } };
}

function raceRalplanSend<T>(dispatch: Promise<T>, signal?: AbortSignal, timeoutMs = RALPLAN_IRC_SEND_TIMEOUT_MS): Promise<T> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Ralplan IRC send timed out.")), timeoutMs);
		const abort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error("IRC send cancelled."));
		if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
		dispatch.then(resolve, reject).finally(() => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); });
	});
}

function errorResult(text: string, details: IrcDetails): AgentToolResult<IrcDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}
