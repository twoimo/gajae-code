import { randomUUID } from "node:crypto";
import { SdkClientError } from "../client/client";
import { readSdkSessionEndpoint, type SdkSessionEndpoint } from "../client/discovery";
import { ConversationStore } from "./conversation-store";
import {
	acceptsSlackInbound,
	normalizeSlackConversation,
	type SlackConversation,
	type SlackInboundDispatchReceipt,
	slackConversationKey,
} from "./slack-conversation";

export class SlackEndpointBindingError extends Error {
	constructor(message = "Slack session endpoint changed before dispatch.") {
		super(message);
		this.name = "SlackEndpointBindingError";
	}
}

class SlackStaleEffectError extends Error {
	constructor() {
		super("Slack effect is no longer current");
	}
}

import { type ChatEffect, ChatEffectJournal, type ChatEffectLease } from "./chat-effect-journal";
import { SlackProviderError } from "./slack-live-provider";
import type { SlackPostedMessage, SlackProvider, SlackSocketEnvelope } from "./slack-provider";

export interface SlackEndpoint extends SdkSessionEndpoint {
	generation: number;
}

export interface SlackSdkClient {
	send(frame: Record<string, unknown>): void;
}

export interface SlackNotificationDaemonOptions {
	agentDir: string;
	repo: string;
	teamId: string;
	channelId: string;
	provider: SlackProvider;
	botUserId?: string;
	store?: ConversationStore<SlackConversation>;
	now?: () => number;
	randomId?: () => string;
	/** Stable identity for the process attempting durable provider publication. */
	publicationOwnerId?: string;
	publicationLeaseMs?: number;

	resolveEndpoint?: (sessionId: string) => Promise<SlackEndpoint | null>;
	createClient: (endpoint: SlackEndpoint) => SlackSdkClient;
	onCommand?: (
		sessionId: string,
		content: string,
		endpoint: SlackEndpoint,
		idempotencyKey: string,
	) => Promise<boolean>;
}

type SlackEvent = {
	type?: unknown;
	channel?: unknown;
	ts?: unknown;
	thread_ts?: unknown;
	user?: unknown;
	bot_id?: unknown;
	subtype?: unknown;
	text?: unknown;
	client_msg_id?: unknown;
};

type EventsPayload = {
	type?: unknown;
	event_id?: unknown;
	team_id?: unknown;
	event_context?: unknown;
	event?: SlackEvent;
};
type SlackInboundRouting = {
	teamId: string;
	channelId: string;
	rootTs: string;
	eventId: string;
	interactionId: string;
	retryKey: string;
	eventContext?: string;
	kind: "action" | "command";
	actionId?: string;
};

type SlackInboundEffectPayload =
	| { type: "reply"; id: string; answer: string; idempotencyKey: string; routing: SlackInboundRouting }
	| { type: "command"; content: string; idempotencyKey: string; routing: SlackInboundRouting };

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function messageFromEnvelope(
	payload: unknown,
):
	| { eventId: string; eventContext?: string; teamId: string; channelId: string; rootTs: string; event: SlackEvent }
	| undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const eventPayload = payload as EventsPayload;
	if (eventPayload.type !== "events_api" || !eventPayload.event || eventPayload.event.type !== "message")
		return undefined;
	const eventId = text(eventPayload.event_id);
	const teamId = text(eventPayload.team_id);
	const channelId = text(eventPayload.event.channel);
	const ts = text(eventPayload.event.ts);
	const rootTs = text(eventPayload.event.thread_ts) ?? ts;
	if (!eventId || !teamId || !channelId || !rootTs) return undefined;
	return {
		eventId,
		eventContext: text(eventPayload.event_context),
		teamId,
		channelId,
		rootTs,
		event: eventPayload.event,
	};
}

function nextRecord(record: SlackConversation, update: Partial<SlackConversation>): SlackConversation {
	return normalizeSlackConversation({ ...record, ...update, generation: record.generation + 1 });
}

/**
 * Slack Socket Mode notification daemon. Accepted inbound SDK effects are
 * persisted before acknowledgement, including their replay payload and captured
 * endpoint generation; endpoint credentials and Socket Mode cursors are never
 * written to disk.
 */

export class SlackNotificationDaemon {
	readonly store: ConversationStore<SlackConversation>;
	readonly #now: () => number;
	readonly #randomId: () => string;
	readonly #resolveEndpoint: (sessionId: string) => Promise<SlackEndpoint | null>;
	readonly #publicationOwnerId: string;
	readonly #publicationLeaseMs: number;
	readonly #journal: ChatEffectJournal;

	readonly #inflightInbound = new Set<string>();
	readonly #activeWork = new Set<Promise<unknown>>();
	#started = false;
	#leaseRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
	#leaseRecoveryAt: number | undefined;
	#leaseRecoveryFailures = 0;
	#recoveringLeasedEffects = false;

