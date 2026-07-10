import type { GjcCommandsListResult, GjcToolsListResult } from "@gajae-code/app-server-client";

export type PaletteCommand = GjcCommandsListResult["commands"][number];
export type PaletteTool = GjcToolsListResult["tools"][number];

// Source of truth: docs/gui-tui-parity-matrix.md command palette section.
export const COMMAND_CLASSIFICATION: Record<string, string> = {
	settings: "deferred-needs-new-api",
	fast: "deferred-needs-new-api",
	goal: "deferred-needs-new-api",
	jobs: "deferred-needs-new-api",
	context: "deferred-needs-new-api",
	usage: "deferred-needs-new-api",
	agents: "deferred-needs-new-api",
	monitors: "deferred-needs-new-api",
	tree: "deferred-needs-new-api",
	provider: "deferred-needs-new-api",
	login: "deferred-needs-new-api",
	logout: "deferred-needs-new-api",
	rename: "deferred-needs-new-api",
	move: "deferred-needs-new-api",
	export: "deferred-needs-new-api",
	memory: "deferred-needs-new-api",
	btw: "deferred-needs-new-api",
	"contribute-pr": "deferred-needs-new-api",
	background: "excluded-terminal-only",
	debug: "excluded-terminal-only",
	ssh: "excluded-terminal-only",
	exit: "excluded-terminal-only",
	help: "prompt-display-only",
	hotkeys: "prompt-display-only",
	model: "in-scope-existing",
	session: "in-scope-existing",
	new: "in-scope-existing",
	drop: "in-scope-existing",
	resume: "in-scope-existing",
	compact: "in-scope-existing",
	copy: "in-scope-existing",
	dump: "in-scope-existing",
	theme: "deferred-needs-new-api",
	tools: "in-scope-new",
	retry: "deferred-needs-new-api",
};

export function resolveClassification(cmd: PaletteCommand): string | undefined {
	if (cmd.classification) return cmd.classification;
	const mapped = COMMAND_CLASSIFICATION[cmd.name];
	if (mapped) return mapped;
	return cmd.source === "file" || cmd.source === "skill" || cmd.source === "extension"
		? "prompt-display-only"
		: undefined;
}

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

export function commandInsertText(cmd: PaletteCommand): string {
	return `/${cmd.name} `;
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
