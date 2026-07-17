import { createHash } from "node:crypto";
import { Container, Input, type KeyId, Markdown, type MouseEvent, matchesKey, truncateToWidth } from "@gajae-code/tui";

import { getMarkdownTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

export const PLAN_REVIEW_ACTIONS = [
	"Approve and execute",
	"Approve and compact context",
	"Approve and keep context",
	"Refine plan",
] as const;
export type PlanReviewAction = (typeof PLAN_REVIEW_ACTIONS)[number];
export type PlanPreviewFocus = "preview" | "sourceSelect" | "commentInput" | "actionBar";
export interface PlanPreviewOptions {
	externalEditorKey?: string;
	externalEditorKeys?: readonly KeyId[];
	onExternalEditor?: () => Promise<string | null>;
}

export interface PlanComment {
	id: string;
	startLine: number;
	endLine: number;
	text: string;
	snapshotHash: string;
	createdAt: number;
}
export interface PlanPreviewResult {
	action?: PlanReviewAction;
	comments: PlanComment[];
	notes: string;
	snapshotHash: string;
}

export function planSnapshotHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}
export function serializePlanReviewComments(
	content: string,
	hash: string,
	comments: readonly PlanComment[],
	notes = "",
): string {
	const valid = comments.filter(comment => comment.snapshotHash === hash && comment.text.trim());
	if (!valid.length && !notes.trim()) return "";
	const lines = content.split("\n").map(line => line.replace(/\r$/, ""));
	const block = [`Plan review comments (snapshot ${hash.slice(0, 8)}):`];
	for (const comment of valid) {
		const end = Math.max(comment.startLine, comment.endLine);
		block.push(`- L${comment.startLine}${end === comment.startLine ? "" : `-L${end}`}: ${comment.text.trim()}`);
		const start = Math.max(1, Math.min(comment.startLine, lines.length));
		const last = Math.max(start, Math.min(end, comment.startLine + 5, lines.length));
		for (let line = start; line <= last; line++) block.push(`> ${lines[line - 1]}`);
	}
	if (notes.trim()) block.push(notes.trim());
	return block.join("\n");
}

/** Modal pre-decision review. Its result is consumed by InteractiveMode, which owns audit and dispatch semantics. */
export class PlanPreviewOverlay extends Container {
	#focus: PlanPreviewFocus = "preview";
	#scroll = 0;
	#sourceLine = 1;
	#actionIndex = 0;
	#comments: PlanComment[] = [];
	#notes = "";
	#input = new Input();
	#inputKind: "comment" | "notes" = "comment";
	content: string | null;

	snapshotHash: string;
	lines: string[];
	constructor(
		content: string | null,
		private readonly done: (result: PlanPreviewResult) => void,
		private readonly requestRender: () => void,
		private readonly options: PlanPreviewOptions = {},
	) {
		super();
		this.content = content;
		this.snapshotHash = planSnapshotHash(content ?? "");
		this.lines = (content ?? "").split("\n");
		this.#input.onSubmit = text => this.#saveInput(text);
	}

