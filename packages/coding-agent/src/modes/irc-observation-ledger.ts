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

	observe(message: ParsedIrcMessage, settingEnabledAtObservation: boolean): IrcObservationRecord {
		const existing = this.#records.get(message.observationId);
		if (existing) return existing;

		const observedAt = Date.now();
		const mode: InlineMode = settingEnabledAtObservation ? "ephemeral" : "persistent";
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
