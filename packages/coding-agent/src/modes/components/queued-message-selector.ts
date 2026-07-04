import { Container, matchesKey, type SelectItem, SelectList, Spacer, Text } from "@gajae-code/tui";
import type { QueuedMessageEditEntry } from "../../session/agent-session";
import { getSelectListTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

const MAX_VISIBLE_QUEUED_MESSAGES = 8;
const RAW_UP = "\x1b[A";
const RAW_DOWN = "\x1b[B";

export class QueuedMessageSelectorComponent extends Container {
	#selectList: SelectList;
	#selectedEntry: QueuedMessageEditEntry | undefined;
	#selectedIndex = 0;
	#onDelete: (entry: QueuedMessageEditEntry, selectedIndex: number) => void;

	constructor(
		entries: QueuedMessageEditEntry[],
		onSelect: (entry: QueuedMessageEditEntry) => void,
		onDelete: (entry: QueuedMessageEditEntry, selectedIndex: number) => void,
		onCancel: () => void,
		options?: { selectedIndex?: number },
	) {
		super();

		this.#onDelete = onDelete;
		const byId = new Map(entries.map(entry => [entry.id, entry]));
		this.#selectedIndex = Math.max(0, Math.min(options?.selectedIndex ?? 0, entries.length - 1));
		this.#selectedEntry = entries[this.#selectedIndex];
		const items: SelectItem[] = entries.map((entry, index) => ({
			value: entry.id,
			label: `${entry.label} ${index + 1}`,
			description: entry.text,
			hint: "Enter edit · Del remove",
		}));

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Queued messages"), 1, 0));
		this.addChild(new Text(theme.fg("muted", "Enter to edit · Delete to remove · Esc to cancel"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.#selectList = new SelectList(items, MAX_VISIBLE_QUEUED_MESSAGES, getSelectListTheme());
		this.#selectList.onSelect = item => {
			const entry = byId.get(item.value);
			if (entry) onSelect(entry);
		};
		this.#selectList.onSelectionChange = item => {
			const index = entries.findIndex(entry => entry.id === item.value);
			this.#selectedIndex = index === -1 ? this.#selectedIndex : index;
			this.#selectedEntry = byId.get(item.value);
		};
		this.#selectList.setSelectedIndex(this.#selectedIndex);
		this.#selectList.onCancel = onCancel;

		this.addChild(this.#selectList);
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "alt+up")) {
			this.#selectList.handleInput(RAW_UP);
			return;
		}
		if (matchesKey(keyData, "alt+down")) {
			this.#selectList.handleInput(RAW_DOWN);
			return;
		}
		if (matchesKey(keyData, "delete")) {
			if (this.#selectedEntry) this.#onDelete(this.#selectedEntry, this.#selectedIndex);
			return;
		}
		this.#selectList.handleInput(keyData);
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}
}
