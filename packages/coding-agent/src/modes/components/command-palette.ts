import {
	Container,
	Ellipsis,
	Input,
	matchesKey,
	padding,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@gajae-code/tui";
import { fuzzyFilter } from "@gajae-code/tui/fuzzy";
import { theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

export type CommandPaletteEntry = {
	id: string;
	label: string;
	category: string;
	description?: string;
	bindingHint?: string;
	disabled?: boolean;
};

class CommandPaletteResults {
	#entries: readonly CommandPaletteEntry[] = [];
	#selectedIndex = -1;
	#viewportStart = 0;

	setEntries(entries: readonly CommandPaletteEntry[], selectedIndex: number, viewportStart: number): void {
		this.#entries = entries;
		this.#selectedIndex = selectedIndex;
		this.#viewportStart = viewportStart;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.#entries.length === 0) return [theme.fg("muted", "  No matching commands")];
		return this.#entries.slice(this.#viewportStart, this.#viewportStart + 10).map((entry, index) => {
			const entryIndex = this.#viewportStart + index;
			const prefix =
				entryIndex === this.#selectedIndex
					? theme.fg("accent", `${theme.nav.cursor} `)
					: padding(visibleWidth(theme.nav.cursor) + 1);
			const hint = entry.bindingHint ? theme.fg("muted", `  ${entry.bindingHint}`) : "";
			const secondary = entry.description ?? entry.category;
			const text = `${prefix}${entry.label}${theme.fg("muted", `  ${secondary}`)}${hint}`;
			return entry.disabled
				? theme.fg("muted", truncateToWidth(text, width, Ellipsis.Omit))
				: truncateToWidth(text, width, Ellipsis.Omit);
		});
	}
}

/** Modal, fuzzy-searchable action palette. The host owns close-then-execute ordering. */
export class CommandPalette extends Container {
	readonly #input = new Input();
	readonly #results = new CommandPaletteResults();
	#filtered: readonly CommandPaletteEntry[] = [];
	#selectedIndex = -1;
	#viewportStart = 0;

	constructor(
		private readonly entries: readonly CommandPaletteEntry[],
		private readonly onSelect: (entry: CommandPaletteEntry) => void,
		private readonly onCancel: () => void,
	) {
		super();
		this.#input.onEscape = onCancel;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Command palette"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.#input);
		this.addChild(new Spacer(1));
		this.addChild(this.#results);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "type to filter  up/down navigate  enter select  esc close"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.#updateResults();
	}

	getEntries(): readonly CommandPaletteEntry[] {
		return this.#filtered;
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "escape")) return this.onCancel();
		if (matchesKey(keyData, "up")) return this.#move(-1);
		if (matchesKey(keyData, "down")) return this.#move(1);
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const entry = this.#filtered[this.#selectedIndex];
			if (entry && !entry.disabled) this.onSelect(entry);
			return;
		}
		this.#input.handleInput(keyData);
		this.#updateResults();
	}

	#updateResults(): void {
		const query = this.#input.getValue();
		this.#filtered = fuzzyFilter([...this.entries], query, entry =>
			[entry.label, entry.category, entry.description, entry.bindingHint].filter(Boolean).join(" "),
		);
		this.#selectedIndex = this.#firstEnabledIndex();
		this.#viewportStart = 0;
		this.#results.setEntries(this.#filtered, this.#selectedIndex, this.#viewportStart);
	}

	#firstEnabledIndex(): number {
		return this.#filtered.findIndex(entry => !entry.disabled);
	}

	#viewportStartFor(selectedIndex: number): number {
		if (selectedIndex < this.#viewportStart) return selectedIndex;
		if (selectedIndex >= this.#viewportStart + 10) return selectedIndex - 9;
		return this.#viewportStart;
	}

	#move(direction: -1 | 1): void {
		if (this.#filtered.length === 0) return;
		for (let step = 1; step <= this.#filtered.length; step++) {
			const index =
				(((this.#selectedIndex + direction * step) % this.#filtered.length) + this.#filtered.length) %
				this.#filtered.length;
			if (!this.#filtered[index]?.disabled) {
				this.#selectedIndex = index;
				this.#viewportStart = this.#viewportStartFor(index);
				this.#results.setEntries(this.#filtered, index, this.#viewportStart);
				return;
			}
		}
	}
}
