/**
 * AgentRegistry - Process-global registry of live AgentSession instances.
 *
 * Tracks every alive agent (the main session plus every subagent) so the
 * `irc` tool can address peers by id. Sessions are registered explicitly at
 * creation and removed when the owner releases them.
 */

import type { AgentSession } from "../session/agent-session";

export const MAIN_AGENT_ID = "0-Main";

export type AgentStatus = "running" | "idle" | "completed" | "aborted";
export type AgentKind = "main" | "sub";

/** Opaque identity for one registration generation of an agent ID. */
export type AgentRegistrationToken = symbol;

export class DuplicateLiveAgentIdError extends Error {
	constructor(readonly id: string) {
		super(`An agent with live id ${id} is already registered.`);
		this.name = "DuplicateLiveAgentIdError";
	}
}

export class ReservedAgentIdError extends Error {
	constructor(readonly id: string) {
		super(`${id} is reserved for the main agent.`);
		this.name = "ReservedAgentIdError";
	}
}


export interface AgentRegistration {
	ref: AgentRef;
	token: AgentRegistrationToken;
}

export interface AgentRef {
	id: string;
	displayName: string;
	rosterLabel?: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	session: AgentSession | null;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
}

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "attached"; id: string; token: AgentRegistrationToken; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef };

type RegistryListener = (event: RegistryEvent) => void;

export interface RegisterInput {
	id: string;
	displayName: string;
	rosterLabel?: string;
	kind: AgentKind;
	parentId?: string;
	session: AgentSession | null;
	sessionFile?: string | null;
	status?: AgentStatus;
}

export class AgentRegistry {
	static #global: AgentRegistry | undefined;

	static global(): AgentRegistry {
		if (!AgentRegistry.#global) {
			AgentRegistry.#global = new AgentRegistry();
		}
		return AgentRegistry.#global;
	}

	/** Reset the global registry. Test-only. */
	static resetGlobalForTests(): void {
		AgentRegistry.#global = new AgentRegistry();
	}

	readonly #refs = new Map<string, AgentRef>();
	readonly #tokens = new Map<string, AgentRegistrationToken>();
	readonly #attachedTokens = new Set<AgentRegistrationToken>();
	readonly #listeners = new Set<RegistryListener>();

	currentToken(id: string): AgentRegistrationToken | undefined {
		return this.#tokens.get(id);
	}

	register(input: RegisterInput): AgentRegistration {
		if (input.id === MAIN_AGENT_ID && input.kind !== "main") throw new ReservedAgentIdError(input.id);
		const existing = this.#refs.get(input.id);
		if (existing && (existing.status === "running" || existing.status === "idle")) throw new DuplicateLiveAgentIdError(input.id);
		const now = Date.now();
		const ref: AgentRef = {
			id: input.id,
			displayName: input.displayName,
			rosterLabel: input.rosterLabel,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status ?? "running",
			session: input.session,
			sessionFile: input.sessionFile ?? null,
			createdAt: now,
			lastActivity: now,
		};
		const token = Symbol(`agent-registration:${ref.id}`);
		this.#refs.set(ref.id, ref);
		this.#tokens.set(ref.id, token);
		this.#emit({ type: "registered", ref });
		return { ref, token };
	}

	#matchesToken(id: string, token: AgentRegistrationToken | undefined): boolean {
		return token === undefined || this.#tokens.get(id) === token;
	}

	setStatus(id: string, status: AgentStatus, token?: AgentRegistrationToken): void {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesToken(id, token) || ref.status === status) return;
		ref.status = status;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
	}

	attachSession(
		id: string,
		session: AgentSession,
		token?: AgentRegistrationToken,
		sessionFile?: string | null,
	): void {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesToken(id, token)) return;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		ref.lastActivity = Date.now();
		const currentToken = this.#tokens.get(id)!;
		if (!this.#attachedTokens.has(currentToken)) {
			this.#attachedTokens.add(currentToken);
			this.#emit({ type: "attached", id, token: currentToken, ref });
		}
	}

	detachSession(id: string, token?: AgentRegistrationToken): void {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesToken(id, token)) return;
		ref.session = null;
	}

	unregister(id: string, token?: AgentRegistrationToken): void {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesToken(id, token)) return;
		const currentToken = this.#tokens.get(id);
		this.#refs.delete(id);
		this.#tokens.delete(id);
		if (currentToken) this.#attachedTokens.delete(currentToken);
		this.#emit({ type: "removed", ref });
	}

	get(id: string): AgentRef | undefined {
		return this.#refs.get(id);
	}

	list(): AgentRef[] {
		return [...this.#refs.values()];
	}

	/**
	 * Returns every alive agent (running | idle) except the caller.
	 * Flat namespace: every agent can see every other agent.
	 */
	listVisibleTo(id: string): AgentRef[] {
		return this.list().filter(ref => ref.id !== id && (ref.status === "running" || ref.status === "idle"));
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: RegistryEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// listeners must not break the dispatch loop
			}
		}
	}
}