	get focusState(): PlanPreviewFocus {
		return this.#focus;
	}
	get comments(): readonly PlanComment[] {
		return this.#comments;
	}
	get pageOffset(): number {
		return this.#scroll;
	}
	get sourceLine(): number {
		return this.#sourceLine;
	}
	override render(width: number): string[] {
		const height = Math.max(5, (process.stdout.rows || 40) - 8);
		const body = this.content
			? new Markdown(this.content, 0, 0, getMarkdownTheme()).render(Math.max(1, width - 2))
			: [theme.fg("warning", "Plan file is empty or missing.")];
		this.#scroll = Math.max(0, Math.min(this.#scroll, Math.max(0, body.length - height)));
		const visible = body.slice(this.#scroll, this.#scroll + height);
		const actions = PLAN_REVIEW_ACTIONS.map(
			(action, index) => `${this.#focus === "actionBar" && index === this.#actionIndex ? "▶ " : "  "}${action}`,
		);
		const actionBar = width < 40 ? actions : [actions.join("  ")];
		const footer =
			this.#focus === "commentInput"
				? `${this.#inputKind === "notes" ? "Notes" : `Comment for source line ${this.#sourceLine}`} (Enter save, Esc cancel): ${this.#input.getValue()}`
				: this.#focus === "sourceSelect"
					? `Source line ${this.#sourceLine}/${this.lines.length || 1}  j/k:select  c:comment  Esc:done`
					: `${this.#scroll + 1}-${Math.min(this.#scroll + height, body.length)}/${body.length || 1}  s:source line  n:notes  ${this.options.externalEditorKey ? `${this.options.externalEditorKey.toLowerCase()}:edit  ` : ""}Tab:actions  PgUp/PgDn:page`;

		const rendered = [
			new DynamicBorder().render(width)[0] ?? "",
			` ${theme.bold(theme.fg("accent", "Plan review"))}`,
			...visible.map(line => ` ${line}`),
			"",
			...actionBar.map(action => ` ${action}`),
			` ${footer}`,
			new DynamicBorder().render(width)[0] ?? "",
		];
		return rendered.map(line =>
			!this.content && width < 40 && PLAN_REVIEW_ACTIONS.some(action => line.includes(action))
				? line
				: truncateToWidth(line, width),
		);
	}
	handleMouse(event: MouseEvent): void {
		if (event.kind !== "click" || this.#focus === "commentInput") return;
		const sourceLine = this.#scroll + (event.localY ?? event.y) - 2;
		if (sourceLine < 1 || sourceLine > this.lines.length) return;
		this.#sourceLine = sourceLine;
		this.#focus = "sourceSelect";
		this.requestRender();
	}

	handleInput(key: string): void {
		if (this.#focus === "commentInput") {
			if (matchesKey(key, "escape")) {
				this.#focus = "preview";
				this.#input.setValue("");
				this.requestRender();
				return;
			}
			this.#input.handleInput(key);
			this.requestRender();
			return;
		}
		if (matchesKey(key, "escape")) {
			this.done({ comments: this.#comments, notes: this.#notes, snapshotHash: this.snapshotHash });
			return;
		}
		if (this.#matchesExternalEditor(key)) {
			void this.#openExternalEditor();
			return;
		}

		if (matchesKey(key, "tab")) {
			this.#focus = this.#focus === "actionBar" ? "preview" : "actionBar";
			this.requestRender();
			return;
		}
		if (this.#focus === "actionBar") {
			if (matchesKey(key, "left") || matchesKey(key, "up")) this.#actionIndex = Math.max(0, this.#actionIndex - 1);
			else if (matchesKey(key, "right") || matchesKey(key, "down"))
				this.#actionIndex = Math.min(PLAN_REVIEW_ACTIONS.length - 1, this.#actionIndex + 1);
			else if (matchesKey(key, "enter") || key === "\r")
				this.done({
					action: PLAN_REVIEW_ACTIONS[this.#actionIndex],
					comments: this.#comments,

					notes: this.#notes,
					snapshotHash: this.snapshotHash,
				});
			this.requestRender();
			return;
		}
		if (this.#focus === "sourceSelect") {
			if (key === "j" || matchesKey(key, "down"))
				this.#sourceLine = Math.min(this.lines.length || 1, this.#sourceLine + 1);
			else if (key === "k" || matchesKey(key, "up")) this.#sourceLine = Math.max(1, this.#sourceLine - 1);
			else if (key === "c") {
				this.#inputKind = "comment";
				this.#focus = "commentInput";
			} else if (matchesKey(key, "enter")) this.#focus = "preview";
			this.requestRender();
			return;
		}
		if (key === "s") {
			this.#focus = "sourceSelect";
			this.requestRender();
			return;
		}
		if (key === "c") {
			this.#inputKind = "comment";
			this.#focus = "commentInput";
			this.requestRender();
			return;
		}
		if (key === "n") {
			this.#inputKind = "notes";
			this.#focus = "commentInput";
			this.requestRender();
			return;
		}
		if (matchesKey(key, "pageDown")) this.#scroll += 15;
		if (matchesKey(key, "pageUp")) this.#scroll -= 15;
		this.requestRender();
	}
	#saveInput(text: string): void {
		if (text.trim()) {
			if (this.#inputKind === "notes") this.#notes = text;
			else
				this.#comments.push({
					id: crypto.randomUUID(),
					startLine: this.#sourceLine,
					endLine: this.#sourceLine,
					text,
					snapshotHash: this.snapshotHash,
					createdAt: Date.now(),
				});
		}
		this.#input.setValue("");
		this.#focus = "preview";
		this.requestRender();
	}
	#matchesExternalEditor(key: string): boolean {
		return Boolean(
			this.options.onExternalEditor && this.options.externalEditorKeys?.some(binding => matchesKey(key, binding)),
		);
	}
	async #openExternalEditor(): Promise<void> {
		const updatedContent = await this.options.onExternalEditor?.();
		if (updatedContent === null || updatedContent === undefined || updatedContent === this.content) return;
		this.content = updatedContent;
		this.snapshotHash = planSnapshotHash(updatedContent);
		this.lines = updatedContent.split("\n");
		this.#comments = [];
		this.#notes = "";
		this.#scroll = 0;
		this.#sourceLine = 1;
		this.#focus = "preview";
		this.requestRender();
	}
}
