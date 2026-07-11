import { createHash } from "node:crypto";
import { type AgentRegistrationToken, type AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import {
	degradeRalplanIrcActivation,
	degradeRalplanIrcPass,
	hasPersistedRalplanDeliberationReceipt,
} from "./ralplan-runtime";

export const RALPLAN_IRC_SEND_TIMEOUT_MS = 15_000;
export const RALPLAN_IRC_PASS_TIMEOUT_MS = 60_000;
export type RalplanIrcRole = "planner" | "architect" | "critic";
export type RalplanIrcPassState =
	| "awaiting_attachments"
	| "awaiting_required_dm"
	| "deliberation_open"
	| "closed"
	| "degraded";
export interface RalplanIrcBinding {
	parentSessionId: string;
	runId: string;
	stageN: number;
	cursorGeneration: number;
	role: RalplanIrcRole;
	token: AgentRegistrationToken;
}
export interface RalplanIrcObservation {
	observationId: string;
	from: string;
	to: string;
	body: string;
	kind: "message" | "reply";
	timestamp: number;
	sequence?: number;
}
export type RalplanIrcLifecycleEvent = {
	type: "open" | "close" | "required_dm_delivered" | "boundary_ask_ready";
	parentSessionId: string;
	runId: string;
	stageN: number;
};
export interface RalplanIrcCoordinatorOptions {
	registry: AgentRegistry;
	cwd: string;
	passTimeoutMs?: number;
	sendTimeoutMs?: number;
	onLifecycle?: (event: RalplanIrcLifecycleEvent) => void;
}

const coordinators = new WeakMap<AgentRegistry, RalplanIrcCoordinator>();
export function getRalplanIrcCoordinator(registry: AgentRegistry): RalplanIrcCoordinator | undefined {
	return coordinators.get(registry);
}

type Cursor = Pick<RalplanIrcBinding, "parentSessionId" | "runId" | "stageN" | "cursorGeneration">;

export class RalplanIrcCoordinator {
	readonly childBindings = new Map<string, RalplanIrcBinding>();
	#state: RalplanIrcPassState = "closed";
	#cursor?: Cursor;
	#transcript: RalplanIrcObservation[] = [];
	#sequence = 0;
	#seenObservationIds = new Set<string>();
	#timer?: ReturnType<typeof setTimeout>;
	#attached = new Map<string, AgentRegistrationToken>();
	#lifecycleListeners = new Set<(event: RalplanIrcLifecycleEvent) => void>();
	#completedPass?: Cursor & { transcriptSha256: string };
	#diagnostics: Array<{ reason: string; error: string; timestamp: number }> = [];

	constructor(readonly options: RalplanIrcCoordinatorOptions) {
		coordinators.set(options.registry, this);
		options.registry.onChange(event => {
			if (event.type === "registered") {
				// A replacement registration must never inherit old attachment proof.
				this.#attached.delete(event.ref.id);
				this.unbind(event.ref.id);
			} else if (event.type === "attached") {
				const binding = this.childBindings.get(event.id);
				if (binding?.token === event.token && this.options.registry.currentToken(event.id) === event.token) {
					this.#attached.set(event.id, event.token);
					this.#advance();
				}
			} else if (event.type === "removed") {
				this.#attached.delete(event.ref.id);
				this.unbind(event.ref.id);
			}
		});
	}

	get state(): RalplanIrcPassState {
		return this.#state;
	}
	get transcript(): readonly RalplanIrcObservation[] {
		return this.#transcript;
	}
	get diagnostics(): readonly { reason: string; error: string; timestamp: number }[] {
		return this.#diagnostics;
	}
	onLifecycle(listener: (event: RalplanIrcLifecycleEvent) => void): () => void {
		this.#lifecycleListeners.add(listener);
		return () => this.#lifecycleListeners.delete(listener);
	}

	startPass(args: Cursor): boolean {
		if (this.#state !== "closed") return false;
		this.#cursor = { ...args };
		this.#transcript = [];
		this.#sequence = 0;
		this.#seenObservationIds.clear();
		this.#attached.clear();
		this.childBindings.clear();
		this.#completedPass = undefined;
		this.#state = "awaiting_attachments";
		this.#timer = setTimeout(() => {
			void this.degrade("pass_timeout").catch(error => this.#recordDiagnostic("pass_timeout", error));
		}, this.options.passTimeoutMs ?? RALPLAN_IRC_PASS_TIMEOUT_MS);
		this.#emitLifecycle({ type: "open", ...args });
		return true;
	}

	bind(agentId: string, binding: RalplanIrcBinding): boolean {
		if (!this.#matches(binding) || this.options.registry.currentToken(agentId) !== binding.token) return false;
		this.#attached.delete(agentId);
		this.childBindings.set(agentId, binding);
		this.#advance();
		return true;
	}

	bindRegisteredChild(agentId: string, args: Omit<RalplanIrcBinding, "stageN" | "cursorGeneration">): boolean {
		if (!this.#cursor) return false;
		return this.bind(agentId, {
			...args,
			stageN: this.#cursor.stageN,
			cursorGeneration: this.#cursor.cursorGeneration,
		});
	}

	unbind(agentId: string, token?: AgentRegistrationToken): void {
		const binding = this.childBindings.get(agentId);
		if (binding && (!token || binding.token === token)) this.childBindings.delete(agentId);
	}
	isBound(agentId: string): RalplanIrcBinding | undefined {
		const binding = this.childBindings.get(agentId);
		return binding && this.#matches(binding) && this.options.registry.currentToken(agentId) === binding.token
			? binding
			: undefined;
	}
	isSameBoundPass(from: string, to: string): boolean {
		const a = this.isBound(from);
		const b = this.isBound(to);
		return (
			!!a &&
			!!b &&
			a.parentSessionId === b.parentSessionId &&
			a.runId === b.runId &&
			a.stageN === b.stageN &&
			a.cursorGeneration === b.cursorGeneration
		);
	}
	matchesActivePass(cursor: Cursor): boolean {
		return this.#matches(cursor);
	}

	// Delivery is a transport acknowledgement. Observations are recorded only by the session relay.
	recordDelivery(args: { from: string; to: string; body: string; delivered: boolean; failed?: boolean }): void {
		if (!args.delivered || args.failed || !this.isSameBoundPass(args.from, args.to)) return;
		const from = this.isBound(args.from)!;
		const to = this.isBound(args.to)!;
		if (this.#state === "awaiting_required_dm" && from.role === "critic" && to.role === "planner") {
			this.#state = "deliberation_open";
			this.#emitLifecycle({ type: "required_dm_delivered", ...this.#cursor! });
		}
	}

	recordObservation(observation: RalplanIrcObservation): void {
		if (
			!this.isSameBoundPass(observation.from, observation.to) ||
			this.#seenObservationIds.has(observation.observationId)
		)
			return;
		this.#seenObservationIds.add(observation.observationId);
		this.#transcript.push({ ...observation, sequence: ++this.#sequence });
	}

	async reportFailure(args: Cursor & { reason: string }): Promise<boolean> {
		if (!this.#matches(args)) return false;
		await this.degrade(args.reason);
		return true;
	}
	async activationDegrade(args: { parentSessionId: string; runId: string; reason: string }): Promise<boolean> {
		if (
			this.#state !== "closed" ||
			(this.#cursor && (this.#cursor.parentSessionId !== args.parentSessionId || this.#cursor.runId !== args.runId))
		)
			return false;
		await degradeRalplanIrcActivation({
			cwd: this.options.cwd,
			sessionId: args.parentSessionId,
			runId: args.runId,
			reason: args.reason,
		});
		return true;
	}
	endPass(args: Cursor): string | undefined {
		if (this.#state !== "deliberation_open" || !this.#matches(args)) return undefined;
		const markdown = this.renderTranscript();
		this.#completedPass = { ...args, transcriptSha256: createHash("sha256").update(markdown).digest("hex") };
		this.close();
		return markdown;
	}
	async recordDeliberationReceipt(args: Cursor): Promise<boolean> {
		if (this.#state !== "closed" || !this.#completedPass || !this.#sameCursor(this.#completedPass, args))
			return false;
		if (
			!(await hasPersistedRalplanDeliberationReceipt(
				this.options.cwd,
				args.parentSessionId,
				args.runId,
				args.stageN,
				this.#completedPass.transcriptSha256,
			))
		)
			return false;
		this.#completedPass = undefined;
		this.#emitLifecycle({ type: "boundary_ask_ready", ...args });
		return true;
	}
	renderTranscript(): string {
		return `${["# IRC Deliberation", "", ...[...this.#transcript].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)).map(x => `- ${new Date(x.timestamp).toISOString()} · **${x.from} → ${x.to}**${x.kind === "reply" ? " (auto)" : ""}: ${x.body}`)].join("\n")}\n`;
	}

	async degrade(reason: string): Promise<void> {
		if (this.#state === "degraded" || this.#state === "closed" || !this.#cursor) return;
		const cursor = this.#cursor;
		await degradeRalplanIrcPass({
			cwd: this.options.cwd,
			sessionId: cursor.parentSessionId,
			runId: cursor.runId,
			stageN: cursor.stageN,
			reason,
		});
		if (!this.#matches(cursor)) return;
		this.#state = "degraded";
		this.childBindings.clear();
		this.#clearTimer();
		this.#completedPass = undefined;
		this.#emitLifecycle({ type: "close", ...cursor });
	}
	close(): void {
		if (this.#state === "closed") return;
		const cursor = this.#cursor;
		this.#state = "closed";
		this.childBindings.clear();
		this.#clearTimer();
		if (cursor) this.#emitLifecycle({ type: "close", ...cursor });
	}

	#advance(): void {
		if (this.#state !== "awaiting_attachments") return;
		const roles = new Set<RalplanIrcRole>();
		for (const [id, binding] of this.childBindings) {
			const ref = this.options.registry.get(id);
			if (
				ref?.session &&
				this.#attached.get(id) === binding.token &&
				this.options.registry.currentToken(id) === binding.token &&
				(ref.status === "running" || ref.status === "idle") &&
				this.#matches(binding)
			)
				roles.add(binding.role);
		}
		if (roles.size === 3) this.#state = "awaiting_required_dm";
	}
	#matches(value: Cursor): boolean {
		return (
			!!this.#cursor &&
			this.#state !== "closed" &&
			this.#state !== "degraded" &&
			this.#sameCursor(this.#cursor, value)
		);
	}
	#sameCursor(a: Cursor, b: Cursor): boolean {
		return (
			a.parentSessionId === b.parentSessionId &&
			a.runId === b.runId &&
			a.stageN === b.stageN &&
			a.cursorGeneration === b.cursorGeneration
		);
	}
	#clearTimer(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
	}
	#recordDiagnostic(reason: string, error: unknown): void {
		this.#diagnostics.push({
			reason,
			error: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		});
	}
	#emitLifecycle(event: RalplanIrcLifecycleEvent): void {
		this.options.onLifecycle?.(event);
		for (const listener of this.#lifecycleListeners) listener(event);
	}
}
export { MAIN_AGENT_ID };
