import type { GjcCommandsListResult, GjcToolsListResult } from "@gajae-code/app-server-client";

export type PaletteCommand = GjcCommandsListResult["commands"][number];
export type PaletteTool = GjcToolsListResult["tools"][number];



type RankedItem<T> = {
	item: T;
	key: string;
	first: number;
	last: number;
	gaps: number;
};

export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string): T[] {
	const needle = query.trim().toLocaleLowerCase();
	if (needle.length === 0) return [...items].sort((left, right) => key(left).localeCompare(key(right)));

	const ranked: RankedItem<T>[] = [];
	for (const item of items) {
		const itemKey = key(item);
		const match = subsequenceMatch(itemKey.toLocaleLowerCase(), needle);
		if (!match) continue;
		ranked.push({ item, key: itemKey, ...match });
	}

	return ranked
		.sort((left, right) => {
			const span = left.last - left.first - (right.last - right.first);
			if (span !== 0) return span;
			const gaps = left.gaps - right.gaps;
			if (gaps !== 0) return gaps;
			const start = left.first - right.first;
			if (start !== 0) return start;
			return left.key.localeCompare(right.key);
		})
		.map(entry => entry.item);
}

export type PaletteCommandAction =
	| { kind: "navigate"; target: "model" | "theme" | "session" | "settings" | "provider" | "tools" | "skills" | "extensions" | "plugins" }
	| { kind: "invoke"; target: "compact" | "retry" | "new" | "copy" | "dump" | "drop" | "resume" | "move" }
	| { kind: "local-sheet"; target: "help" | "hotkeys" }
	| { kind: "insert-prompt" }
	| { kind: "disabled"; reason: string };

export function normalizeCommandName(raw: string): string {
	return raw.startsWith("/") ? raw.slice(1) : raw;
}

const COMMAND_ACTIONS: Record<string, PaletteCommandAction> = {
	model: { kind: "navigate", target: "model" },
	theme: { kind: "navigate", target: "theme" },
	session: { kind: "navigate", target: "session" },
	settings: { kind: "navigate", target: "settings" },
	provider: { kind: "navigate", target: "provider" },
	tools: { kind: "navigate", target: "tools" },
	skills: { kind: "navigate", target: "skills" },
	extensions: { kind: "navigate", target: "extensions" },
	plugins: { kind: "navigate", target: "plugins" },
	agents: { kind: "navigate", target: "tools" },
	context: { kind: "navigate", target: "tools" },
	jobs: { kind: "navigate", target: "tools" },
	monitors: { kind: "navigate", target: "tools" },
	usage: { kind: "navigate", target: "tools" },
	tree: { kind: "navigate", target: "tools" },
	export: { kind: "navigate", target: "session" },
	rename: { kind: "navigate", target: "session" },
	fast: { kind: "navigate", target: "model" },
	goal: { kind: "navigate", target: "model" },
	logout: { kind: "navigate", target: "provider" },
	login: { kind: "navigate", target: "provider" },
	compact: { kind: "invoke", target: "compact" },
	retry: { kind: "invoke", target: "retry" },
	new: { kind: "invoke", target: "new" },
	copy: { kind: "invoke", target: "copy" },
	dump: { kind: "invoke", target: "dump" },
	drop: { kind: "invoke", target: "drop" },
	resume: { kind: "invoke", target: "resume" },
	move: { kind: "invoke", target: "move" },
	help: { kind: "local-sheet", target: "help" },
	hotkeys: { kind: "local-sheet", target: "hotkeys" },
};

export function commandAction(command: PaletteCommand): PaletteCommandAction {
	const name = normalizeCommandName(command.name);
	const action = COMMAND_ACTIONS[name];
	if (action) return action;
	if (name.startsWith("skill:")) return { kind: "disabled", reason: "Skill commands are not expandable in the GUI yet" };
	if (command.source === "builtin") return { kind: "disabled", reason: "Not available in the GUI yet" };
	return { kind: "insert-prompt" };
}
export function classifyBadge(classification?: string | null): { label: string; disabled: boolean } {
	switch (classification) {
		case "in-scope-existing":
		case "in-scope-new":
		case undefined:
		case null:
			return { label: "", disabled: false };
		case "prompt-display-only":
			return { label: "prompt", disabled: false };
		case "deferred-needs-new-api":
			return { label: "soon", disabled: true };
		case "excluded-terminal-only":
			return { label: "terminal-only", disabled: true };
		default:
			return { label: classification, disabled: false };
	}
}

export function commandDisabled(command: PaletteCommand): boolean {
	return classifyBadge(command.classification).disabled || commandAction(command).kind === "disabled";
}

export function commandDisplayText(cmd: PaletteCommand): string {
	return `/${normalizeCommandName(cmd.name)}`;
}

export function commandInsertText(cmd: PaletteCommand): string {
	return `${commandDisplayText(cmd)} `;
}

function subsequenceMatch(haystack: string, needle: string): { first: number; last: number; gaps: number } | undefined {
	let cursor = 0;
	let first = -1;
	let last = -1;
	let gaps = 0;
	let previous = -1;

	for (let index = 0; index < haystack.length && cursor < needle.length; index += 1) {
		if (haystack[index] !== needle[cursor]) continue;
		if (first === -1) first = index;
		if (previous !== -1) gaps += index - previous - 1;
		previous = index;
		last = index;
		cursor += 1;
	}

	if (cursor !== needle.length) return undefined;
	return { first, last, gaps };
}
