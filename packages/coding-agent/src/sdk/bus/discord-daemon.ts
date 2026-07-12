import { createHash, randomUUID } from "node:crypto";
import { ConversationStore } from "./conversation-store";
import { ChatEffectJournal, type ChatEffect, type ChatEffectLease, type ChatEffectReceipt } from "./chat-effect-journal";

import {
	discordConversationKey,
	normalizeDiscordConversation,
	type DiscordConversation,
	type DiscordInboundDispatchReceipt,
} from "./discord-conversation";
import type { DiscordInboundEvent, DiscordMessageComponent, DiscordProvider, DiscordThread } from "./discord-provider";
const FAILURE = "This conversation is no longer available.";


/** A captured live SDK transport. `isCurrent` must fail closed after replacement or removal. */
export interface DiscordEndpointBinding {
	generation: number;
	isCurrent(): boolean;
	send(frame: Record<string, unknown>): void | Promise<void>;
}

export interface DiscordNotificationDaemonOptions {
	agentDir: string;
	repo: string;
	guildId: string;
	parentChannelId: string;
	provider: DiscordProvider;
	now?: () => number;
	resolveEndpoint: (sessionId: string) => Promise<DiscordEndpointBinding | null>;
	onCommand?: (sessionId: string, content: string, endpoint: DiscordEndpointBinding, idempotencyKey: string) => Promise<boolean>;
}


export interface DiscordNotificationInput {
	sessionId: string;
	endpointGeneration: number;
	content: string;
	threadName?: string;
	actionId?: string;
	options?: string[];
}

type DiscordInboundEffectPayload = {
	type: "command";
	content: string;
	idempotencyKey: string;
	routing: DiscordInboundRouting;
} | {
	type: "reply";
	id: string;
	answer: string | number;
	idempotencyKey: string;
	routing: DiscordInboundRouting;
};

type DiscordInboundRouting = {
	guildId: string;
	parentId: string;
	threadId: string;
	eventId: string;
	interactionId?: string;
	kind: "command" | "action";
	actionId?: string;
	actionNonce?: string;
};


/** SDK-only Discord threaded notification daemon. It owns no AgentSession and never retains endpoint credentials. */
export class DiscordNotificationDaemon {
	readonly #store: ConversationStore<DiscordConversation>;
	readonly #now: () => number;
	readonly #creates = new Map<string, Promise<DiscordConversation>>();
	readonly #resumes = new Map<string, Promise<DiscordConversation | undefined>>();
	readonly #resolveEndpoint: (sessionId: string) => Promise<DiscordEndpointBinding | null>;
	readonly #effects: ChatEffectJournal;
	readonly #activeWork = new Set<Promise<unknown>>();
	readonly #inflightInbound = new Set<string>();
	#started = false;
	#leaseRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
	#leaseRecoveryAt: number | undefined;
	#leaseRecoveryFailures = 0;




	readonly #dispatchOwner = randomUUID();
	readonly #dispatchLeaseMs = 60_000;
	readonly #providerOwner = randomUUID();
	readonly #providerLeaseMs = 60_000;
	constructor(private readonly options: DiscordNotificationDaemonOptions) {
		this.#store = new ConversationStore({ agentDir: options.agentDir, kind: "discord", now: options.now });
		this.#effects = new ChatEffectJournal({ agentDir: options.agentDir, transport: "discord", now: options.now });
		this.#now = options.now ?? Date.now;
		this.#resolveEndpoint = options.resolveEndpoint;
	}

