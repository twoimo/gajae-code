import type { NewSessionOptions, SessionForkOptions, SessionManager } from "../session-manager";

export interface PreparedSessionTransition {
	readonly lease: ReturnType<SessionManager["prepareSessionLease"]>;
}

export type SessionStoreSnapshot = ReturnType<SessionManager["captureState"]>;

/** Transactional owner for durable session-manager lifecycle mutations. */
export class SessionStoreCoordinator {
	readonly #manager: SessionManager;

	constructor(manager: SessionManager) {
		this.#manager = manager;
	}

	async flush(): Promise<void> {
		await this.#manager.flush();
	}

	prepare(sessionPath: string): PreparedSessionTransition {
		const lease = this.#manager.prepareSessionLease(sessionPath);
		if (!lease) this.#manager.validateSessionFile(sessionPath);
		return { lease };
	}

	capture(): SessionStoreSnapshot {
		return this.#manager.captureState();
	}

	async newSession(options?: NewSessionOptions): Promise<void> {
		await this.#manager.newSession(options);
	}

	async fork(options?: SessionForkOptions) {
		await this.flush();
		return await this.#manager.fork(options);
	}

	async switch(sessionPath: string, prepared: PreparedSessionTransition["lease"]): Promise<void> {
		await this.#manager.setSessionFile(sessionPath, undefined, prepared ?? undefined);
	}

	rollback(snapshot: SessionStoreSnapshot): void {
		this.#manager.restoreState(snapshot);
	}

	commit(snapshot: SessionStoreSnapshot): void {
		this.#manager.discardState(snapshot);
	}
}
