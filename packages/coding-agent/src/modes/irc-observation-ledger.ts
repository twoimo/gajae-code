import type { ParsedIrcMessage } from "./utils/irc-message";

type InlineMode = "persistent" | "ephemeral";

export type IrcObservationRecord = Readonly<
	ParsedIrcMessage & {
		mode: InlineMode;
		observedAt: number;
		sequence: number;
		expiresAt?: number;
	}
>;

/** Runtime-only IRC observations. This intentionally has no persistence layer. */
export class IrcObservationLedger {
	#records = new Map<string, IrcObservationRecord>();
	#nextSequence = 0;

	/** Visible observations expire after 10 seconds; closed-panel observations persist. */
	observe(message: ParsedIrcMessage, panelVisibleAtObservation: boolean): IrcObservationRecord {
		const existing = this.#records.get(message.observationId);
		if (existing) return existing;

		const observedAt = Date.now();
		const mode: InlineMode = panelVisibleAtObservation ? "ephemeral" : "persistent";
		const record: IrcObservationRecord = Object.freeze({
			...message,
			mode,
			observedAt,
			sequence: this.#nextSequence++,
			...(mode === "ephemeral" ? { expiresAt: observedAt + 10_000 } : {}),
		});
		this.#records.set(record.observationId, record);
		return record;
	}

	getRecord(observationId: string): IrcObservationRecord | undefined {
		return this.#records.get(observationId);
	}

	getSidebarRecords(): readonly IrcObservationRecord[] {
		return [...this.#records.values()].sort((a, b) => a.sequence - b.sequence);
	}

	getInlineProjection(now: number): readonly IrcObservationRecord[] {
		return this.getSidebarRecords().filter(record => record.mode === "persistent" || now < record.expiresAt!);
	}

	reset(): void {
		this.#records.clear();
		this.#nextSequence = 0;
	}
}