	async start(): Promise<void> {
		// Provider start is the delivery boundary; complete crash recovery first.
		const providerRecoveryFailed = await this.#drainProviderEffects();
		await this.#drainPendingDispatches();
		this.#started = true;
		try {
			await this.#scheduleLeaseRecovery(providerRecoveryFailed);
			await this.options.provider.start(event => this.#track(this.handleInbound(event)), () => {});
		} catch (error) {
			this.#started = false;
			if (this.#leaseRecoveryTimer) clearTimeout(this.#leaseRecoveryTimer);
			this.#leaseRecoveryTimer = undefined;
			this.#leaseRecoveryAt = undefined;
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.#leaseRecoveryTimer) clearTimeout(this.#leaseRecoveryTimer);
		this.#leaseRecoveryTimer = undefined;
		this.#leaseRecoveryAt = undefined;

		if (this.#started) {
			this.#started = false;
			await this.options.provider.stop();
		}
		await Promise.all([...this.#activeWork]);
	}


	async notify(input: DiscordNotificationInput): Promise<DiscordConversation> {
		const conversation = await this.#ensureConversation(input);
		if (conversation.state !== "active" || !conversation.threadId) throw new Error("Discord thread is unavailable");
		const pendingActionId = input.actionId;
		const authoritative = pendingActionId
			? await this.#ensureActionPublication(conversation, pendingActionId)
			: conversation;
		const components = pendingActionId && authoritative.pendingActionNonce && input.options && input.options.length > 0
			? actionComponents(authoritative.endpointGeneration!, pendingActionId, authoritative.pendingActionNonce, input.options)
			: undefined;

		// The durable action publication intent, rather than this notification call,
		// owns the provider-visible effect identity. This makes retries reconcile the
		// original post and preserves the original component route.
		const effectId = pendingActionId ? authoritative.pendingActionEffectId! : `notification:${authoritative.threadId}:${randomUUID()}`;
		await this.#postEffect(effectId, authoritative, input.content, components, pendingActionId !== undefined);


		return authoritative;
	}

	/** Posts a safe command outcome to the active mapped conversation. */
	async postCommandResult(sessionId: string, content: string): Promise<boolean> {
		const record = await this.#bySession(sessionId);
		if (!record || record.state !== "active" || !record.threadId) return false;
		await this.#postEffect(`command-result:${record.threadId}:${randomUUID()}`, record, content);
		return true;
	}

	async close(sessionId: string): Promise<void> {
		const record = await this.#bySession(sessionId);
		if (!record || !record.threadId || record.state === "closed") return;
		const current = record.pendingActionId ? await this.#replace(record, { ...record, pendingActionId: undefined, pendingActionNonce: undefined, pendingActionEffectId: undefined }) : record;

		await this.#postEffect(`close-marker:${current.threadId}`, current, "This conversation is closed.");
		await this.#threadEffect(`close-archive:${current.threadId}`, current, "archive", true);
		await this.#replace(current, { ...current, state: "closed", closedAt: this.#now() });
	}

	async archive(sessionId: string): Promise<void> {
		const record = await this.#bySession(sessionId);
		if (!record || !record.threadId || record.state !== "active") return;
		await this.#threadEffect(`archive:${record.threadId}`, record, "archive");
		await this.#replace(record, { ...record, state: "archived", archivedAt: this.#now() });
	}

	async resume(sessionId: string, endpointGeneration: number): Promise<DiscordConversation | undefined> {
		const running = this.#resumes.get(sessionId);
		if (running) return await running;
		const task = this.#resume(sessionId, endpointGeneration);
		this.#resumes.set(sessionId, task);
		try { return await task; } finally { this.#resumes.delete(sessionId); }
	}

	async #resume(sessionId: string, endpointGeneration: number): Promise<DiscordConversation | undefined> {
		const record = await this.#bySession(sessionId);
		if (!record || !record.threadId || record.state === "closed") return undefined;
		const resuming = await this.#replace(record, { ...record, state: "resuming", pendingActionId: undefined, pendingActionNonce: undefined, pendingActionEffectId: undefined });

		try {
			await this.#threadEffect(`unarchive:${resuming.threadId}:${endpointGeneration}`, resuming, "unarchive");
			return await this.#replace(resuming, { ...resuming, state: "active", endpointGeneration, archivedAt: undefined });
		} catch {
			const superseded = await this.#replace(resuming, { ...resuming, state: "archived", pendingActionId: undefined, pendingActionNonce: undefined, pendingActionEffectId: undefined });

			const replacement = await this.#create(sessionId, endpointGeneration, `resume-${randomUUID()}`);
			await this.#replace(superseded, { ...superseded, supersededByThreadId: replacement.threadId });
			return replacement;
		}
	}

	async resolveAction(sessionId: string, actionId: string): Promise<void> {
		const record = await this.#bySession(sessionId);
		if (record?.pendingActionId === actionId && record.pendingActionNonce) await this.#clearPending(record, actionId, record.pendingActionNonce);

	}

	async handleInbound(event: DiscordInboundEvent): Promise<void> {
		if (event.bot || event.authorId === this.options.provider.botUserId) return;
		const record = await this.#byThread(event.guildId, event.parentId, event.threadId);
		if (!record?.sessionId) { await this.#fail(event.threadId); return; }
		const receipt = await this.#claimInbound(record, event);
		if (receipt === "invalid") { await this.#fail(event.threadId); return; }
		if (!receipt || this.#inflightInbound.has(receipt.effectId)) return;
		this.#inflightInbound.add(receipt.effectId);
		try {
			// Interaction callbacks have a short provider deadline.  The mapping and
			// journal claim are sufficient to acknowledge; endpoint discovery waits.
			const endpoint = event.interaction ? null : await this.#resolveEndpoint(record.sessionId);
			if (!event.interaction && !this.#matches(record, endpoint)) { await this.#fail(event.threadId); return; }
			await this.#dispatchInbound(record, endpoint, receipt, event.interaction);
		} finally {
			this.#inflightInbound.delete(receipt.effectId);
			await this.#scheduleLeaseRecovery();
		}
	}

	#track<T>(work: Promise<T>): Promise<T> {
		this.#activeWork.add(work);
		return work.finally(() => this.#activeWork.delete(work));
	}

	async #claimInbound(record: DiscordConversation, event: DiscordInboundEvent): Promise<DiscordInboundDispatchReceipt | undefined | "invalid"> {
		const route = event.interaction ? decodeCustomId(event.interaction.customId) : undefined;
		const command = !event.interaction && event.content?.startsWith("/sdk ");
		if (!command && (!route || !event.interaction || route.generation !== record.endpointGeneration)) return "invalid";
		const key = discordConversationKey({ appId: record.appId, guildId: record.guildId, parentChannelId: record.parentChannelId, threadId: record.threadId! }); let receipt: DiscordInboundDispatchReceipt | undefined; let valid = false;
		const effectId = `discord:${record.appId}:${record.guildId}:${record.parentChannelId}:${record.threadId}:${event.id}`;
		const idempotencyKey = effectId;
		const routing: DiscordInboundRouting = { guildId: event.guildId, parentId: event.parentId, threadId: event.threadId, eventId: event.id, ...(event.interaction ? { interactionId: event.interaction.id } : {}), kind: command ? "command" : "action", ...(!command ? { actionId: route!.actionId, actionNonce: route!.actionNonce } : {}) };
		await this.#rescheduleAfterEffectTransition(this.#effects.enqueue({ id: effectId, kind: `discord.inbound.${command ? "command" : "action"}`, transport: "discord", sessionId: record.sessionId, endpointGeneration: record.endpointGeneration!, payload: command ? { type: "command", content: event.content!, idempotencyKey, routing } : { type: "reply", id: route!.actionId, answer: componentAnswer(event.interaction!.value ?? ""), idempotencyKey, routing } satisfies DiscordInboundEffectPayload }));

		await this.#store.transact(key, current => { if (!current || current.state !== "active" || current.endpointGeneration !== record.endpointGeneration) return current; const interactionId = event.interaction?.id; const existing = (current.inboundDispatches ?? []).find(item => item.eventId === event.id || (interactionId !== undefined && item.interactionId === interactionId)); if (existing) { valid = true; receipt = existing; return current; } if (!command && (current.pendingActionId !== route!.actionId || current.pendingActionNonce !== route!.actionNonce)) return current; valid = true; receipt = command ? { key: event.id, eventId: event.id, kind: "command", endpointGeneration: record.endpointGeneration!, effectId, idempotencyKey } : { key: event.id, eventId: event.id, interactionId: interactionId!, kind: "action", actionId: route!.actionId, actionNonce: route!.actionNonce, endpointGeneration: record.endpointGeneration!, effectId, idempotencyKey }; return normalizeDiscordConversation({ ...current, generation: current.generation + 1, updatedAt: this.#now(), inboundDispatches: [...(current.inboundDispatches ?? []), receipt!] }); });
		if (!valid || !receipt) { await this.#terminalizeRejectedInbound(effectId); return "invalid"; }
		return receipt;


	}
	async #dispatchInbound(record: DiscordConversation, initialEndpoint: DiscordEndpointBinding | null, receipt: DiscordInboundDispatchReceipt, interaction?: DiscordInboundEvent["interaction"]): Promise<void> {
		const effect = await this.#rescheduleAfterEffectTransition(this.#effects.claim<DiscordInboundEffectPayload>(receipt.effectId, this.#dispatchOwner, this.#dispatchLeaseMs));
		if (!effect) return;
		const lease = { owner: this.#dispatchOwner, epoch: effect.epoch };
		const current = await this.#currentInboundRecord(record, receipt);
		if (!current) {
			await this.#terminalizeInbound(record, receipt, "rejected");
			return;

		}
		record = current;
		if (receipt.kind === "action") {
			// Callback tokens cannot survive a restart; make this exact authority
			// terminal rather than reclaiming an accepted effect indefinitely.
			if (!interaction) { await this.#terminalizeInbound(record, receipt, "callback_token_unavailable"); return; }

			let callbackLeaseLost = false;
			let callbackRenewal: Promise<boolean> | undefined;
			const renewCallbackLease = async (): Promise<boolean> => {
				if (callbackLeaseLost) return false;
				if (callbackRenewal) return await callbackRenewal;
				const renewal = (async (): Promise<boolean> => {
					if (!(await this.#rescheduleAfterEffectTransition(this.#effects.renew(effect.id, lease, this.#dispatchLeaseMs)))) callbackLeaseLost = true;
					return !callbackLeaseLost;
				})();
				callbackRenewal = renewal;
				try { return await renewal; } finally { if (callbackRenewal === renewal) callbackRenewal = undefined; }
			};
			const timer = setInterval(() => { void renewCallbackLease().catch(() => {}); }, Math.max(1, Math.floor(this.#dispatchLeaseMs / 3)));
			try {
				if (!(await renewCallbackLease())) return;
				await this.options.provider.deferInteraction({ id: interaction.id, token: interaction.token });
				if (!(await renewCallbackLease())) return;
			} catch {
				await this.#rescheduleAfterEffectTransition(this.#effects.record(effect.id, lease, "accepted", { status: "callback_failed" }));
				throw new Error("Discord interaction callback failed");
			}
			finally { clearInterval(timer); }
		}
		const endpoint = initialEndpoint ?? await this.#resolveEndpoint(record.sessionId!);
		if (!this.#matches(record, endpoint) || receipt.endpointGeneration !== endpoint.generation) {
			await this.#rescheduleAfterEffectTransition(this.#effects.record(effect.id, lease, "accepted", { status: "pre_send_binding_changed" }));
			return;
		}
		let leaseLost = false;
		let renewal: Promise<boolean> | undefined;
		const renew = async (): Promise<boolean> => {
			if (leaseLost) return false;
			if (renewal) return await renewal;
			const currentRenewal = (async (): Promise<boolean> => {
				if (!(await this.#rescheduleAfterEffectTransition(this.#effects.renew(effect.id, lease, this.#dispatchLeaseMs)))) leaseLost = true;
				return !leaseLost;
			})();
			renewal = currentRenewal;
			try { return await currentRenewal; } finally { if (renewal === currentRenewal) renewal = undefined; }
		};
		const timer = setInterval(() => { void renew().catch(() => {}); }, Math.max(1, Math.floor(this.#dispatchLeaseMs / 3)));
		try {
			if (!(await renew())) return;
			if (!this.#matches(record, endpoint) || receipt.endpointGeneration !== endpoint.generation) {
				await this.#rescheduleAfterEffectTransition(this.#effects.record(effect.id, lease, "accepted", { status: "pre_send_binding_changed" }));
				return;
			}
			if (!(await renew())) return;
			if (effect.payload.type === "command") await this.options.onCommand?.(record.sessionId!, effect.payload.content, endpoint, effect.payload.idempotencyKey);
			else await endpoint.send(effect.payload);
			if (!leaseLost && await renew() && (await this.#effects.record(effect.id, lease, "terminal"))) await this.#finishInbound(record, receipt);
		} catch { if (!leaseLost) await this.#rescheduleAfterEffectTransition(this.#effects.record(effect.id, lease, "uncertain")); }
		finally { clearInterval(timer); }
	}
	async #drainPendingDispatches(): Promise<void> {
		const dispatched = new Set<string>();
		for (const record of Object.values((await this.#store.load()).conversations)) {
			if (!record.threadId || !record.sessionId || record.state !== "active") continue;
			const endpoint = await this.#resolveEndpoint(record.sessionId);
			for (const receipt of record.inboundDispatches ?? []) {
				if ((await this.#effects.read(receipt.effectId))?.state === "terminal") continue;
				if (!this.#matches(record, endpoint) || endpoint.generation !== receipt.endpointGeneration) {
					await this.#terminalizeInbound(record, receipt, "stale_binding");
					continue;
				}
				dispatched.add(receipt.effectId);
				await this.#dispatchInbound(record, endpoint, receipt);
			}
		}

		// Effects are the authority: a crash between enqueue and mapping receipt
		// publication must not strand a command at restart. Adoption revalidates
		// the current mapping before an orphan can reach the SDK.
		for (const effect of await this.#effects.list()) {
			if (effect.transport !== "discord" || effect.state === "terminal" || !effect.kind.startsWith("discord.inbound.") || dispatched.has(effect.id)) continue;
			const payload = effect.payload as DiscordInboundEffectPayload;
			const routing = payload.routing;
			if (!routing) continue;
			const adopted = await this.#adoptOrphanInbound(effect.id, effect.sessionId, effect.endpointGeneration, payload, routing);
			if (!adopted) continue;
			const endpoint = await this.#resolveEndpoint(adopted.record.sessionId!);
			if (!this.#matches(adopted.record, endpoint) || endpoint.generation !== effect.endpointGeneration) {
				await this.#terminalizeInbound(adopted.record, adopted.receipt, "stale_binding");
				continue;
			}
			await this.#dispatchInbound(adopted.record, endpoint, adopted.receipt);
		}
	}
	async #adoptOrphanInbound(effectId: string, sessionId: string | undefined, endpointGeneration: number, payload: DiscordInboundEffectPayload, routing: DiscordInboundRouting): Promise<{ record: DiscordConversation; receipt: DiscordInboundDispatchReceipt } | undefined> {
		const key = discordConversationKey({ appId: this.options.provider.applicationId, guildId: routing.guildId, parentChannelId: routing.parentId, threadId: routing.threadId });
		const expectedId = `discord:${this.options.provider.applicationId}:${routing.guildId}:${routing.parentId}:${routing.threadId}:${routing.eventId}`;
		let record: DiscordConversation | undefined;
		let receipt: DiscordInboundDispatchReceipt | undefined;
		const structurallyValid = effectId === expectedId && payload.idempotencyKey === effectId && (payload.type === "command" ? routing.kind === "command" : routing.kind === "action" && payload.id === routing.actionId && typeof routing.actionNonce === "string");
		await this.#store.transact(key, current => {
			if (!structurallyValid || !current || current.state !== "active" || current.sessionId !== sessionId || current.endpointGeneration !== endpointGeneration) return current;
			const existing = (current.inboundDispatches ?? []).find(candidate => candidate.eventId === routing.eventId || (routing.interactionId !== undefined && candidate.interactionId === routing.interactionId));
			if (existing) {
				if (existing.effectId !== effectId || existing.idempotencyKey !== payload.idempotencyKey || existing.endpointGeneration !== endpointGeneration || existing.kind !== routing.kind || (existing.kind === "action" && (existing.actionId !== routing.actionId || existing.actionNonce !== routing.actionNonce || existing.interactionId !== routing.interactionId))) return current;

				record = current;
				receipt = existing;
				return current;
			}
			if (current.seenEventIds.includes(routing.eventId) || (routing.interactionId !== undefined && current.seenInteractionIds.includes(routing.interactionId)) || (routing.kind === "action" && (current.pendingActionId !== routing.actionId || current.pendingActionNonce !== routing.actionNonce))) return current;

			receipt = this.#receiptFromRouting(effectId, endpointGeneration, payload.idempotencyKey, routing);
			record = normalizeDiscordConversation({ ...current, generation: current.generation + 1, updatedAt: this.#now(), inboundDispatches: [...(current.inboundDispatches ?? []), receipt] });
			return record;
		});
		if (record && receipt) return { record, receipt };
		await this.#terminalizeRejectedInbound(effectId);
		return undefined;
	}
	async #terminalizeRejectedInbound(effectId: string): Promise<void> {
		await this.#effects.terminalize(effectId, { status: "rejected" });
	}
	async #terminalizeInbound(record: DiscordConversation, receipt: DiscordInboundDispatchReceipt, status: string): Promise<void> {
		await this.#effects.terminalize(receipt.effectId, { status });
		const key = discordConversationKey({ appId: record.appId, guildId: record.guildId, parentChannelId: record.parentChannelId, threadId: record.threadId! });
		await this.#store.transact(key, current => {
			const matching = current?.inboundDispatches?.find(candidate => candidate.key === receipt.key && candidate.effectId === receipt.effectId && candidate.idempotencyKey === receipt.idempotencyKey);
			if (!current || !matching) return current;
			const clearsAction = receipt.kind === "action" && current.pendingActionId === receipt.actionId && current.pendingActionNonce === receipt.actionNonce;
			return normalizeDiscordConversation({ ...current, generation: current.generation + 1, updatedAt: this.#now(), pendingActionId: clearsAction ? undefined : current.pendingActionId, pendingActionNonce: clearsAction ? undefined : current.pendingActionNonce, pendingActionEffectId: clearsAction ? undefined : current.pendingActionEffectId, inboundDispatches: current.inboundDispatches!.filter(candidate => candidate.key !== receipt.key) });
		});
	}
	async #currentInboundRecord(record: DiscordConversation, receipt: DiscordInboundDispatchReceipt): Promise<DiscordConversation | undefined> {
		const current = await this.#byThread(record.guildId, record.parentChannelId, record.threadId!);
		const claimed = current?.inboundDispatches?.find(candidate => candidate.key === receipt.key);
		if (!current || current.state !== "active" || current.sessionId !== record.sessionId || current.endpointGeneration !== receipt.endpointGeneration || !claimed || claimed.effectId !== receipt.effectId || claimed.idempotencyKey !== receipt.idempotencyKey || claimed.kind !== receipt.kind) return undefined;
		if (receipt.kind === "action" && (current.pendingActionId !== receipt.actionId || current.pendingActionNonce !== receipt.actionNonce || claimed.actionId !== receipt.actionId || claimed.actionNonce !== receipt.actionNonce || claimed.interactionId !== receipt.interactionId)) return undefined;

		return current;
	}
	#receiptFromRouting(effectId: string, endpointGeneration: number, idempotencyKey: string, routing: DiscordInboundRouting): DiscordInboundDispatchReceipt {
		return routing.kind === "command"
			? { key: routing.eventId, eventId: routing.eventId, kind: "command", endpointGeneration, effectId, idempotencyKey }
			: { key: routing.eventId, eventId: routing.eventId, interactionId: routing.interactionId!, kind: "action", actionId: routing.actionId!, actionNonce: routing.actionNonce!, endpointGeneration, effectId, idempotencyKey };
	}

	async #finishInbound(record: DiscordConversation, receipt: DiscordInboundDispatchReceipt): Promise<void> { const key = discordConversationKey({ appId: record.appId, guildId: record.guildId, parentChannelId: record.parentChannelId, threadId: record.threadId! }); await this.#store.transact(key, current => !current ? current : normalizeDiscordConversation({ ...current, generation: current.generation + 1, updatedAt: this.#now(), pendingActionId: receipt.kind === "action" && current.pendingActionId === receipt.actionId && current.pendingActionNonce === receipt.actionNonce ? undefined : current.pendingActionId, pendingActionNonce: receipt.kind === "action" && current.pendingActionId === receipt.actionId && current.pendingActionNonce === receipt.actionNonce ? undefined : current.pendingActionNonce, pendingActionEffectId: receipt.kind === "action" && current.pendingActionId === receipt.actionId && current.pendingActionNonce === receipt.actionNonce ? undefined : current.pendingActionEffectId, seenEventIds: [...current.seenEventIds, receipt.eventId], seenInteractionIds: receipt.interactionId === undefined ? current.seenInteractionIds : [...current.seenInteractionIds, receipt.interactionId], inboundDispatches: (current.inboundDispatches ?? []).filter(candidate => candidate.key !== receipt.key) })); }

	#matches(record: DiscordConversation, endpoint: DiscordEndpointBinding | null): endpoint is DiscordEndpointBinding { return endpoint !== null && endpoint.isCurrent() && record.state === "active" && record.endpointGeneration === endpoint.generation; }
	async #ensureConversation(input: DiscordNotificationInput): Promise<DiscordConversation> {
		const existing = await this.#bySession(input.sessionId);
		if (existing?.state === "active" && existing.threadId) {
			if (existing.endpointGeneration === input.endpointGeneration) return existing;
			return await this.#replace(existing, { ...existing, endpointGeneration: input.endpointGeneration });
		}
		const inFlight = this.#creates.get(input.sessionId);
		if (inFlight) return await inFlight;
		const pending = this.#create(input.sessionId, input.endpointGeneration, randomUUID(), input.threadName);
		this.#creates.set(input.sessionId, pending);
		try { return await pending; } finally { this.#creates.delete(input.sessionId); }
	}

	async #create(sessionId: string, endpointGeneration: number, nonce: string, name = "GJC session"): Promise<DiscordConversation> {
		const intentKey = this.#intentKey(sessionId);
		const owner = randomUUID();
		let intent: DiscordConversation | undefined;
		for (;;) {
			const active = await this.#bySession(sessionId);
			if (active?.state === "active" && active.threadId) return active;
			const now = this.#now();
			intent = await this.#store.transact(intentKey, old => {
				if (old?.state === "creating" && old.createOwner && (old.createLeaseExpiresAt ?? 0) > now) return old;
				return {
					generation: (old?.generation ?? 0) + 1, state: "creating", appId: this.options.provider.applicationId,
					guildId: this.options.guildId, parentChannelId: this.options.parentChannelId, sessionId, endpointGeneration,
					createNonce: old?.createNonce ?? nonce, createOwner: owner, createLeaseExpiresAt: now + 60_000,
					updatedAt: now, seenEventIds: [], seenInteractionIds: [],
				};
			});
			if (!intent) throw new Error("Unable to persist Discord create intent");
			if (intent.createOwner === owner) break;
			await Bun.sleep(Math.min(25, Math.max(1, (intent.createLeaseExpiresAt ?? now) - now)));
		}
		const active = await this.#bySession(sessionId);
		if (active?.state === "active" && active.threadId) return active;
		let thread: DiscordThread | null;
		try {
			thread = await this.#withCreateIntentLease(intent, () => this.#createThreadEffect(intent, name));
		} catch (error) {
			await this.#abandonCreator(intentKey, intent);
			throw error;
		}
		const currentIntent = await this.#store.read(intentKey);
		if (!currentIntent || currentIntent.state !== "creating" || currentIntent.createOwner !== intent.createOwner || currentIntent.generation !== intent.generation || (currentIntent.createLeaseExpiresAt ?? 0) <= this.#now()) {
			throw new Error("Discord create intent lost its fence before mapping commit");
		}
		const key = discordConversationKey({ appId: intent.appId, guildId: intent.guildId, parentChannelId: intent.parentChannelId, threadId: thread.id });
		const record = await this.#store.transact(key, old => normalizeDiscordConversation({
			generation: (old?.generation ?? 0) + 1, state: "active", appId: intent.appId, guildId: intent.guildId,
			parentChannelId: intent.parentChannelId, threadId: thread.id, sessionId, endpointGeneration, createNonce: intent.createNonce,
			updatedAt: this.#now(), seenEventIds: old?.seenEventIds ?? [], seenInteractionIds: old?.seenInteractionIds ?? [], inboundDispatches: old?.inboundDispatches,
		}));
		if (!record) throw new Error("Unable to persist Discord thread mapping");
		await this.#store.delete(intentKey, intent.generation);
		return record;
	}

	async #sessionMappings(sessionId: string): Promise<DiscordConversation[]> {
		return Object.values((await this.#store.load()).conversations)
			.filter(record => record.sessionId === sessionId && record.state !== "creating");
	}
	async #bySession(sessionId: string): Promise<DiscordConversation | undefined> {
		const document = await this.#store.load();
		return Object.values(document.conversations)
			.filter(record => record.sessionId === sessionId && record.state !== "creating")
			.sort((left, right) => stateRank(left.state) - stateRank(right.state) || right.generation - left.generation || right.updatedAt - left.updatedAt)[0];
	}
	async #byThread(guildId: string, parentChannelId: string, threadId: string): Promise<DiscordConversation | undefined> {
		return await this.#store.read(discordConversationKey({ appId: this.options.provider.applicationId, guildId, parentChannelId, threadId }));
	}
	async #replace(current: DiscordConversation, next: Omit<DiscordConversation, "generation"> & { generation?: number }): Promise<DiscordConversation> {
		const key = current.threadId ? discordConversationKey({ appId: current.appId, guildId: current.guildId, parentChannelId: current.parentChannelId, threadId: current.threadId }) : this.#intentKey(current.sessionId!);
		const result = await this.#store.write(key, current.generation, { ...next, generation: current.generation + 1, updatedAt: this.#now() });
		if (!result) {
			const stored = await this.#store.read(key);
			throw new Error(`Discord conversation changed concurrently (key=${key}, expected=${current.generation}, actual=${stored?.generation ?? "missing"})`);
		}
		return (await this.#store.read(key))!;
	}
	async #abandonCreator(intentKey: string, intent: DiscordConversation): Promise<void> {
		await this.#store.transact(intentKey, current => {
			if (!current || current.generation !== intent.generation || current.createOwner !== intent.createOwner) return current;
			return normalizeDiscordConversation({ ...current, generation: current.generation + 1, updatedAt: this.#now(), createOwner: undefined, createLeaseExpiresAt: undefined });
		});
	}
	#intentKey(sessionId: string): string { return `${this.options.provider.applicationId}:${this.options.guildId}:${this.options.parentChannelId}:creating:${sessionId}`; }
	async #withCreateIntentLease<T>(intent: DiscordConversation, work: () => Promise<T>): Promise<T> {
		let lost = false;
		let renewal: Promise<boolean> | undefined;
		let expectedGeneration = intent.generation;
		const renew = async (): Promise<boolean> => {
			if (lost) return false;
			if (renewal) return await renewal;
			const currentRenewal = (async (): Promise<boolean> => {
				const now = this.#now();
				const current = await this.#store.transact(this.#intentKey(intent.sessionId!), candidate => {
					if (!candidate || candidate.state !== "creating" || candidate.createOwner !== intent.createOwner || candidate.generation !== expectedGeneration || (candidate.createLeaseExpiresAt ?? 0) <= now) return candidate;
					return { ...candidate, generation: candidate.generation + 1, createLeaseExpiresAt: now + this.#providerLeaseMs, updatedAt: now };
				});
				if (!current || current.state !== "creating" || current.createOwner !== intent.createOwner || current.generation !== expectedGeneration + 1 || (current.createLeaseExpiresAt ?? 0) <= now) {
					lost = true;
				} else {
					expectedGeneration = current.generation;
					intent.generation = current.generation;
					intent.createLeaseExpiresAt = current.createLeaseExpiresAt;
				}
				return !lost;
			})();
			renewal = currentRenewal;
			try { return await currentRenewal; } finally { if (renewal === currentRenewal) renewal = undefined; }
		};
		if (!(await renew())) throw new Error("Discord create intent lost its fence");
		const timer = setInterval(() => { void renew().catch(() => {}); }, Math.max(1, Math.floor(this.#providerLeaseMs / 3)));
		try {
			const result = await work();
			if (!(await renew())) throw new Error("Discord create intent lost its fence");
			return result;
		} finally { clearInterval(timer); }
	}
	async #clearPending(record: DiscordConversation, actionId: string, actionNonce: string): Promise<void> {
		const key = record.threadId
			? discordConversationKey({ appId: record.appId, guildId: record.guildId, parentChannelId: record.parentChannelId, threadId: record.threadId })
			: this.#intentKey(record.sessionId!);
		await this.#store.transact(key, current => {
			if (current?.pendingActionId !== actionId || current.pendingActionNonce !== actionNonce) return current;
			return normalizeDiscordConversation({ ...current, generation: current.generation + 1, updatedAt: this.#now(), pendingActionId: undefined, pendingActionNonce: undefined, pendingActionEffectId: undefined });
		});
	}
	async #ensureActionPublication(record: DiscordConversation, actionId: string): Promise<DiscordConversation> {
		const key = discordConversationKey({ appId: record.appId, guildId: record.guildId, parentChannelId: record.parentChannelId, threadId: record.threadId! });
		const result = await this.#store.transact(key, current => {
			if (!current || current.state !== "active" || current.sessionId !== record.sessionId || current.endpointGeneration !== record.endpointGeneration) return current;
			if (current.pendingActionId === actionId && current.pendingActionNonce && current.pendingActionEffectId) return current;
			const actionNonce = current.pendingActionId === actionId && current.pendingActionNonce ? current.pendingActionNonce : randomUUID();
			return normalizeDiscordConversation({
				...current,
				generation: current.generation + 1,
				updatedAt: this.#now(),
				pendingActionId: actionId,
				pendingActionNonce: actionNonce,
				pendingActionEffectId: `action-publication:${current.threadId}:${actionId}:${actionNonce}`,
			});
		});
		if (!result || result.state !== "active" || result.sessionId !== record.sessionId || result.endpointGeneration !== record.endpointGeneration || result.pendingActionId !== actionId || !result.pendingActionNonce || !result.pendingActionEffectId) {
			throw new Error("Discord action publication intent lost its authority");
		}
		return result;
	}

	async #runEffect<TPayload>(id: string, kind: string, sessionId: string | undefined, endpointGeneration: number, payload: TPayload, operation: (ensure: () => Promise<void>) => Promise<ChatEffectReceipt>, revalidate: () => boolean | Promise<boolean>): Promise<ChatEffectReceipt> {
		const initial = await this.#rescheduleAfterEffectTransition(this.#effects.enqueue({ id, kind, transport: "discord", sessionId, endpointGeneration, payload }));
		if (initial.state === "terminal") {
			if (!initial.receipt) throw new Error(`Discord effect ${id} has no receipt`);
			return initial.receipt;
		}
		const effect = await this.#rescheduleAfterEffectTransition(this.#effects.claim<TPayload>(id, this.#providerOwner, this.#providerLeaseMs));
		if (!effect) throw new Error(`Discord effect ${id} is owned by another worker`);
		const lease: ChatEffectLease = { owner: this.#providerOwner, epoch: effect.epoch };
		let renewalLost = false;
		let renewal: Promise<boolean> | undefined;
		const renew = async (): Promise<boolean> => {
			if (renewalLost) return false;
			if (renewal) return await renewal;
			const currentRenewal = (async (): Promise<boolean> => {
				if (!(await this.#rescheduleAfterEffectTransition(this.#effects.renew(id, lease, this.#providerLeaseMs))) || !(await revalidate())) renewalLost = true;
				return !renewalLost;
			})();
			renewal = currentRenewal;
			try { return await currentRenewal; } finally { if (renewal === currentRenewal) renewal = undefined; }
		};
		const timer = setInterval(() => { void renew().catch(() => {}); }, Math.max(1, Math.floor(this.#providerLeaseMs / 3)));
		const ensure = async (): Promise<void> => { if (!(await renew())) throw new Error(`Discord effect ${id} lost its fence`); };
		try {
			await ensure();
			const receipt = await operation(ensure);
			await ensure();
			const committed = await this.#effects.record(id, lease, "terminal", receipt);
			if (!committed) throw new Error(`Discord effect ${id} lost its fence before commit`);
			return receipt;
		} catch (error) {
			if (!renewalLost) await this.#rescheduleAfterEffectTransition(this.#effects.record(id, lease, "uncertain", { status: "uncertain" }));
			throw error;
		} finally { clearInterval(timer); }
	}
	async #postEffect(id: string, record: DiscordConversation, content: string, components?: DiscordMessageComponent[], actionPublication = false): Promise<void> {
		const nonce = discordEffectNonce(id);
		await this.#runEffect(id, "post-message", record.sessionId, record.endpointGeneration!, { threadId: record.threadId!, content, nonce, ...(components ? { components } : {}) }, async ensure => {
			await ensure();
			const reconciled = await this.options.provider.findMessageByNonce({ threadId: record.threadId!, nonce });
			if (reconciled) return { provider: "discord", messageId: reconciled.id, threadId: record.threadId, status: "reconciled" };
			await ensure();
			const posted = await this.options.provider.postMessage({ threadId: record.threadId!, content, nonce, ...(components ? { components } : {}) });
			return { provider: "discord", messageId: posted.id, threadId: record.threadId, status: "posted" };
		}, async () => {
			const current = await this.#byThread(record.guildId, record.parentChannelId, record.threadId!);
			return current?.generation === record.generation
				&& current.endpointGeneration === record.endpointGeneration
				&& (!actionPublication || current.pendingActionEffectId === id);
		});
	}
	async #threadEffect(id: string, record: DiscordConversation, operation: "archive" | "unarchive", locked = false): Promise<void> {
		await this.#runEffect(id, operation, record.sessionId, record.endpointGeneration!, { threadId: record.threadId!, locked }, async ensure => {
			await ensure();
			if (operation === "archive") await this.options.provider.archiveThread({ threadId: record.threadId!, ...(locked ? { locked: true } : {}) });
			else await this.options.provider.unarchiveThread({ threadId: record.threadId! });
			return { provider: "discord", threadId: record.threadId, status: operation };
		}, async () => { const current = await this.#byThread(record.guildId, record.parentChannelId, record.threadId!); return current?.generation === record.generation && current.endpointGeneration === record.endpointGeneration; });
	}
	async #createThreadEffect(intent: DiscordConversation, name: string): Promise<DiscordThread> {
		const effectId = `create:${intent.sessionId}:${intent.createNonce}`;
		const nonce = discordEffectNonce(effectId);
		const receipt = await this.#runEffect(effectId, "create-thread", intent.sessionId, intent.endpointGeneration!, { guildId: intent.guildId, parentId: intent.parentChannelId, name, nonce }, async ensure => {
			await ensure();
			const existing = await this.options.provider.findThreadByNonce({ guildId: intent.guildId, parentId: intent.parentChannelId, nonce });
			await ensure();
			const thread = existing ?? await this.options.provider.createThread({ guildId: intent.guildId, parentId: intent.parentChannelId, name, nonce });
			return { provider: "discord", threadId: thread.id, channelId: thread.parentId, status: existing ? "reconciled" : "created" };
		}, async () => { const current = await this.#store.read(this.#intentKey(intent.sessionId!)); return current?.state === "creating" && current.createOwner === intent.createOwner && current.generation === intent.generation && (current.createLeaseExpiresAt ?? 0) > this.#now(); });
		if (!receipt.threadId) throw new Error("Discord create effect has no thread receipt");
		return { id: receipt.threadId, guildId: intent.guildId, parentId: intent.parentChannelId, archived: false };
	}
	async #recoverCreateThread(effect: ChatEffect, payload: { guildId?: string; parentId?: string; name?: string; nonce?: string }): Promise<void> {
		if (!effect.sessionId || !payload.nonce) return;
		const intentKey = this.#intentKey(effect.sessionId);
		const intent = await this.#store.read(intentKey);
		const matchesIntent = intent?.state === "creating"
			&& intent.sessionId === effect.sessionId
			&& intent.guildId === payload.guildId
			&& intent.parentChannelId === payload.parentId
			&& discordEffectNonce(`create:${intent.sessionId}:${intent.createNonce}`) === payload.nonce;
		if (!matchesIntent || !intent) {
			if (effect.state !== "terminal") await this.#effects.terminalize(effect.id, { status: "rejected" });
			return;
		}
		if (effect.state !== "terminal") {
			await this.#create(effect.sessionId, effect.endpointGeneration, intent.createNonce!, payload.name);
			return;
		}
		const threadId = effect.receipt?.threadId;
		if (!threadId) return;
		// Any durable mapping for this session is already session-level authority.
		// Do not let a terminal receipt reactivate an older remote thread merely
		// because its exact thread key is absent. Delete only this generation so a
		// later notification must mint a fresh nonce and provider effect.
		if ((await this.#sessionMappings(effect.sessionId)).length > 0) {
			await this.#store.delete(intentKey, intent.generation);
			return;
		}
		const key = discordConversationKey({ appId: intent.appId, guildId: intent.guildId, parentChannelId: intent.parentChannelId, threadId });
		const committed = await this.#store.transact(key, old => old ?? normalizeDiscordConversation({
			generation: 1, state: "active", appId: intent.appId, guildId: intent.guildId, parentChannelId: intent.parentChannelId,
			threadId, sessionId: intent.sessionId, endpointGeneration: intent.endpointGeneration, createNonce: intent.createNonce,
			updatedAt: this.#now(), seenEventIds: [], seenInteractionIds: [],
		}));
		if (committed) await this.#store.delete(intentKey, intent.generation);
	}
	async #drainProviderEffects(): Promise<boolean> {
		let failed = false;
		for (const effect of await this.#effects.list()) {
			if (effect.transport !== "discord" || (effect.state === "terminal" && effect.kind !== "create-thread")) continue;
			const payload = effect.payload as { guildId?: string; parentId?: string; name?: string; nonce?: string; threadId?: string; content?: string; components?: DiscordMessageComponent[]; locked?: boolean };
			const providerEffect = effect.kind === "post-message" || effect.kind === "archive" || effect.kind === "unarchive";
			if (providerEffect && (!effect.sessionId || !payload.threadId || (effect.kind === "post-message" && payload.content === undefined))) {
				await this.#effects.terminalize(effect.id, { status: "stale_noop" });
				continue;
			}
			try {
				if (effect.kind === "create-thread" && effect.sessionId && payload.nonce) {
					await this.#recoverCreateThread(effect, payload);
				}
				if (effect.kind === "post-message" && payload.threadId && payload.content !== undefined) {
					const record = await this.#byThread(this.options.guildId, this.options.parentChannelId, payload.threadId);
					if (!record || record.state !== "active" || record.endpointGeneration !== effect.endpointGeneration || (effect.id.startsWith("action-publication:") && record.pendingActionEffectId !== effect.id)) {
						await this.#effects.terminalize(effect.id, { status: "stale_noop" });
					} else {
						await this.#postEffect(effect.id, record, payload.content, payload.components, effect.id.startsWith("action-publication:"));
					}
				}
				if ((effect.kind === "archive" || effect.kind === "unarchive") && payload.threadId) {
					const record = await this.#byThread(this.options.guildId, this.options.parentChannelId, payload.threadId);
					if (!record || (effect.kind === "archive" ? record.state !== "active" : record.state !== "resuming") || record.endpointGeneration !== effect.endpointGeneration) {
						await this.#effects.terminalize(effect.id, { status: "stale_noop" });
					} else {
						await this.#threadEffect(effect.id, record, effect.kind, payload.locked);
					}
				}
			} catch { failed = true; /* retained for a later journal-authoritative replay */ }
		}
		return failed;
	}
	async #rescheduleAfterEffectTransition<T extends ChatEffect | undefined>(transition: Promise<T>): Promise<T> {
		const effect = await transition;
		if (effect?.state !== "terminal") await this.#scheduleLeaseRecovery();
		return effect;
	}
	async #scheduleLeaseRecovery(recoveryFailed = false): Promise<void> {
		if (!this.#started) return;
		const now = this.#now();
		const recoveryAt = (await this.#effects.list())
			.filter(effect => effect.transport === "discord")
			.reduce<number | undefined>((earliest, effect) => {
				const claimAt = effect.state === "leased" && Number.isFinite(effect.leaseExpiresAt)
					? effect.leaseExpiresAt
					: effect.state === "pending" || effect.state === "accepted" || (effect.state === "uncertain" && !effect.kind.includes(".inbound.")) ? now : undefined;
				return claimAt === undefined || (earliest !== undefined && earliest <= claimAt) ? earliest : claimAt;
			}, recoveryFailed ? now : undefined);
		if (recoveryAt === undefined) {
			if (this.#leaseRecoveryTimer) clearTimeout(this.#leaseRecoveryTimer);
			this.#leaseRecoveryTimer = undefined;
			this.#leaseRecoveryAt = undefined;
			this.#leaseRecoveryFailures = 0;
			return;
		}
		if (this.#leaseRecoveryAt !== undefined && this.#leaseRecoveryAt <= recoveryAt) return;
		if (this.#leaseRecoveryTimer) clearTimeout(this.#leaseRecoveryTimer);
		this.#leaseRecoveryAt = recoveryAt;
		const delay = recoveryAt <= now ? Math.min(1_000, 25 * 2 ** Math.min(this.#leaseRecoveryFailures, 5)) : Math.min(recoveryAt - now, 2_147_483_647);
		this.#leaseRecoveryTimer = setTimeout(() => {
			this.#leaseRecoveryTimer = undefined;
			this.#leaseRecoveryAt = undefined;
			void this.#track(this.#recoverLeasedEffects());
		}, delay);
	}
	async #recoverLeasedEffects(): Promise<void> {
		if (!this.#started) return;
		let failed = false;
		try {
			try { failed ||= await this.#drainProviderEffects(); } catch { failed = true; }
			try { await this.#drainPendingDispatches(); } catch { failed = true; }
		} finally {
			if (failed) this.#leaseRecoveryFailures = Math.min(this.#leaseRecoveryFailures + 1, 5);
			else this.#leaseRecoveryFailures = Math.min(this.#leaseRecoveryFailures + 1, 5);
			try { await this.#scheduleLeaseRecovery(failed); } catch { /* retained effects are retried by the next trigger */ }
		}
	}

	async #fail(threadId: string): Promise<void> { try { const record = await this.#byThread(this.options.guildId, this.options.parentChannelId, threadId); if (record) await this.#postEffect(`failure:${threadId}:${randomUUID()}`, record, FAILURE); } catch {} }
}

function decodeCustomId(value: string): { generation: number; actionId: string; actionNonce: string } | undefined {
	const match = /^gjc:(\d+):([^:]+):([0-9a-f-]{36})$/.exec(value);
	if (!match) return undefined;
	const generation = Number(match[1]);
	return Number.isSafeInteger(generation) && generation >= 0 ? { generation, actionId: match[2]!, actionNonce: match[3]! } : undefined;
}


function stateRank(state: DiscordConversation["state"]): number {
	return state === "active" ? 0 : state === "resuming" ? 1 : state === "archived" ? 2 : state === "closed" ? 3 : 4;
}

function actionComponents(generation: number, actionId: string, actionNonce: string, options: string[]): DiscordMessageComponent[] {
	return [{
		type: 1,
		components: [{
			type: 3,
			customId: `gjc:${generation}:${actionId}:${actionNonce}`,
			placeholder: "Choose an option",
			minValues: 1,
			maxValues: 1,
			options: options.slice(0, 25).map((option, index) => ({ label: option.slice(0, 100) || `Option ${index + 1}`, value: String(index) })),
		}],
	}];
}

function componentAnswer(value: string | number): string | number {
	if (typeof value === "string" && /^\d+$/.test(value)) {
		const index = Number(value);
		if (Number.isSafeInteger(index)) return index;
	}
	return value;
}

function discordEffectNonce(effectId: string): string {
	// Discord nonces are bounded; hash the durable effect identifier rather than
	// truncating its potentially shared prefix.
	return `gjc-${createHash("sha256").update(effectId).digest("hex").slice(0, 21)}`;
}