	constructor(private readonly options: SlackNotificationDaemonOptions) {
		this.store =
			options.store ?? new ConversationStore<SlackConversation>({ agentDir: options.agentDir, kind: "slack" });
		this.#now = options.now ?? Date.now;
		this.#randomId = options.randomId ?? randomUUID;
		this.#publicationOwnerId = options.publicationOwnerId ?? randomUUID();
		this.#publicationLeaseMs = options.publicationLeaseMs ?? 30_000;
		this.#journal = new ChatEffectJournal({ agentDir: options.agentDir, transport: "slack", now: this.#now });
		this.#resolveEndpoint =
			options.resolveEndpoint ??
			(async sessionId => {
				const endpoint = await readSdkSessionEndpoint(options.repo, sessionId);
				return endpoint ? { ...endpoint, generation: 1 } : null;
			});
	}

	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		try {
			// Recovery is a barrier: Socket Mode must not ACK an envelope before the
			// mapping authority represented by durable effects has been restored.
			await this.#reconcileTerminalProviderReceipts();
			const providerRecoveryFailed = await this.#drainProviderEffects();
			await this.#drainPendingDispatches();
			await this.#scheduleLeaseRecovery(providerRecoveryFailed);
			await this.options.provider.start(async envelope => {
				await this.#track(this.handleEnvelope(envelope));
			});
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

	/** Accepted inbound effects are durably claimed before their Socket Mode ACK. */
	async handleEnvelope(envelope: SlackSocketEnvelope): Promise<boolean> {
		if (!text(envelope.envelope_id)) return false;
		const inbound = messageFromEnvelope(envelope.payload);
		if (!inbound || inbound.teamId !== this.options.teamId || inbound.channelId !== this.options.channelId) {
			await this.options.provider.ack(envelope.envelope_id);
			return false;
		}
		if (
			inbound.event.bot_id ||
			inbound.event.subtype === "bot_message" ||
			inbound.event.user === this.options.botUserId
		) {
			await this.options.provider.ack(envelope.envelope_id);
			return false;
		}
		const claim = await this.#claimInbound(inbound);
		if (!claim) {
			await this.options.provider.ack(envelope.envelope_id);
			return false;
		}
		const inflightKey = `${claim.key}\u0000${claim.receipt.key}`;
		if (this.#inflightInbound.has(inflightKey)) {
			await this.options.provider.ack(envelope.envelope_id);
			return false;
		}
		this.#inflightInbound.add(inflightKey);
		try {
			await this.options.provider.ack(envelope.envelope_id);
			return await this.#dispatchInbound(claim);
		} finally {
			this.#inflightInbound.delete(inflightKey);
			await this.#scheduleLeaseRecovery();
		}
	}

	#track<T>(work: Promise<T>): Promise<T> {
		this.#activeWork.add(work);
		return work.finally(() => this.#activeWork.delete(work));
	}

	async postRoot(sessionId: string, body: string, endpointGeneration?: number): Promise<SlackConversation> {
		const pendingKey = this.#intentKey(sessionId);
		let claimed = false;
		const pending = await this.store.transact(pendingKey, current => {
			if (current?.state === "active") return current;
			const now = this.#now();
			if (current?.state === "posting_root") {
				if (
					current.rootPublicationOwner === this.#publicationOwnerId ||
					!this.#leaseExpired(current.rootPublicationLeaseExpiresAt, now)
				)
					return current;
				claimed = true;
				return nextRecord(current, {
					rootPublicationOwner: this.#publicationOwnerId,
					rootPublicationLeaseExpiresAt: now + this.#publicationLeaseMs,
					rootPublicationFence: (current.rootPublicationFence ?? 0) + 1,
					updatedAt: now,
				});
			}
			claimed = true;
			return {
				generation: (current?.generation ?? 0) + 1,
				state: "posting_root",
				teamId: this.options.teamId,
				channelId: this.options.channelId,
				sessionId,
				clientMsgId: this.#randomId(),
				rootPublicationOwner: this.#publicationOwnerId,
				rootPublicationLeaseExpiresAt: now + this.#publicationLeaseMs,
				rootPublicationFence: (current?.rootPublicationFence ?? 0) + 1,
				endpointGeneration,
				updatedAt: now,
				seenEventIds: current?.seenEventIds ?? [],
				seenContextIds: current?.seenContextIds ?? [],
				seenRetryKeys: current?.seenRetryKeys ?? [],
				seenInteractionIds: current?.seenInteractionIds ?? [],
				inboundDispatches: current?.inboundDispatches ?? [],
			};
		});
		if (!pending?.clientMsgId) throw new Error("Unable to persist Slack root post intent");
		if (pending.state === "active") return pending;
		if (!claimed) return await this.#waitForRoot(pendingKey, sessionId, body, endpointGeneration);
		const clientMsgId = pending.clientMsgId;
		const fence = pending.rootPublicationFence;
		if (fence === undefined) throw new Error("Unable to fence Slack root post intent");
		let posted: SlackPostedMessage | null = null;
		try {
			await this.#withRootLease(pendingKey, clientMsgId, fence, async () => {
				posted = await this.#postDurable(`root:${sessionId}:${clientMsgId}`, sessionId, endpointGeneration ?? 0, {
					channel: this.options.channelId,
					text: body,
					clientMsgId,
				});
			});
		} catch (error) {
			if (this.#isUncertainPostFailure(error)) {
				// The journal retains the stable root effect for fenced reconciliation.
			}
			if (!posted) {
				if (!this.#isUncertainPostFailure(error)) {
					await this.store.transact(pendingKey, current =>
						current?.clientMsgId === clientMsgId &&
						current.rootPublicationOwner === this.#publicationOwnerId &&
						current.rootPublicationFence === fence
							? nextRecord(current, {
									state: "error",
									rootPublicationOwner: undefined,
									rootPublicationLeaseExpiresAt: undefined,
									updatedAt: this.#now(),
									lastError: "provider_failure",
								})
							: current,
					);
				}
				throw error;
			}
		}
		if (!posted) throw new Error("Slack root post was not confirmed");
		const confirmedPosted = posted as SlackPostedMessage;
		const endpoint = await this.#withRootLease(
			pendingKey,
			clientMsgId,
			fence,
			async () => await this.#resolveEndpoint(sessionId),
		);
		const generation = endpointGeneration ?? endpoint?.generation;
		const active = await this.store.transact(pendingKey, current => {
			if (
				!current ||
				current.clientMsgId !== clientMsgId ||
				current.rootPublicationOwner !== this.#publicationOwnerId ||
				current.rootPublicationFence !== fence
			)
				return current;
			const endpointMatches =
				endpoint && (endpointGeneration === undefined || endpoint.generation === endpointGeneration);
			return nextRecord(current, {
				state: endpointMatches ? "active" : "error",
				rootTs: confirmedPosted.ts,
				endpointGeneration: generation,
				updatedAt: this.#now(),
				lastError: endpointMatches ? undefined : "endpoint_unavailable",
				rootPublicationOwner: undefined,
				rootPublicationLeaseExpiresAt: undefined,
			});
		});
		if (!active) throw new Error("Slack root mapping disappeared");
		if (active.state !== "active") return await this.#waitForRoot(pendingKey, sessionId, body, endpointGeneration);
		return active;
	}

	/** Deliver a notification into the mapped root thread, creating that root once. */
	async notify(sessionId: string, body: string, actionId?: string): Promise<SlackConversation> {
		const existing = await this.findSession(sessionId, false);
		const usedExistingRoot = existing?.record.state === "active" && !!existing.record.rootTs;
		const conversation = usedExistingRoot ? existing.record : await this.postRoot(sessionId, body);
		if (!conversation.rootTs) return conversation;
		const key = existing?.key ?? this.#intentKey(sessionId);
		if (!usedExistingRoot) {
			if (!actionId) return conversation;
			const active = await this.store.transact(key, current =>
				current && acceptsSlackInbound(current, conversation.rootTs!, current.endpointGeneration ?? -1)
					? nextRecord(current, { pendingActionId: actionId, updatedAt: this.#now() })
					: current,
			);
			if (!active) throw new Error("Slack root disappeared while activating action authority");
			return active;
		}
		if (!actionId) {
			await this.#postDurable(
				`notification:${sessionId}:${this.#randomId()}`,
				sessionId,
				conversation.endpointGeneration ?? 0,
				{
					channel: conversation.channelId,
					threadTs: conversation.rootTs,
					text: body,
					clientMsgId: this.#randomId(),
				},
			);
			return conversation;
		}
		let actionClaimed = false;
		const intent = await this.store.transact(key, current => {
			if (!current || !acceptsSlackInbound(current, conversation.rootTs!, current.endpointGeneration ?? -1))
				return current;
			const now = this.#now();
			if (current.outboundActionId && current.outboundActionId !== actionId) return current;
			if (current.outboundActionId === actionId) {
				if (
					current.outboundActionOwner === this.#publicationOwnerId ||
					!this.#leaseExpired(current.outboundActionLeaseExpiresAt, now)
				)
					return current;
				actionClaimed = true;
				return nextRecord(current, {
					outboundActionOwner: this.#publicationOwnerId,
					outboundActionLeaseExpiresAt: now + this.#publicationLeaseMs,
					outboundActionFence: (current.outboundActionFence ?? 0) + 1,
					updatedAt: now,
				});
			}
			actionClaimed = true;
			return nextRecord(current, {
				outboundActionId: actionId,
				outboundActionClientMsgId: this.#randomId(),
				outboundActionOwner: this.#publicationOwnerId,
				outboundActionLeaseExpiresAt: now + this.#publicationLeaseMs,
				outboundActionFence: (current.outboundActionFence ?? 0) + 1,
				updatedAt: now,
			});
		});
		if (!intent || intent.outboundActionId !== actionId || !intent.outboundActionClientMsgId) {
			throw new Error("Another Slack action publication is pending");
		}
		if (!actionClaimed) return await this.#waitForAction(key, sessionId, body, actionId);
		const clientMsgId = intent.outboundActionClientMsgId;
		const fence = intent.outboundActionFence;
		if (fence === undefined) throw new Error("Unable to fence Slack action post intent");
		let published: SlackPostedMessage | null = null;
		try {
			await this.#withActionLease(key, clientMsgId, fence, async () => {
				published = await this.#postDurable(
					`action:${sessionId}:${actionId}`,
					sessionId,
					conversation.endpointGeneration ?? 0,
					{ channel: conversation.channelId, threadTs: conversation.rootTs, text: body, clientMsgId },
				);
			});
		} catch (error) {
			if (this.#isUncertainPostFailure(error)) {
				// The journal retains the stable action effect for fenced reconciliation.
			}
			if (!published) {
				if (!this.#isUncertainPostFailure(error)) {
					await this.store.transact(key, current =>
						current?.outboundActionClientMsgId === clientMsgId &&
						current.outboundActionOwner === this.#publicationOwnerId &&
						current.outboundActionFence === fence
							? nextRecord(current, {
									outboundActionId: undefined,
									outboundActionClientMsgId: undefined,
									outboundActionOwner: undefined,
									outboundActionLeaseExpiresAt: undefined,
									updatedAt: this.#now(),
								})
							: current,
					);
				}
				throw error;
			}
		}
		const active = await this.store.transact(key, current =>
			current?.outboundActionClientMsgId === clientMsgId &&
			current.outboundActionOwner === this.#publicationOwnerId &&
			current.outboundActionFence === fence
				? nextRecord(current, {
						pendingActionId: actionId,
						outboundActionId: undefined,
						outboundActionClientMsgId: undefined,
						outboundActionOwner: undefined,
						outboundActionLeaseExpiresAt: undefined,
						updatedAt: this.#now(),
					})
				: current,
		);
		if (!active) throw new Error("Slack conversation disappeared while activating action authority");
		return active;
	}

	/** Posts a safe command outcome to the active mapped root thread. */
	async postCommandResult(sessionId: string, content: string): Promise<boolean> {
		const found = await this.findSession(sessionId, false);
		if (found?.record.state !== "active" || !found.record.rootTs) return false;
		await this.#postDurable(
			`command-result:${sessionId}:${this.#randomId()}`,
			sessionId,
			found.record.endpointGeneration ?? 0,
			{
				channel: found.record.channelId,
				threadTs: found.record.rootTs,
				text: content,
				clientMsgId: this.#randomId(),
			},
		);
		return true;
	}

	async resolveAction(sessionId: string, actionId: string): Promise<void> {
		const found = await this.findSession(sessionId, true);
		if (!found) return;
		await this.store.transact(found.key, current =>
			current?.pendingActionId === actionId
				? nextRecord(current, { pendingActionId: undefined, updatedAt: this.#now() })
				: current,
		);
	}

	async close(sessionId: string, marker = "Session closed."): Promise<boolean> {
		const found = await this.findSession(sessionId, true);
		if (!found?.record.rootTs || found.record.state !== "active") return false;
		await this.#postDurable(
			`close-marker:${sessionId}:${found.record.clientMsgId ?? found.record.rootTs}`,
			sessionId,
			found.record.endpointGeneration ?? 0,
			{
				channel: found.record.channelId,
				threadTs: found.record.rootTs,
				text: marker,
				clientMsgId: this.#randomId(),
			},
		);
		await this.store.transact(found.key, current =>
			current
				? nextRecord(current, { state: "closed_marker", pendingActionId: undefined, updatedAt: this.#now() })
				: current,
		);

		return true;
	}

	async resume(sessionId: string, body: string, endpointGeneration?: number): Promise<SlackConversation> {
		const previous = await this.findSession(sessionId, true);
		if (
			previous?.record.state === "active" &&
			endpointGeneration !== undefined &&
			previous.record.endpointGeneration === endpointGeneration
		)
			return previous.record;
		if (previous?.record.state === "active") {
			try {
				await this.close(sessionId);
			} catch (error) {
				if (!(error instanceof SlackStaleEffectError)) throw error;
			}
		}
		if (previous) {
			await this.store.transact(previous.key, current =>
				current
					? nextRecord(current, { state: "resumed_root", pendingActionId: undefined, updatedAt: this.#now() })
					: current,
			);
		}
		return await this.postRoot(sessionId, body, endpointGeneration);
	}

	async #claimInbound(inbound: {
		eventId: string;
		eventContext?: string;
		teamId: string;
		channelId: string;
		rootTs: string;
		event: SlackEvent;
	}): Promise<
		{ key: string; endpoint: SlackEndpoint; sessionId: string; receipt: SlackInboundDispatchReceipt } | undefined
	> {
		const document = await this.store.load();
		const matched = Object.entries(document.conversations)
			.map(([mappingKey, candidate]) => ({ mappingKey, candidate }))
			.filter(
				({ candidate }) =>
					candidate.teamId === inbound.teamId &&
					candidate.channelId === inbound.channelId &&
					candidate.rootTs === inbound.rootTs,
			)
			.sort(
				(left, right) =>
					(right.candidate.endpointGeneration ?? -1) - (left.candidate.endpointGeneration ?? -1) ||
					right.candidate.generation - left.candidate.generation ||
					right.candidate.updatedAt - left.candidate.updatedAt,
			)[0];
		if (!matched) return undefined;
		const { mappingKey: key, candidate: record } = matched;
		if (
			!record.sessionId ||
			!record.endpointGeneration ||
			!acceptsSlackInbound(record, inbound.rootTs, record.endpointGeneration)
		)
			return undefined;
		const endpoint = await this.#resolveEndpoint(record.sessionId);
		if (!endpoint || endpoint.generation !== record.endpointGeneration) return undefined;
		const interactionId = text(inbound.event.client_msg_id) ?? inbound.eventId;
		const retryKey = `${inbound.eventId}:${interactionId}`;
		const inboundText = text(inbound.event.text);
		const command = inboundText?.startsWith("/sdk ") ?? false;

		const idempotencyKey = `slack:${inbound.teamId}:${inbound.channelId}:${inbound.rootTs}:${inbound.eventId}:${interactionId}`;
		const effectId = `inbound:${inbound.teamId}:${inbound.channelId}:${inbound.rootTs}:${inbound.eventId}:${interactionId}`;
		const routing: SlackInboundRouting = {
			teamId: inbound.teamId,
			channelId: inbound.channelId,
			rootTs: inbound.rootTs,
			eventId: inbound.eventId,
			interactionId,
			retryKey,
			eventContext: inbound.eventContext,
			kind: command ? "command" : "action",
			...(command ? {} : record.pendingActionId ? { actionId: record.pendingActionId } : {}),
		};
		const payload: SlackInboundEffectPayload | undefined = command
			? { type: "command", content: inboundText!, idempotencyKey, routing }
			: record.pendingActionId
				? { type: "reply", id: record.pendingActionId, answer: inboundText ?? "", idempotencyKey, routing }
				: undefined;
		if (!payload) return undefined;
		await this.#rescheduleAfterEffectTransition(
			this.#journal.enqueue({
				id: effectId,
				kind: command ? "sdk.inbound.command" : "sdk.inbound.reply",
				transport: "slack",
				sessionId: record.sessionId,
				endpointGeneration: endpoint.generation,
				payload,
			}),
		);
		let sessionId: string | undefined;
		let receipt: SlackInboundDispatchReceipt | undefined;
		await this.store.transact(key, current => {
			if (!current?.sessionId || !acceptsSlackInbound(current, inbound.rootTs, endpoint.generation)) return current;
			const existing = (current.inboundDispatches ?? []).find(
				candidate =>
					candidate.eventId === inbound.eventId ||
					candidate.interactionId === interactionId ||
					candidate.retryKey === retryKey ||
					(inbound.eventContext !== undefined && candidate.eventContext === inbound.eventContext),
			);
			if (existing) {
				sessionId = current.sessionId;
				receipt = existing;
				return current;
			}
			if (
				current.seenEventIds.includes(inbound.eventId) ||
				current.seenInteractionIds.includes(interactionId) ||
				current.seenRetryKeys.includes(retryKey) ||
				(inbound.eventContext !== undefined && current.seenContextIds.includes(inbound.eventContext)) ||
				(!command && !current.pendingActionId)
			)
				return current;
			sessionId = current.sessionId;
			receipt = {
				key: `${inbound.eventId}:${interactionId}`,
				eventId: inbound.eventId,
				interactionId,
				retryKey,
				eventContext: inbound.eventContext,
				kind: command ? "command" : "action",
				...(command ? {} : { actionId: current.pendingActionId }),
				endpointGeneration: endpoint.generation,
				effectId,
				idempotencyKey,
			};
			return nextRecord(current, {
				inboundDispatches: [...(current.inboundDispatches ?? []), receipt],
				updatedAt: this.#now(),
			});
		});
		return sessionId && receipt ? { key, endpoint, sessionId, receipt } : undefined;
	}

	async #dispatchInbound(claim: {
		key: string;
		endpoint: SlackEndpoint;
		sessionId: string;
		receipt: SlackInboundDispatchReceipt;
	}): Promise<boolean> {
		const current = await this.store.read(claim.key);
		if (
			!current ||
			!acceptsSlackInbound(current, current.rootTs ?? "", claim.endpoint.generation) ||
			claim.receipt.endpointGeneration !== claim.endpoint.generation ||
			!(current.inboundDispatches ?? []).some(receipt => receipt.key === claim.receipt.key)
		)
			return false;
		return await this.#dispatchEffect(claim, claim.receipt.effectId);
	}

	async #dispatchEffect(
		claim: { key: string; endpoint: SlackEndpoint; sessionId: string; receipt: SlackInboundDispatchReceipt },
		effectId: string,
	): Promise<boolean> {
		const effect = await this.#rescheduleAfterEffectTransition(
			this.#journal.claim<
				| { type: "reply"; id: string; answer: string; idempotencyKey: string }
				| { type: "command"; content: string; idempotencyKey: string }
			>(effectId, this.#publicationOwnerId, Math.max(this.#publicationLeaseMs, 100)),
		);
		if (!effect) return false;
		const lease: ChatEffectLease = { owner: this.#publicationOwnerId, epoch: effect.epoch };
		try {
			if (effect.payload.type === "command") {
				const payload = effect.payload;
				const accepted = await this.#withEffectLease(effect.id, lease, async () => {
					if (!(await this.#inboundEffectCurrent(claim, effect.id))) throw new SlackStaleEffectError();
					return await (this.options.onCommand?.(
						claim.sessionId,
						payload.content,
						claim.endpoint,
						payload.idempotencyKey,
					) ?? Promise.resolve(false));
				});
				if (!(await this.#inboundEffectCurrent(claim, effect.id))) return false;
				const recorded = await this.#journal.record(effect.id, lease, "terminal", {
					status: accepted ? "accepted" : "rejected",
				});
				if (recorded) await this.#finishDispatch(claim, "terminal");
				return accepted && !!recorded;
			}
			await this.#withEffectLease(effect.id, lease, async () => {
				if (!(await this.#inboundEffectCurrent(claim, effect.id))) throw new SlackStaleEffectError();
				this.options.createClient(claim.endpoint).send(effect.payload);
			});
			if (!(await this.#inboundEffectCurrent(claim, effect.id))) return false;
			const recorded = await this.#journal.record(effect.id, lease, "terminal", { status: "sent" });
			if (recorded) await this.#finishDispatch(claim, "terminal");
			return !!recorded;
		} catch (error) {
			if (error instanceof SlackStaleEffectError) return false;
			const state = this.#isDefiniteSdkPreSendFailure(error) ? "accepted" : "uncertain";
			const recorded = await this.#rescheduleAfterEffectTransition(
				this.#journal.record(effect.id, lease, state, { status: state }),
			);
			if (recorded && state === "accepted") await this.#releaseDispatch(claim);
			else if (recorded) await this.#finishDispatch(claim, "uncertain");
			return false;
		}
	}

	async #inboundEffectCurrent(
		claim: { key: string; endpoint: SlackEndpoint; sessionId: string; receipt: SlackInboundDispatchReceipt },
		effectId: string,
	): Promise<boolean> {
		const endpoint = await this.#resolveEndpoint(claim.sessionId);
		if (!endpoint || endpoint.generation !== claim.endpoint.generation) return false;
		const current = await this.store.read(claim.key);
		return (
			!!current &&
			current.sessionId === claim.sessionId &&
			acceptsSlackInbound(current, current.rootTs ?? "", claim.endpoint.generation) &&
			claim.receipt.endpointGeneration === claim.endpoint.generation &&
			(current.inboundDispatches ?? []).some(
				receipt => receipt.key === claim.receipt.key && receipt.effectId === effectId,
			)
		);
	}

	async #withEffectLease<T>(id: string, lease: ChatEffectLease, operation: () => Promise<T>): Promise<T> {
		// The effect was just claimed, so its lease is current. The periodic renewal
		// still protects the external operation without another durable write first.
		return await this.#withRenewal(
			operation,
			async () => {
				if (
					!(await this.#rescheduleAfterEffectTransition(
						this.#journal.renew(id, lease, Math.max(this.#publicationLeaseMs, 100)),
					))
				)
					throw new Error("Slack effect lease renewal failed");
			},
			false,
		);
	}

	async #drainPendingDispatches(): Promise<void> {
		const document = await this.store.load();
		const mappedEffectIds = new Set<string>();
		for (const [key, record] of Object.entries(document.conversations)) {
			if (!record.sessionId || !record.rootTs || record.state !== "active") continue;
			for (const receipt of record.inboundDispatches ?? []) {
				mappedEffectIds.add(receipt.effectId);
				if (receipt.endpointGeneration !== record.endpointGeneration) continue;
				const endpoint = await this.#resolveEndpoint(record.sessionId);
				if (!endpoint || endpoint.generation !== receipt.endpointGeneration) continue;
				const inflightKey = `${key}\u0000${receipt.key}`;
				if (this.#inflightInbound.has(inflightKey)) continue;
				this.#inflightInbound.add(inflightKey);
				try {
					await this.#dispatchInbound({ key, endpoint, sessionId: record.sessionId, receipt });
				} finally {
					this.#inflightInbound.delete(inflightKey);
				}
			}
		}
		for (const effect of await this.#journal.list()) {
			if (
				mappedEffectIds.has(effect.id) ||
				effect.transport !== "slack" ||
				effect.state === "terminal" ||
				!effect.sessionId ||
				(effect.kind !== "sdk.inbound.command" && effect.kind !== "sdk.inbound.reply")
			)
				continue;
			const adopted = await this.#adoptOrphanInbound(effect as ChatEffect<SlackInboundEffectPayload>);
			if (!adopted) continue;
			const endpoint = await this.#resolveEndpoint(adopted.sessionId);
			if (
				!endpoint ||
				endpoint.generation !== adopted.receipt.endpointGeneration ||
				!(await this.#inboundEffectCurrent(
					{ key: adopted.key, endpoint, sessionId: adopted.sessionId, receipt: adopted.receipt },
					effect.id,
				))
			) {
				await this.#terminalizeRejectedInbound(effect.id);
				continue;
			}
			await this.#dispatchInbound({
				key: adopted.key,
				endpoint,
				sessionId: adopted.sessionId,
				receipt: adopted.receipt,
			});
		}
	}

	async #adoptOrphanInbound(
		effect: ChatEffect<SlackInboundEffectPayload>,
	): Promise<{ key: string; sessionId: string; receipt: SlackInboundDispatchReceipt } | undefined> {
		const payload = effect.payload;
		const routing = payload?.routing;
		if (!routing) {
			await this.#terminalizeRejectedInbound(effect.id);
			return undefined;
		}
		const matches = Object.entries((await this.store.load()).conversations).filter(
			([, record]) =>
				record.teamId === routing.teamId &&
				record.channelId === routing.channelId &&
				record.rootTs === routing.rootTs,
		);
		if (matches.length !== 1) {
			await this.#terminalizeRejectedInbound(effect.id);
			return undefined;
		}
		const key = matches[0]![0];
		const expectedEffectId = `inbound:${routing.teamId}:${routing.channelId}:${routing.rootTs}:${routing.eventId}:${routing.interactionId}`;
		const expectedIdempotencyKey = `slack:${routing.teamId}:${routing.channelId}:${routing.rootTs}:${routing.eventId}:${routing.interactionId}`;
		const validPayload =
			effect.id === expectedEffectId &&
			payload.idempotencyKey === expectedIdempotencyKey &&
			((payload.type === "command" && routing.kind === "command") ||
				(payload.type === "reply" && routing.kind === "action" && payload.id === routing.actionId));
		let receipt: SlackInboundDispatchReceipt | undefined;
		await this.store.transact(key, current => {
			if (
				!validPayload ||
				!current ||
				!effect.sessionId ||
				current.sessionId !== effect.sessionId ||
				!acceptsSlackInbound(current, routing.rootTs, effect.endpointGeneration)
			)
				return current;
			const existing = (current.inboundDispatches ?? []).find(
				candidate =>
					candidate.eventId === routing.eventId ||
					candidate.interactionId === routing.interactionId ||
					candidate.retryKey === routing.retryKey ||
					(routing.eventContext !== undefined && candidate.eventContext === routing.eventContext),
			);
			if (existing) {
				if (
					existing.effectId === effect.id &&
					existing.idempotencyKey === payload.idempotencyKey &&
					existing.endpointGeneration === effect.endpointGeneration &&
					existing.eventId === routing.eventId &&
					existing.interactionId === routing.interactionId &&
					existing.retryKey === routing.retryKey &&
					existing.eventContext === routing.eventContext &&
					existing.kind === routing.kind &&
					existing.actionId === routing.actionId
				)
					receipt = existing;
				return current;
			}
			if (
				current.seenEventIds.includes(routing.eventId) ||
				current.seenInteractionIds.includes(routing.interactionId) ||
				current.seenRetryKeys.includes(routing.retryKey) ||
				(routing.eventContext !== undefined && current.seenContextIds.includes(routing.eventContext)) ||
				(routing.kind === "action" && current.pendingActionId !== routing.actionId)
			)
				return current;
			receipt = {
				key: `${routing.eventId}:${routing.interactionId}`,
				eventId: routing.eventId,
				interactionId: routing.interactionId,
				retryKey: routing.retryKey,
				eventContext: routing.eventContext,
				kind: routing.kind,
				...(routing.kind === "action" ? { actionId: routing.actionId } : {}),
				endpointGeneration: effect.endpointGeneration,
				effectId: effect.id,
				idempotencyKey: payload.idempotencyKey,
			};
			return nextRecord(current, {
				inboundDispatches: [...(current.inboundDispatches ?? []), receipt],
				updatedAt: this.#now(),
			});
		});
		if (receipt && effect.sessionId) return { key, sessionId: effect.sessionId, receipt };
		await this.#terminalizeRejectedInbound(effect.id);
		return undefined;
	}

	async #terminalizeRejectedInbound(effectId: string): Promise<void> {
		await this.#journal.terminalize(effectId, { status: "rejected" });
	}

	async #finishDispatch(
		claim: { key: string; endpoint: SlackEndpoint; receipt: SlackInboundDispatchReceipt },
		state: "terminal" | "uncertain",
	): Promise<void> {
		await this.store.transact(claim.key, current => {
			if (!current || !acceptsSlackInbound(current, current.rootTs ?? "", claim.endpoint.generation)) return current;
			const found = (current.inboundDispatches ?? []).find(receipt => receipt.key === claim.receipt.key);
			if (!found) return current;
			return nextRecord(current, {
				pendingActionId:
					found.kind === "action" && current.pendingActionId === found.actionId
						? undefined
						: current.pendingActionId,
				seenEventIds: [...current.seenEventIds, found.eventId],
				seenInteractionIds: [...current.seenInteractionIds, found.interactionId],
				seenRetryKeys: [...current.seenRetryKeys, found.retryKey],
				seenContextIds:
					found.eventContext === undefined
						? current.seenContextIds
						: [...current.seenContextIds, found.eventContext],
				inboundDispatches:
					state === "terminal"
						? (current.inboundDispatches ?? []).filter(receipt => receipt.key !== found.key)
						: current.inboundDispatches,
				updatedAt: this.#now(),
			});
		});
	}

	async #releaseDispatch(claim: {
		key: string;
		endpoint: SlackEndpoint;
		receipt: SlackInboundDispatchReceipt;
	}): Promise<void> {
		await this.store.transact(claim.key, current => {
			if (!current || !acceptsSlackInbound(current, current.rootTs ?? "", claim.endpoint.generation)) return current;
			const found = (current.inboundDispatches ?? []).find(receipt => receipt.key === claim.receipt.key);
			return found
				? nextRecord(current, {
						inboundDispatches: (current.inboundDispatches ?? []).filter(receipt => receipt.key !== found.key),
						updatedAt: this.#now(),
					})
				: current;
		});
	}

	async #reconcileTerminalProviderReceipts(): Promise<void> {
		for (const effect of await this.#journal.list()) {
			try {
				if (effect.kind !== "provider-post" || effect.transport !== "slack" || effect.state !== "terminal")
					continue;
				const payload = effect.payload as { channel?: unknown; threadTs?: unknown; clientMsgId?: unknown };
				const receipt = effect.receipt;
				if (
					receipt?.provider !== "slack" ||
					receipt.status !== "posted" ||
					typeof receipt.timestamp !== "string" ||
					typeof payload.clientMsgId !== "string"
				)
					continue;
				const normalized = {
					channel: payload.channel,
					threadTs: payload.threadTs,
					clientMsgId: payload.clientMsgId,
				};
				if (typeof normalized.threadTs === "string") await this.#activateReconciledAction(effect, normalized);
				else await this.#activateReconciledRoot(effect, normalized, receipt.timestamp);
			} catch {
				await this.#recordRecoveryFailure(effect);
			}
		}
	}

	async #activateReconciledRoot(
		effect: ChatEffect,
		payload: { channel?: unknown; clientMsgId: string },
		rootTs: string,
	): Promise<void> {
		if (!effect.sessionId || typeof payload.channel !== "string" || payload.channel !== this.options.channelId)
			return;
		const endpoint = await this.#resolveEndpoint(effect.sessionId);
		if (!endpoint || (effect.endpointGeneration !== 0 && endpoint.generation !== effect.endpointGeneration)) return;
		await this.store.transact(this.#intentKey(effect.sessionId), current =>
			current &&
			current.state === "posting_root" &&
			current.sessionId === effect.sessionId &&
			current.teamId === this.options.teamId &&
			current.channelId === payload.channel &&
			current.clientMsgId === payload.clientMsgId &&
			(effect.endpointGeneration === 0 ||
				current.endpointGeneration === undefined ||
				current.endpointGeneration === effect.endpointGeneration)
				? nextRecord(current, {
						state: "active",
						rootTs,
						endpointGeneration: endpoint.generation,
						rootPublicationOwner: undefined,
						rootPublicationLeaseExpiresAt: undefined,
						lastError: undefined,
						updatedAt: this.#now(),
					})
				: current,
		);
	}

	async #activateReconciledAction(
		effect: ChatEffect,
		payload: { channel?: unknown; threadTs?: unknown; clientMsgId: string },
	): Promise<void> {
		if (!effect.sessionId || typeof payload.channel !== "string" || typeof payload.threadTs !== "string") return;
		const threadTs = payload.threadTs;
		const endpoint = await this.#resolveEndpoint(effect.sessionId);
		if (!endpoint || endpoint.generation !== effect.endpointGeneration) return;
		const document = await this.store.load();
		const found = Object.entries(document.conversations)
			.map(([key, record]) => ({ key, record }))
			.filter(
				({ record }) =>
					record.state === "active" &&
					record.sessionId === effect.sessionId &&
					record.teamId === this.options.teamId &&
					record.channelId === payload.channel &&
					record.rootTs === threadTs &&
					record.endpointGeneration === endpoint.generation &&
					record.outboundActionClientMsgId === payload.clientMsgId &&
					typeof record.outboundActionId === "string",
			)[0];
		if (!found) return;
		await this.store.transact(found.key, current =>
			current &&
			acceptsSlackInbound(current, threadTs, endpoint.generation) &&
			current.outboundActionClientMsgId === payload.clientMsgId &&
			current.outboundActionId === found.record.outboundActionId
				? nextRecord(current, {
						pendingActionId: current.outboundActionId,
						outboundActionId: undefined,
						outboundActionClientMsgId: undefined,
						outboundActionOwner: undefined,
						outboundActionLeaseExpiresAt: undefined,
						updatedAt: this.#now(),
					})
				: current,
		);
	}
	async #recordRecoveryFailure(effect: ChatEffect): Promise<void> {
		try {
			if (!effect.sessionId) return;
			const found = await this.findSession(effect.sessionId, true);
			if (!found) return;
			await this.store.transact(found.key, current => {
				if (!current || current.sessionId !== effect.sessionId) return current;
				return nextRecord(current, { lastError: "recovery_failure", updatedAt: this.#now() });
			});
		} catch {
			// Diagnostics must never remove the durable recovery trigger.
		}
	}

	async #drainProviderEffects(): Promise<boolean> {
		let failed = false;
		for (const effect of await this.#journal.list()) {
			try {
				if (effect.kind !== "provider-post" || effect.state === "terminal") continue;
				if (!effect.sessionId || !(await this.#providerEffectCurrent(effect))) {
					await this.#journal.terminalize(effect.id, { provider: "slack", status: "stale_noop" });
					continue;
				}
				const payload = effect.payload as {
					channel?: unknown;
					text?: unknown;
					threadTs?: unknown;
					clientMsgId?: unknown;
				};
				if (
					typeof payload.channel !== "string" ||
					typeof payload.text !== "string" ||
					typeof payload.clientMsgId !== "string" ||
					(payload.threadTs !== undefined && typeof payload.threadTs !== "string")
				)
					continue;
				await this.#postDurable(effect.id, effect.sessionId, effect.endpointGeneration, {
					channel: payload.channel,
					text: payload.text,
					...(typeof payload.threadTs === "string" ? { threadTs: payload.threadTs } : {}),
					clientMsgId: payload.clientMsgId,
				});
			} catch {
				failed = true;
				await this.#recordRecoveryFailure(effect);
			}
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
		const recoveryAt = (await this.#journal.list())
			.filter(effect => effect.transport === "slack")
			.reduce<number | undefined>(
				(earliest, effect) => {
					const claimAt =
						effect.state === "leased" && Number.isFinite(effect.leaseExpiresAt)
							? effect.leaseExpiresAt
							: effect.state === "pending" ||
									effect.state === "accepted" ||
									(effect.state === "uncertain" && !effect.kind.includes(".inbound."))
								? now
								: undefined;
					return claimAt === undefined || (earliest !== undefined && earliest <= claimAt) ? earliest : claimAt;
				},
				recoveryFailed ? now : undefined,
			);
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
		const delay =
			recoveryAt <= now
				? Math.min(1_000, 25 * 2 ** Math.min(this.#leaseRecoveryFailures, 5))
				: Math.min(recoveryAt - now, 2_147_483_647);
		this.#leaseRecoveryTimer = setTimeout(() => {
			this.#leaseRecoveryTimer = undefined;
			this.#leaseRecoveryAt = undefined;
			void this.#track(this.#recoverLeasedEffects());
		}, delay);
	}
	async #recoverLeasedEffects(): Promise<void> {
		if (!this.#started || this.#recoveringLeasedEffects) return;
		this.#recoveringLeasedEffects = true;
		let failed = false;
		try {
			try {
				await this.#reconcileTerminalProviderReceipts();
			} catch {
				failed = true;
			}
			try {
				failed ||= await this.#drainProviderEffects();
			} catch {
				failed = true;
			}
			try {
				await this.#reconcileTerminalProviderReceipts();
			} catch {
				failed = true;
			}
			try {
				await this.#drainPendingDispatches();
			} catch {
				failed = true;
			}
		} finally {
			if (failed) this.#leaseRecoveryFailures = Math.min(this.#leaseRecoveryFailures + 1, 5);
			else this.#leaseRecoveryFailures = 0;
			try {
				await this.#scheduleLeaseRecovery(failed);
			} catch {
				/* retained effects are retried by the next trigger */
			} finally {
				this.#recoveringLeasedEffects = false;
			}
		}
	}

	async #providerEffectCurrent(effect: ChatEffect): Promise<boolean> {
		if (!effect.sessionId) return false;
		const endpoint = await this.#resolveEndpoint(effect.sessionId);
		if (!endpoint || (effect.endpointGeneration !== 0 && endpoint.generation !== effect.endpointGeneration))
			return false;
		const payload = effect.payload as { threadTs?: unknown };
		const threadTs = payload.threadTs;
		const records = Object.values((await this.store.load()).conversations);
		if (typeof threadTs === "string") {
			return records.some(
				record =>
					record.sessionId === effect.sessionId &&
					acceptsSlackInbound(record, threadTs, effect.endpointGeneration),
			);
		}
		return records.some(
			record =>
				record.sessionId === effect.sessionId &&
				(record.state === "posting_root" ||
					(record.state === "active" && record.endpointGeneration === effect.endpointGeneration)),
		);
	}

	async #postDurable(
		id: string,
		sessionId: string,
		endpointGeneration: number,
		payload: { channel: string; text: string; threadTs?: string; clientMsgId: string },
	): Promise<SlackPostedMessage> {
		const initial = await this.#rescheduleAfterEffectTransition(
			this.#journal.enqueue({
				id,
				kind: "provider-post",
				transport: "slack",
				sessionId,
				endpointGeneration,
				payload,
			}),
		);
		const fromReceipt = (effect: typeof initial): SlackPostedMessage | undefined => {
			if (
				effect.state !== "terminal" ||
				effect.receipt?.status !== "posted" ||
				!effect.receipt.channelId ||
				!effect.receipt.timestamp
			)
				return undefined;
			return {
				channel: effect.receipt.channelId,
				ts: effect.receipt.timestamp,
				client_msg_id: effect.receipt.messageId,
			};
		};
		const completed = fromReceipt(initial);
		if (completed) return completed;
		if (initial.state === "terminal") throw new Error("Slack provider effect previously failed");
		let effect: ChatEffect<typeof payload> | undefined;
		for (let attempt = 0; attempt < 100 && !effect; attempt++) {
			effect = await this.#rescheduleAfterEffectTransition(
				this.#journal.claim<typeof payload>(id, this.#publicationOwnerId, Math.max(this.#publicationLeaseMs, 100)),
			);
			if (effect) break;
			const current = await this.#journal.read<typeof payload>(id);
			if (current) {
				const posted = fromReceipt(current);
				if (posted) return posted;
				if (current.state === "terminal") throw new Error("Slack provider effect previously failed");
			}
			await Bun.sleep(1);
		}
		if (!effect) throw new Error("Slack provider effect is owned by another worker");
		const lease: ChatEffectLease = { owner: this.#publicationOwnerId, epoch: effect.epoch };
		try {
			const posted = await this.#withEffectLease(id, lease, async () => {
				if (!(await this.#providerEffectCurrent(effect!))) throw new SlackStaleEffectError();
				const found = await this.options.provider.findMessageByClientMsgId({
					channel: effect!.payload.channel,
					threadTs: effect!.payload.threadTs,
					clientMsgId: effect!.payload.clientMsgId,
				});
				if (found) return found;
				if (!(await this.#providerEffectCurrent(effect!))) throw new SlackStaleEffectError();
				return await this.options.provider.postMessage(effect!.payload);
			});

			if (!(await this.#providerEffectCurrent(effect))) throw new SlackStaleEffectError();
			if (
				!(await this.#journal.record(id, lease, "terminal", {
					provider: "slack",
					channelId: posted.channel,
					timestamp: posted.ts,
					messageId: posted.client_msg_id ?? posted.ts,
					status: "posted",
				}))
			)
				throw new Error("Slack provider effect lease expired before commit");

			return posted;
		} catch (error) {
			if (error instanceof SlackStaleEffectError) throw error;
			if (this.#isUncertainPostFailure(error)) {
				try {
					const reconciled = await this.#withEffectLease(id, lease, async () => {
						if (!(await this.#providerEffectCurrent(effect!))) throw new SlackStaleEffectError();
						return await this.options.provider.findMessageByClientMsgId({
							channel: effect!.payload.channel,
							threadTs: effect!.payload.threadTs,
							clientMsgId: effect!.payload.clientMsgId,
						});
					});
					if (reconciled) {
						if (!(await this.#providerEffectCurrent(effect))) throw new SlackStaleEffectError();
						if (
							!(await this.#journal.record(id, lease, "terminal", {
								provider: "slack",
								channelId: reconciled.channel,
								timestamp: reconciled.ts,
								messageId: reconciled.client_msg_id ?? reconciled.ts,
								status: "posted",
							}))
						)
							throw new Error("Slack provider effect lease expired before commit");
						return reconciled;
					}
				} catch (reconcileError) {
					if (reconcileError instanceof SlackStaleEffectError) throw reconcileError;
					// Preserve the uncertain effect for a later reconciliation attempt.
				}
			}
			await this.#rescheduleAfterEffectTransition(
				this.#journal.record(id, lease, this.#isUncertainPostFailure(error) ? "uncertain" : "terminal", {
					provider: "slack",
					status: this.#isUncertainPostFailure(error) ? "uncertain" : "failed",
				}),
			);
			throw error;
		}
	}

	async #withRootLease<T>(key: string, clientMsgId: string, fence: number, operation: () => Promise<T>): Promise<T> {
		return await this.#withPublicationLease(operation, async () => {
			let renewed = false;
			await this.store.transact(key, current => {
				if (
					!current ||
					current.clientMsgId !== clientMsgId ||
					current.rootPublicationOwner !== this.#publicationOwnerId ||
					current.rootPublicationFence !== fence
				)
					return current;
				renewed = true;
				return nextRecord(current, {
					rootPublicationLeaseExpiresAt: this.#now() + this.#publicationLeaseMs,
					updatedAt: this.#now(),
				});
			});
			if (!renewed) throw new Error("Slack root publication lease renewal failed");
		});
	}

	async #withActionLease<T>(key: string, clientMsgId: string, fence: number, operation: () => Promise<T>): Promise<T> {
		return await this.#withPublicationLease(operation, async () => {
			let renewed = false;
			await this.store.transact(key, current => {
				if (
					!current ||
					current.outboundActionClientMsgId !== clientMsgId ||
					current.outboundActionOwner !== this.#publicationOwnerId ||
					current.outboundActionFence !== fence
				)
					return current;
				renewed = true;
				return nextRecord(current, {
					outboundActionLeaseExpiresAt: this.#now() + this.#publicationLeaseMs,
					updatedAt: this.#now(),
				});
			});
			if (!renewed) throw new Error("Slack action publication lease renewal failed");
		});
	}

	async #withPublicationLease<T>(operation: () => Promise<T>, renew: () => Promise<void>): Promise<T> {
		return await this.#withRenewal(operation, renew);
	}

	async #withRenewal<T>(
		operation: () => Promise<T>,
		renew: () => Promise<void>,
		renewBeforeOperation = true,
	): Promise<T> {
		if (renewBeforeOperation) await renew();
		let failure: unknown;
		let renewing = Promise.resolve();
		const timer = setInterval(
			() => {
				renewing = renewing.then(renew).catch(error => {
					failure ??= error;
				});
			},
			Math.max(1, Math.floor(this.#publicationLeaseMs / 4)),
		);
		try {
			const result = await operation();
			await renewing;
			if (failure) throw failure;
			return result;
		} finally {
			clearInterval(timer);
			await renewing;
		}
	}

	async #waitForRoot(
		key: string,
		sessionId: string,
		body: string,
		endpointGeneration?: number,
	): Promise<SlackConversation> {
		for (let attempt = 0; attempt < 100; attempt++) {
			await Bun.sleep(10);
			const current = await this.store.read(key);
			if (current?.state === "active") return current;
			if (
				current?.state === "error" ||
				(current?.state === "posting_root" &&
					this.#leaseExpired(current.rootPublicationLeaseExpiresAt, this.#now()))
			) {
				return await this.postRoot(sessionId, body, endpointGeneration);
			}
		}
		throw new Error("Slack root post is still pending");
	}

	async #waitForAction(key: string, sessionId: string, body: string, actionId: string): Promise<SlackConversation> {
		for (let attempt = 0; attempt < 100; attempt++) {
			await Bun.sleep(10);
			const current = await this.store.read(key);
			if (current?.pendingActionId === actionId && !current.outboundActionId) return current;
			if (
				current?.outboundActionId === actionId &&
				this.#leaseExpired(current.outboundActionLeaseExpiresAt, this.#now())
			) {
				return await this.notify(sessionId, body, actionId);
			}
		}
		throw new Error("Slack action publication is still pending");
	}

	private async findSession(
		sessionId: string,
		includeInactive: boolean,
	): Promise<{ key: string; record: SlackConversation } | undefined> {
		const document = await this.store.load();
		return Object.entries(document.conversations)
			.map(([key, record]) => ({ key, record }))
			.filter(
				entry =>
					entry.record.sessionId === sessionId &&
					(includeInactive ||
						entry.record.state === "active" ||
						entry.record.state === "posting_root" ||
						entry.record.state === "error"),
			)
			.sort(
				(left, right) =>
					(right.record.endpointGeneration ?? -1) - (left.record.endpointGeneration ?? -1) ||
					right.record.generation - left.record.generation ||
					right.record.updatedAt - left.record.updatedAt,
			)[0];
	}
	#intentKey(sessionId: string): string {
		return slackConversationKey({
			teamId: this.options.teamId,
			channelId: this.options.channelId,
			rootTs: `intent:${sessionId}`,
		});
	}
	#leaseExpired(expiresAt: number | undefined, now: number): boolean {
		return expiresAt === undefined || expiresAt <= now;
	}

	#isUncertainPostFailure(error: unknown): boolean {
		return (
			error instanceof SlackProviderError && error.operation === "chat.postMessage" && error.code === "connection"
		);
	}
	#isDefiniteSdkPreSendFailure(error: unknown): boolean {
		return (
			error instanceof SlackEndpointBindingError ||
			(error instanceof SdkClientError && error.code === "connection_closed")
		);
	}
}
