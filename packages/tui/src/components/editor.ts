import {
	getProjectDir,
	logger,
	onDefaultTabWidthChange,
	type RetainedMemoryRegistration,
	type RetainedMemoryRegistryFacade,
} from "@gajae-code/utils";
import {
	type AutocompleteProvider,
	type CombinedAutocompleteProvider,
	extractSlashCommandTokenPrefix,
} from "../autocomplete";
import { BracketedPasteHandler } from "../bracketed-paste";
import { getKeybindings, type KeybindingsManager } from "../keybindings";
import { extractPrintableText, matchesKey } from "../keys";
import { KillRing } from "../kill-ring";
import type { SymbolTheme } from "../symbols";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui";
import {
	getSegmenter,
	getWordNavKind,
	isPrintableAscii,
	moveWordLeft,
	moveWordRight,
	padding,
	replaceTabs,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "../utils";
import { SelectList, type SelectListLayoutOptions, type SelectListTheme } from "./select-list";

const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

function sanitizeLoadedText(text: string): string {
	// Normalize CRLF/CR → LF, then strip C0 control chars except \n.
	return replaceTabs(text.replace(/\r\n?/g, "\n"))
		.replace(/[\x00-\x09\x0b-\x1f]/g, "")
		.normalize("NFC");
}

function insertTextNfcAt(line: string, cursorCol: number, text: string): { line: string; cursorCol: number } {
	const before = line.slice(0, cursorCol);
	const after = line.slice(cursorCol);
	const beforeWithInsert = (before + text).normalize("NFC");
	return {
		line: (beforeWithInsert + after).normalize("NFC"),
		cursorCol: beforeWithInsert.length,
	};
}

const segmenter = getSegmenter();

/**
 * Represents a chunk of text for word-wrap layout.
 * Tracks both the text content and its position in the original line.
 */
interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
}

interface WrappedLine {
	chunks: TextChunk[];
	width: number;
}

interface CachedWrappedLine extends WrappedLine {
	lineRef: string;
	contentWidth: number;
}

function wordWrapAsciiLine(line: string, maxWidth: number): TextChunk[] {
	if (line.length <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	}

	const chunks: TextChunk[] = [];
	let chunkStart = 0;
	while (chunkStart < line.length) {
		let chunkEnd = Math.min(line.length, chunkStart + maxWidth);
		if (chunkEnd < line.length) {
			let breakAt = -1;
			for (let i = chunkEnd; i > chunkStart; i--) {
				const code = line.charCodeAt(i - 1);
				if (code === 0x20 || code === 0x09) {
					breakAt = i - 1;
					break;
				}
			}
			if (breakAt > chunkStart) chunkEnd = breakAt;
		}

		const raw = line.slice(chunkStart, chunkEnd);
		const text = raw.trimEnd();
		if (text || chunks.length === 0) {
			chunks.push({ text, startIndex: chunkStart, endIndex: chunkStart + raw.length });
		}
		chunkStart = chunkEnd;
		while (chunkStart < line.length) {
			const code = line.charCodeAt(chunkStart);
			if (code !== 0x20 && code !== 0x09) break;
			chunkStart++;
		}
	}

	return chunks.length > 0 ? chunks : [{ text: "", startIndex: 0, endIndex: 0 }];
}

/**
 * Split a line into word-wrapped chunks.
 * Wraps at word boundaries when possible, falling back to character-level
 * wrapping for words longer than the available width.
 *
 * @param line - The text line to wrap
 * @param maxWidth - Maximum visible width per chunk
 * @returns Array of chunks with text and position information
 */
function wordWrapLine(line: string, maxWidth: number): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0 }];
	}
	if (isPrintableAscii(line)) {
		return wordWrapAsciiLine(line, maxWidth);
	}

	const lineWidth = visibleWidth(line);
	if (lineWidth <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	}

	const chunks: TextChunk[] = [];

	// Split into tokens (words and whitespace runs)
	const tokens: { text: string; startIndex: number; endIndex: number; isWhitespace: boolean }[] = [];
	let currentToken = "";
	let tokenStart = 0;
	let inWhitespace = false;
	let charIndex = 0;

	for (const seg of segmenter.segment(line)) {
		const grapheme = seg.segment;
		const graphemeIsWhitespace = getWordNavKind(grapheme) === "whitespace";

		if (currentToken === "") {
			inWhitespace = graphemeIsWhitespace;
			tokenStart = charIndex;
		} else if (graphemeIsWhitespace !== inWhitespace) {
			// Token type changed - save current token
			tokens.push({
				text: currentToken,
				startIndex: tokenStart,
				endIndex: charIndex,
				isWhitespace: inWhitespace,
			});
			currentToken = "";
			tokenStart = charIndex;
			inWhitespace = graphemeIsWhitespace;
		}

		currentToken += grapheme;
		charIndex += grapheme.length;
	}

	// Push final token
	if (currentToken) {
		tokens.push({
			text: currentToken,
			startIndex: tokenStart,
			endIndex: charIndex,
			isWhitespace: inWhitespace,
		});
	}

	// Build chunks using word wrapping
	let currentChunk = "";
	let currentWidth = 0;
	let chunkStartIndex = 0;
	let atLineStart = true; // Track if we're at the start of a line (for skipping whitespace)

	function consumePrefixToWidth(text: string, availableWidth: number): { text: string; len: number } {
		let prefix = "";
		let prefixWidth = 0;
		let len = 0;
		for (const seg of segmenter.segment(text)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);
			if (prefixWidth + graphemeWidth > availableWidth) break;
			prefix += grapheme;
			prefixWidth += graphemeWidth;
			len += grapheme.length;
			if (prefixWidth === availableWidth) break;
		}
		return { text: prefix, len };
	}
	function hasWideGrapheme(text: string): boolean {
		for (const seg of segmenter.segment(text)) {
			if (visibleWidth(seg.segment) > 1) return true;
		}
		return false;
	}
	for (const token of tokens) {
		const tokenWidth = visibleWidth(token.text);

		// Skip leading whitespace at line start
		if (atLineStart && token.isWhitespace) {
			chunkStartIndex = token.endIndex;
			continue;
		}
		atLineStart = false;

		// If this single token is wider than maxWidth, we need to break it
		if (tokenWidth > maxWidth) {
			// If we're mid-line, try to use the remaining width by consuming a prefix of this long token.
			let consumedPrefix = "";
			let consumedPrefixLen = 0; // JS string index (code units) consumed from token.text
			if (currentChunk && currentWidth < maxWidth) {
				const remainingWidth = maxWidth - currentWidth;
				const consumed = consumePrefixToWidth(token.text, remainingWidth);
				consumedPrefix = consumed.text;
				consumedPrefixLen = consumed.len;
			}
			// First, push any accumulated chunk (optionally filled with the prefix).
			if (currentChunk) {
				if (consumedPrefix) {
					chunks.push({
						text: currentChunk + consumedPrefix,
						startIndex: chunkStartIndex,
						endIndex: token.startIndex + consumedPrefixLen,
					});
					currentChunk = "";
					currentWidth = 0;
					chunkStartIndex = token.startIndex + consumedPrefixLen;
				} else {
					chunks.push({
						text: currentChunk,
						startIndex: chunkStartIndex,
						endIndex: token.startIndex,
					});
					currentChunk = "";
					currentWidth = 0;
					chunkStartIndex = token.startIndex;
				}
			}
			// Break the remaining long token by grapheme
			const remainingText = consumedPrefixLen > 0 ? token.text.slice(consumedPrefixLen) : token.text;
			let tokenChunk = "";
			let tokenChunkWidth = 0;
			let tokenChunkStart = token.startIndex + consumedPrefixLen;
			let tokenCharIndex = token.startIndex + consumedPrefixLen;
			for (const seg of segmenter.segment(remainingText)) {
				const grapheme = seg.segment;
				const graphemeWidth = visibleWidth(grapheme);
				if (tokenChunkWidth + graphemeWidth > maxWidth && tokenChunk) {
					chunks.push({
						text: tokenChunk,
						startIndex: tokenChunkStart,
						endIndex: tokenCharIndex,
					});
					tokenChunk = grapheme;
					tokenChunkWidth = graphemeWidth;
					tokenChunkStart = tokenCharIndex;
				} else {
					tokenChunk += grapheme;
					tokenChunkWidth += graphemeWidth;
				}
				tokenCharIndex += grapheme.length;
			}
			// Keep remainder as start of next chunk
			if (tokenChunk) {
				currentChunk = tokenChunk;
				currentWidth = tokenChunkWidth;
				chunkStartIndex = tokenChunkStart;
			}
			continue;
		}

		// Check if adding this token would exceed width
		if (currentWidth + tokenWidth > maxWidth) {
			// For wide-character tokens (e.g., CJK runs), prefer using remaining width before wrapping
			// the whole token to the next line. This avoids leaving a short ASCII word alone.
			if (currentChunk && !token.isWhitespace && currentWidth < maxWidth && hasWideGrapheme(token.text)) {
				const remainingWidth = maxWidth - currentWidth;
				const consumed = consumePrefixToWidth(token.text, remainingWidth);
				if (consumed.text) {
					chunks.push({
						text: currentChunk + consumed.text,
						startIndex: chunkStartIndex,
						endIndex: token.startIndex + consumed.len,
					});
					const remainder = token.text.slice(consumed.len);
					currentChunk = remainder;
					currentWidth = visibleWidth(remainder);
					chunkStartIndex = token.startIndex + consumed.len;
					atLineStart = false;
					continue;
				}
			}
			// Push current chunk (trimming trailing whitespace for display)
			const trimmedChunk = currentChunk.trimEnd();
			if (trimmedChunk || chunks.length === 0) {
				chunks.push({
					text: trimmedChunk,
					startIndex: chunkStartIndex,
					endIndex: chunkStartIndex + currentChunk.length,
				});
			}
			// Start new line - skip leading whitespace
			atLineStart = true;
			if (token.isWhitespace) {
				currentChunk = "";
				currentWidth = 0;
				chunkStartIndex = token.endIndex;
			} else {
				currentChunk = token.text;
				currentWidth = tokenWidth;
				chunkStartIndex = token.startIndex;
				atLineStart = false;
			}
		} else {
			// Add token to current chunk
			currentChunk += token.text;
			currentWidth += tokenWidth;
		}
	}

	// Push final chunk
	if (currentChunk) {
		chunks.push({
			text: currentChunk,
			startIndex: chunkStartIndex,
			endIndex: line.length,
		});
	}

	return chunks.length > 0 ? chunks : [{ text: "", startIndex: 0, endIndex: 0 }];
}

const DEFAULT_PAGE_SCROLL_LINES = 10;

interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

type UndoKind = "insert" | "paste" | "backspace" | "delete" | "replace";

interface CursorPosition {
	line: number;
	col: number;
}

/**
 * A reversible document range. Byte accounting is UTF-8 payload bytes plus a
 * conservative 64-byte record/header allowance; canonical document bytes and
 * layout caches are intentionally accounted for separately.
 */
interface EditRecord {
	sequence: number;
	start: number;
	deletedText: string;
	insertedText: string;
	beforeCursor: CursorPosition;
	afterCursor: CursorPosition;
	kind: UndoKind;
	bytes: number;
}

export interface EditorRetainedMemoryCounters {
	documentBytes: number;
	undoBytes: number;
	recordCount: number;
	coalesceCount: number;
	editorCacheBuckets: { wrappedLineBytes: number; layoutBytes: number };
}

interface LayoutLine {
	text: string;
	visibleWidth: number;
	logicalLine: number;
	hasCursor: boolean;
	cursorPos?: number;
}

interface LayoutCacheKey {
	docVersion: number;
	contentWidth: number;
	optionsKey: string;
}

interface LayoutCache {
	key: LayoutCacheKey;
	cursorLine: number;
	cursorCol: number;
	lines: LayoutLine[];
	lineStarts: number[];
	lineCounts: number[];
}

export interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
	symbols: SymbolTheme;
	editorPaddingX?: number;
	/** Style function for inline hint/ghost text (dim text after cursor) */
	hintStyle?: (text: string) => string;
}

export interface EditorTopBorder {
	/** The status content (already styled) */
	content: string;
	/** Visible width of the content */
	width: number;
}

export type EditorBorderStyle = "round" | "sharp";

interface HistoryEntry {
	prompt: string;
}

interface HistoryStorage {
	add(prompt: string, cwd?: string): Promise<void>;
	getRecent(limit: number, cwd?: string): HistoryEntry[];
}

/** Test-only performance counters for advisory baseline tests. */
export const __editorPerfCounters = {
	layoutTextInvocations: 0,
	layoutLogicalLinesProcessed: 0,
	visibleWidthMeasurements: 0,
	reset(): void {
		this.layoutTextInvocations = 0;
		this.layoutLogicalLinesProcessed = 0;
		this.visibleWidthMeasurements = 0;
	},
};

export class Editor implements Component, Focusable {
	#state: EditorState = {
		lines: [""],
		cursorLine: 0,
		cursorCol: 0,
	};

	/** Focusable interface - set by TUI when focus changes */
	focused: boolean = false;

	#theme: EditorTheme;
	#useTerminalCursor = false;
	// macOS: Hangul arriving within 50ms of a line-delete is an IME ghost char — discard it.
	#lastLineDeleteAt = 0;

	/** When set, replaces the normal cursor glyph at end-of-text with this ANSI-styled string. */
	cursorOverride: string | undefined;
	/** Display width of the cursorOverride glyph (needed because override may contain ANSI escapes). */
	cursorOverrideWidth: number | undefined;
	#promptGutter: string | undefined;
	#inputPrefix: string | undefined;
	#inputPrefixWidth = 0;
	#placeholder: string | undefined;

	// Store last layout width for cursor navigation
	#lastLayoutWidth: number = 80;
	#paddingXOverride: number | undefined;
	#rightGutterWidth = 0;
	#maxHeight?: number;
	#scrollOffset: number = 0;
	#wrappedLineCache: CachedWrappedLine[] = [];
	#wrappedLineCacheBytes = 0;
	#docVersion = 0;
	#layoutCache: LayoutCache | undefined;
	#layoutCacheBytes = 0;

	// Emacs-style kill ring
	#killRing = new KillRing();
	#lastAction: "kill" | "yank" | null = null;

	// Character jump mode
	#jumpMode: "forward" | "backward" | null = null;

	// Preferred visual column for vertical cursor movement (sticky column)
	#preferredVisualCol: number | null = null;

	// Border color (can be changed dynamically)
	borderColor: (str: string) => string;

	// Autocomplete support
	#autocompleteProvider?: AutocompleteProvider;
	#autocompleteList?: SelectList;
	#autocompleteState: "regular" | "force" | null = null;
	#autocompletePrefix: string = "";
	#autocompleteRequestId: number = 0;
	#autocompleteMaxVisible: number = 5;
	onAutocompleteUpdate?: () => void;

	// Paste tracking for large pastes
	#pastes: Map<number, string> = new Map();
	#pasteCounter: number = 0;

	// Bracketed paste mode buffering
	#pasteHandler = new BracketedPasteHandler();

	// Prompt history for up/down navigation
	#history: string[] = [];
	#historyIndex: number = -1; // -1 = not browsing, 0 = most recent, 1 = older, etc.
	#historyStorage?: HistoryStorage;

	// Byte-bounded reversible edit log. It never owns full editor snapshots.
	#undoStack: EditRecord[] = [];
	#undoRetainedBytes = 0;
	#documentRetainedBytes = 0;
	#undoCoalesceCount = 0;
	#undoSequence = 0;
	#suspendUndo = false;

	// Debounce timer for autocomplete updates
	#autocompleteTimeout?: NodeJS.Timeout;

	onSubmit?: (text: string) => void;
	onAltEnter?: (text: string) => void;
	onChange?: (text: string) => void;
	onAutocompleteCancel?: () => void;
	onTabDeclined?: (text: string) => void;
	/**
	 * Called before Tab opens/applies autocomplete. Return true to consume Tab
	 * for app-level behavior (for example, queueing a draft while a turn runs).
	 */
	onTab?: (text: string) => boolean | undefined;
	disableSubmit: boolean = false;

	// Custom top border (for status line integration)
	#topBorderContent?: EditorTopBorder;
	#borderVisible = true;
	#borderStyle: EditorBorderStyle = "round";
	#closedBorderBox = false;

	#disposeTabWidthListener?: () => void;

	constructor(theme: EditorTheme) {
		this.#theme = theme;
		this.borderColor = theme.borderColor;
		// Raw tabs can reach editor state via insertText()/autocomplete results
		// (setText expands tabs by contract). visibleWidth + wrapping depend on the
		// default tab width, so a runtime tab-width change must drop both caches.
		this.#disposeTabWidthListener = onDefaultTabWidthChange(() => {
			this.invalidate();
			if (this.#inputPrefix !== undefined) {
				this.#inputPrefixWidth = visibleWidth(this.#inputPrefix);
			}
		});
	}

	dispose(): void {
		this.#disposeTabWidthListener?.();
		this.#disposeTabWidthListener = undefined;
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.#autocompleteProvider = provider;
	}

	getAutocompleteProvider(): AutocompleteProvider | undefined {
		return this.#autocompleteProvider;
	}

	/** Whether the autocomplete dropdown is currently open. */
	isAutocompleteOpen(): boolean {
		return this.#autocompleteState !== null && this.#autocompleteList !== undefined;
	}

	/**
	 * Set custom content for the top border (e.g., status line).
	 * Pass undefined to use the default plain border.
	 */
	setTopBorder(content: EditorTopBorder | undefined): void {
		this.#topBorderContent = content;
		this.#invalidateLayoutCache();
	}

	/**
	 * Show or hide the editor border chrome.
	 */
	setBorderVisible(borderVisible: boolean): void {
		this.#borderVisible = borderVisible;
		this.#invalidateLayoutCache();
	}

	setBorderStyle(borderStyle: EditorBorderStyle): void {
		this.#borderStyle = borderStyle;
		this.#invalidateLayoutCache();
	}

	setClosedBorderBox(closedBorderBox: boolean): void {
		this.#closedBorderBox = closedBorderBox;
		this.#invalidateLayoutCache();
	}

	setPromptGutter(promptGutter: string | undefined): void {
		this.#promptGutter = promptGutter;
		this.#invalidateLayoutCache();
	}

	setInputPrefix(inputPrefix: string | undefined): void {
		this.#inputPrefix = inputPrefix;
		this.#inputPrefixWidth = inputPrefix ? visibleWidth(inputPrefix) : 0;
		this.#invalidateLayoutCache();
	}

	setPlaceholder(placeholder: string | undefined): void {
		const trimmed = placeholder?.trim();
		this.#placeholder = trimmed ? trimmed : undefined;
		this.#invalidateLayoutCache();
	}

	/**
	 * Get the available width for top border content given a total terminal width.
	 * Accounts for right gutter, border characters, and horizontal padding when visible.
	 */
	getTopBorderAvailableWidth(terminalWidth: number): number {
		const rightGutterWidth = Math.min(this.#rightGutterWidth, Math.max(0, terminalWidth - 1));
		const renderWidth = Math.max(1, terminalWidth - rightGutterWidth);
		const paddingX = this.#getEditorPaddingX();
		const borderWidth = this.#getHorizontalChromeWidth(paddingX);
		return Math.max(0, renderWidth - borderWidth * 2);
	}

	/**
	 * Use the real terminal cursor instead of rendering a cursor glyph.
	 */
	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#useTerminalCursor = useTerminalCursor;
		this.#invalidateLayoutCache();
	}

	getUseTerminalCursor(): boolean {
		return this.#useTerminalCursor;
	}

	setMaxHeight(maxHeight: number | undefined): void {
		if (this.#maxHeight === maxHeight) return;
		this.#maxHeight = maxHeight;
		// Don't reset scrollOffset — #updateScrollOffset will clamp it on next render
	}

	setPaddingX(paddingX: number): void {
		this.#paddingXOverride = Math.max(0, paddingX);
		this.#invalidateLayoutCache();
	}

	setRightGutterWidth(width: number): void {
		this.#rightGutterWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	}

	getAutocompleteMaxVisible(): number {
		return this.#autocompleteMaxVisible;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		const newMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
		if (this.#autocompleteMaxVisible !== newMaxVisible) {
			this.#autocompleteMaxVisible = newMaxVisible;
		}
	}

	setHistoryStorage(storage: HistoryStorage): void {
		this.#historyStorage = storage;
		const recent = storage.getRecent(100, getProjectDir());
		this.#history = recent.map(entry => entry.prompt);
		this.#historyIndex = -1;
	}

	/**
	 * Add a prompt to history for up/down arrow navigation.
	 * Called after successful submission.
	 */
	addToHistory(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		// Don't add consecutive duplicates
		if (this.#history.length > 0 && this.#history[0] === trimmed) return;
		this.#history.unshift(trimmed);
		// Limit history size
		if (this.#history.length > 100) {
			this.#history.pop();
		}

		const stor = this.#historyStorage;
		if (stor) {
			stor.add(trimmed, getProjectDir()).catch(error => {
				logger.error("HistoryStorage add failed", { error: String(error) });
			});
		}
	}

	#isEditorEmpty(): boolean {
		return this.#state.lines.length === 1 && this.#state.lines[0] === "";
	}

	#isOnFirstVisualLine(): boolean {
		const visualLines = this.#buildVisualLineMap(this.#lastLayoutWidth);
		const currentVisualLine = this.#findCurrentVisualLine(visualLines);
		return currentVisualLine === 0;
	}

	#isOnLastVisualLine(): boolean {
		const visualLines = this.#buildVisualLineMap(this.#lastLayoutWidth);
		const currentVisualLine = this.#findCurrentVisualLine(visualLines);
		return currentVisualLine === visualLines.length - 1;
	}

	#navigateHistory(direction: 1 | -1): void {
		this.#breakUndoCoalescing();
		this.#resetKillSequence();
		if (this.#history.length === 0) return;
		const newIndex = this.#historyIndex - direction; // Up(-1) increases index, Down(1) decreases
		if (newIndex < -1 || newIndex >= this.#history.length) return;
		this.#historyIndex = newIndex;
		const text = this.#historyIndex === -1 ? "" : this.#history[this.#historyIndex] || "";
		const sanitized = sanitizeLoadedText(text);
		const lines = sanitized.split("\n");
		const afterCursor =
			direction === -1 ? { line: 0, col: 0 } : { line: lines.length - 1, col: lines.at(-1)?.length || 0 };
		this.#applyRangeEdit(0, this.getText().length, sanitized, afterCursor, "replace");
		if (this.onChange) this.onChange(this.getText());
	}
	/** Internal setText that resets undo history for external buffer replacement. */
	#setTextInternal(text: string): void {
		this.#clearUndo();
		const lines = sanitizeLoadedText(text).split("\n");
		this.#state.lines = lines.length === 0 ? [""] : lines;
		this.#documentRetainedBytes = Buffer.byteLength(this.#state.lines.join("\n"), "utf8");
		this.#state.cursorLine = this.#state.lines.length - 1;
		this.#setCursorCol(this.#state.lines[this.#state.cursorLine]?.length || 0);

		if (this.onChange) {
			this.onChange(this.getText());
		}
		this.#clearWrappedLineCache();
		this.#bumpDocumentVersion();
	}

	#clearWrappedLineCache(): void {
		this.#wrappedLineCache.length = 0;
		this.#wrappedLineCacheBytes = 0;
	}

	#clearLayoutCache(): void {
		this.#layoutCache = undefined;
		this.#layoutCacheBytes = 0;
	}

	invalidate(): void {
		this.#clearWrappedLineCache();
		this.#clearLayoutCache();
	}

	#bumpDocumentVersion(): void {
		this.#docVersion += 1;
		this.#clearLayoutCache();
	}

	#invalidateLayoutCache(): void {
		this.#clearLayoutCache();
	}

	#getEditorPaddingX(): number {
		const padding = this.#paddingXOverride ?? this.#theme.editorPaddingX ?? 2;
		return Math.max(0, padding);
	}

	#getHorizontalChromeWidth(paddingX: number): number {
		return this.#borderVisible ? paddingX + 1 : 0;
	}

	#getPromptGutterWidth(width: number, paddingX: number): number {
		if (this.#borderVisible || !this.#promptGutter) return 0;
		const chromeWidth = 2 * this.#getHorizontalChromeWidth(paddingX);
		const availableWidth = Math.max(0, width - chromeWidth);
		return Math.min(visibleWidth(this.#promptGutter), availableWidth);
	}

	#getPromptGutter(
		width: number,
		paddingX: number,
	): { firstLine: string; continuation: string; width: number } | undefined {
		if (this.#borderVisible || !this.#promptGutter) return undefined;
		const gutterWidth = this.#getPromptGutterWidth(width, paddingX);
		if (gutterWidth === 0) return undefined;
		return {
			firstLine: sliceByColumn(this.#promptGutter, 0, gutterWidth, true),
			continuation: padding(gutterWidth),
			width: gutterWidth,
		};
	}

	#getContentWidth(width: number, paddingX: number): number {
		const chromeWidth = 2 * this.#getHorizontalChromeWidth(paddingX);
		return Math.max(0, width - chromeWidth - this.#getPromptGutterWidth(width, paddingX));
	}

	#getLayoutWidth(width: number, paddingX: number): number {
		const contentWidth = this.#getContentWidth(width, paddingX);
		const cursorReserve = this.#borderVisible && paddingX === 0 ? 1 : 0;
		// Keep cursor/scroll layout addressable even when a borderless prompt gutter consumes every visible column.
		return Math.max(1, contentWidth - cursorReserve);
	}

	#getVisibleContentHeight(contentLines: number): number {
		if (this.#maxHeight === undefined) return contentLines;
		const verticalChrome = this.#borderVisible ? 2 : 0;
		return Math.max(1, this.#maxHeight - verticalChrome);
	}

	#getStyledInputCursor(): { text: string; width: number } {
		const cursorChar = this.#theme.symbols.inputCursor;
		return { text: `\x1b[5m${cursorChar}\x1b[0m`, width: visibleWidth(cursorChar) };
	}

	#renderEndOfLineCursorAtWidthLimit(
		before: string,
		marker: string,
		maxWidth: number,
		replacement?: { text: string; width: number },
	): { text: string; width: number } {
		const beforeGraphemes = [...segmenter.segment(before)];
		const lastGrapheme = beforeGraphemes[beforeGraphemes.length - 1]?.segment;
		const lastGraphemeWidth = lastGrapheme ? visibleWidth(lastGrapheme) : 0;
		const builtInCursor = this.#getStyledInputCursor();
		const fallbackReplacement = lastGrapheme
			? { text: `\x1b[7m${lastGrapheme}\x1b[0m`, width: lastGraphemeWidth }
			: builtInCursor;
		const clampReplacement = (candidate: { text: string; width: number }): { text: string; width: number } => {
			let text = sliceByColumn(candidate.text, 0, maxWidth, true);
			let width = visibleWidth(text);
			if (width > maxWidth) {
				text = "";
				width = 0;
			}
			return { text, width };
		};

		let clampedReplacement = clampReplacement(replacement ?? fallbackReplacement);
		if (replacement && clampedReplacement.width === 0) {
			// A custom override that cannot fit at all should first fall back to the highlighted tail.
			clampedReplacement = clampReplacement(fallbackReplacement);
		}
		if (lastGrapheme && clampedReplacement.width === 0) {
			// If even the highlighted trailing grapheme cannot fit, show the built-in single-column cursor.
			clampedReplacement = clampReplacement(builtInCursor);
		}

		const replacedSpanWidth = Math.min(maxWidth, Math.max(lastGraphemeWidth, clampedReplacement.width));
		const prefixWidth = Math.max(0, maxWidth - replacedSpanWidth);
		const beforePrefix = sliceByColumn(before, 0, prefixWidth, true);
		const replacementPad = padding(Math.max(0, replacedSpanWidth - clampedReplacement.width));
		return {
			text: `${beforePrefix}${replacementPad}${clampedReplacement.text}${marker}`,
			width: visibleWidth(beforePrefix) + replacedSpanWidth,
		};
	}

	#renderTerminalCursorMarker(text: string, marker: string, maxWidth: number): string {
		if (!marker) return text;
		if (visibleWidth(text) < maxWidth) {
			return text + marker;
		}

		let insertAt = text.length;
		let offset = 0;
		for (const seg of segmenter.segment(text)) {
			if (visibleWidth(seg.segment) > 0) {
				insertAt = offset;
			}
			offset += seg.segment.length;
		}

		return `${text.slice(0, insertAt)}${marker}${text.slice(insertAt)}`;
	}

	#getPageScrollStep(totalVisualLines: number): number {
		const visibleHeight =
			this.#maxHeight === undefined ? DEFAULT_PAGE_SCROLL_LINES : this.#getVisibleContentHeight(totalVisualLines);
		return Math.max(1, visibleHeight - 1);
	}

	#findCurrentLayoutLine(layoutLines: LayoutLine[]): number {
		const index = layoutLines.findIndex(line => line.hasCursor);
		return index === -1 ? Math.max(0, layoutLines.length - 1) : index;
	}

	#updateScrollOffset(layoutLines: LayoutLine[], visibleHeight: number): void {
		if (layoutLines.length <= visibleHeight) {
			this.#scrollOffset = 0;
			return;
		}

		const cursorLine = this.#findCurrentLayoutLine(layoutLines);
		if (cursorLine < this.#scrollOffset) {
			this.#scrollOffset = cursorLine;
		} else if (cursorLine >= this.#scrollOffset + visibleHeight) {
			this.#scrollOffset = cursorLine - visibleHeight + 1;
		}

		const maxOffset = Math.max(0, layoutLines.length - visibleHeight);
		this.#scrollOffset = Math.min(this.#scrollOffset, maxOffset);
	}

	render(width: number): string[] {
		const rightGutterWidth = Math.min(this.#rightGutterWidth, Math.max(0, width - 1));
		const renderWidth = Math.max(1, width - rightGutterWidth);
		const paddingX = this.#getEditorPaddingX();
		const borderVisible = this.#borderVisible;
		const promptGutter = this.#getPromptGutter(renderWidth, paddingX);
		const contentAreaWidth = this.#getContentWidth(renderWidth, paddingX);
		const inputPrefixWidth = this.#inputPrefixWidth;
		const layoutWidth = Math.max(1, this.#getLayoutWidth(renderWidth, paddingX) - inputPrefixWidth);
		this.#lastLayoutWidth = layoutWidth;

		// Box-drawing characters for the configured input box shape.
		const box = this.#borderStyle === "sharp" ? this.#theme.symbols.boxSharp : this.#theme.symbols.boxRound;
		const borderWidth = this.#getHorizontalChromeWidth(paddingX);
		const topLeft = this.borderColor(`${box.topLeft}${box.horizontal.repeat(paddingX)}`);
		const topRight = this.borderColor(`${box.horizontal.repeat(paddingX)}${box.topRight}`);
		const bottomLeft = this.borderColor(`${box.bottomLeft}${box.horizontal}${padding(Math.max(0, paddingX - 1))}`);
		const horizontal = this.borderColor(box.horizontal);

		// Layout the text
		const layoutLines = this.#layoutText(layoutWidth);
		const visibleContentHeight = this.#getVisibleContentHeight(layoutLines.length);
		this.#updateScrollOffset(layoutLines, visibleContentHeight);
		const visibleLayoutLines = layoutLines.slice(this.#scrollOffset, this.#scrollOffset + visibleContentHeight);

		const result: string[] = [];

		if (borderVisible) {
			// Render top border: ╭─ [status content] ────────────────╮
			const topFillWidth = Math.max(0, renderWidth - borderWidth * 2);
			if (this.#topBorderContent) {
				const { content, width: statusWidth } = this.#topBorderContent;
				if (statusWidth <= topFillWidth) {
					// Status fits - add fill after it
					const fillWidth = topFillWidth - statusWidth;
					result.push(topLeft + content + this.borderColor(box.horizontal.repeat(fillWidth)) + topRight);
				} else {
					// Status too long - truncate it
					const truncated = truncateToWidth(content, Math.max(0, topFillWidth - 1));
					const truncatedWidth = visibleWidth(truncated);
					const fillWidth = Math.max(0, topFillWidth - truncatedWidth);
					result.push(topLeft + truncated + this.borderColor(box.horizontal.repeat(fillWidth)) + topRight);
				}
			} else {
				result.push(topLeft + horizontal.repeat(topFillWidth) + topRight);
			}
		}

		// Render each layout line
		// Emit hardware cursor marker only when focused and not showing autocomplete
		const emitCursorMarker = this.focused && !this.#autocompleteState;
		const lineContentWidth = Math.max(0, contentAreaWidth - inputPrefixWidth);

		// Compute inline hint text (dim ghost text after cursor)
		const inlineHint = this.#getInlineHint();
		const hintStyle = this.#theme.hintStyle ?? ((t: string) => `\x1b[2m${t}\x1b[0m`);
		const showPlaceholder = this.#isEditorEmpty() && !inlineHint && !!this.#placeholder;

		for (let visibleIndex = 0; visibleIndex < visibleLayoutLines.length; visibleIndex++) {
			const layoutLine = visibleLayoutLines[visibleIndex]!;
			let displayText = layoutLine.text;
			let displayWidth = layoutLine.visibleWidth;
			let cursorInPadding = false;
			const absoluteVisibleIndex = this.#scrollOffset + visibleIndex;
			const showPromptGutter = promptGutter !== undefined && visibleIndex === 0;
			const gutterText =
				promptGutter === undefined ? "" : showPromptGutter ? promptGutter.firstLine : promptGutter.continuation;
			const inputPrefix = absoluteVisibleIndex === 0 ? (this.#inputPrefix ?? "") : padding(inputPrefixWidth);

			// Add cursor if this line has it
			let hasCursor = layoutLine.hasCursor && layoutLine.cursorPos !== undefined;
			const marker = emitCursorMarker ? CURSOR_MARKER : "";

			if (showPlaceholder) {
				const hintText = hintStyle(truncateToWidth(this.#placeholder ?? "", lineContentWidth));
				// Anchor the hardware cursor at the input start (terminal-cursor mode) even
				// while the placeholder shows. Otherwise no cursor marker is emitted, the
				// hardware cursor is left at its stale position from the previous frame,
				// and a composing IME preedit renders there instead of at the prompt.
				// The marker is zero-width and stripped before output, so the placeholder is unchanged.
				const anchorCursor = emitCursorMarker && this.#useTerminalCursor && visibleIndex === 0;
				displayText = anchorCursor ? marker + hintText : hintText;
				displayWidth = Math.min(visibleWidth(this.#placeholder ?? ""), lineContentWidth);
				hasCursor = false;
			}

			if (!borderVisible && displayWidth > lineContentWidth) {
				displayText = sliceByColumn(displayText, 0, lineContentWidth, true);
				displayWidth = visibleWidth(displayText);
			}

			if (!borderVisible && lineContentWidth === 0) {
				if (hasCursor && !this.#useTerminalCursor) {
					const zeroWidthCursorBudget = visibleWidth(gutterText);
					const zeroWidthCursorReplacement = this.cursorOverride
						? { text: this.cursorOverride, width: this.cursorOverrideWidth ?? 1 }
						: this.#getStyledInputCursor();
					if (showPromptGutter && zeroWidthCursorBudget > 0) {
						// Keep the leading prompt glyph visible when the gutter consumes the whole row.
						const promptGlyph = [...segmenter.segment(gutterText)][0]?.segment ?? "";
						const promptGlyphWidth = visibleWidth(promptGlyph);
						const remainingCursorWidth = Math.max(0, zeroWidthCursorBudget - promptGlyphWidth);
						if (remainingCursorWidth === 0) {
							result.push(`\x1b[7m${promptGlyph}\x1b[0m${marker}`);
						} else {
							const widthLimitedCursor = this.#renderEndOfLineCursorAtWidthLimit(
								"",
								marker,
								remainingCursorWidth,
								zeroWidthCursorReplacement,
							);
							result.push(`${promptGlyph}${widthLimitedCursor.text}`);
						}
					} else {
						const widthLimitedCursor = this.#renderEndOfLineCursorAtWidthLimit(
							gutterText,
							marker,
							zeroWidthCursorBudget,
							zeroWidthCursorReplacement,
						);
						result.push(widthLimitedCursor.text);
					}
				} else if (hasCursor && this.#useTerminalCursor) {
					result.push(this.#renderTerminalCursorMarker(gutterText, marker, visibleWidth(gutterText)));
				} else {
					result.push(gutterText + (hasCursor ? marker : ""));
				}
				continue;
			}

			if (hasCursor && this.#useTerminalCursor) {
				if (marker) {
					const before = displayText.slice(0, layoutLine.cursorPos);
					const after = displayText.slice(layoutLine.cursorPos);
					const ghostText = showPlaceholder ? this.#placeholder : inlineHint;
					if (after.length === 0 && ghostText) {
						const hintText = hintStyle(truncateToWidth(ghostText, Math.max(0, lineContentWidth - displayWidth)));
						displayText = before + marker + hintText;
						displayWidth += Math.min(visibleWidth(ghostText), Math.max(0, lineContentWidth - displayWidth));
					} else if (after.length === 0 && !borderVisible && displayWidth >= lineContentWidth) {
						displayText = this.#renderTerminalCursorMarker(before, marker, lineContentWidth);
					} else {
						displayText = before + marker + after;
					}
				}
			} else if (hasCursor && !this.#useTerminalCursor) {
				const before = displayText.slice(0, layoutLine.cursorPos);
				const after = displayText.slice(layoutLine.cursorPos);

				if (after.length > 0) {
					// Cursor is on a character (grapheme) - replace it with highlighted version
					// Get the first grapheme from 'after'
					const afterGraphemes = [...segmenter.segment(after)];
					const firstGrapheme = afterGraphemes[0]?.segment || "";
					const restAfter = after.slice(firstGrapheme.length);
					const cursor = `\x1b[7m${firstGrapheme}\x1b[0m`;
					displayText = before + marker + cursor + restAfter;
					// displayWidth stays the same - we're replacing, not adding
				} else if (this.cursorOverride) {
					// Cursor override replaces the normal end-of-text cursor glyph
					const overrideWidth = this.cursorOverrideWidth ?? 1;
					const ghostText = showPlaceholder ? this.#placeholder : inlineHint;
					if (!borderVisible && displayWidth + overrideWidth > lineContentWidth) {
						// Borderless editors have no spare padding cell for an end-of-line cursor glyph.
						// Preserve cursorOverride by replacing the tail of the line with it.
						const widthLimitedCursor = this.#renderEndOfLineCursorAtWidthLimit(before, marker, lineContentWidth, {
							text: this.cursorOverride,
							width: overrideWidth,
						});
						displayText = widthLimitedCursor.text;
						displayWidth = widthLimitedCursor.width;
					} else if (ghostText) {
						const availWidth = Math.max(0, lineContentWidth - displayWidth - overrideWidth);
						const hintText = hintStyle(truncateToWidth(ghostText, availWidth));
						displayText = before + marker + this.cursorOverride + hintText;
						displayWidth += overrideWidth + Math.min(visibleWidth(ghostText), availWidth);
					} else {
						displayText = before + marker + this.cursorOverride;
						displayWidth += overrideWidth;
					}
				} else {
					// Cursor is at the end - add thin cursor glyph
					const { text: cursor, width: cursorWidth } = this.#getStyledInputCursor();
					const ghostText = showPlaceholder ? this.#placeholder : inlineHint;
					if (!borderVisible && displayWidth + cursorWidth > lineContentWidth) {
						// Borderless editors have no spare padding cell for an end-of-line cursor glyph.
						// Highlight the last grapheme so the cursor stays visible without consuming width.
						const widthLimitedCursor = this.#renderEndOfLineCursorAtWidthLimit(before, marker, lineContentWidth);
						displayText = widthLimitedCursor.text;
						displayWidth = widthLimitedCursor.width;
					} else if (ghostText) {
						const availWidth = Math.max(0, lineContentWidth - displayWidth - cursorWidth);
						const hintText = hintStyle(truncateToWidth(ghostText, availWidth));
						displayText = before + marker + cursor + hintText;
						displayWidth += cursorWidth + Math.min(visibleWidth(ghostText), availWidth);
					} else {
						displayText = before + marker + cursor;
						displayWidth += cursorWidth;
					}
					if (displayWidth > lineContentWidth && paddingX > 0) {
						cursorInPadding = true;
					}
				}
			}

			const displayWithPrefix = inputPrefix + displayText;
			const linePad = padding(Math.max(0, lineContentWidth - displayWidth));

			if (!borderVisible) {
				result.push(gutterText + displayWithPrefix + linePad);
				continue;
			}

			// All lines have consistent borders based on padding.
			const isLastLine = visibleIndex === visibleLayoutLines.length - 1;
			const rightPaddingWidth = Math.max(0, paddingX - (cursorInPadding ? 1 : 0));
			if (this.#closedBorderBox) {
				const leftBorder = this.borderColor(`${box.vertical}${padding(paddingX)}`);
				const rightBorder = this.borderColor(`${padding(rightPaddingWidth)}${box.vertical}`);
				result.push(leftBorder + displayWithPrefix + linePad + rightBorder);
			} else if (isLastLine) {
				const bottomRightPadding = Math.max(0, paddingX - 1 - (cursorInPadding ? 1 : 0));
				const bottomRightAdjusted = this.borderColor(
					`${padding(bottomRightPadding)}${box.horizontal}${box.bottomRight}`,
				);
				result.push(`${bottomLeft}${displayWithPrefix}${linePad}${bottomRightAdjusted}`);
			} else {
				const leftBorder = this.borderColor(`${box.vertical}${padding(paddingX)}`);
				const rightBorder = this.borderColor(`${padding(rightPaddingWidth)}${box.vertical}`);
				result.push(leftBorder + displayWithPrefix + linePad + rightBorder);
			}
		}

		if (borderVisible && this.#closedBorderBox) {
			const bottomFillWidth = Math.max(0, renderWidth - borderWidth * 2);
			const bottomLeftClosed = this.borderColor(`${box.bottomLeft}${box.horizontal.repeat(paddingX)}`);
			const bottomRightClosed = this.borderColor(`${box.horizontal.repeat(paddingX)}${box.bottomRight}`);
			result.push(bottomLeftClosed + horizontal.repeat(bottomFillWidth) + bottomRightClosed);
		}

		// Add autocomplete list if active
		if (this.#autocompleteState && this.#autocompleteList) {
			const autocompleteResult = this.#autocompleteList.render(renderWidth);
			result.push(...autocompleteResult);
		}

		if (rightGutterWidth > 0) {
			const rightGutter = padding(rightGutterWidth);
			return result.map(line => line + rightGutter);
		}

		return result;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// Handle character jump mode (awaiting next character to jump to)
		if (this.#jumpMode !== null) {
			// Cancel if the hotkey is pressed again
			if (kb.matches(data, "tui.editor.jumpForward") || kb.matches(data, "tui.editor.jumpBackward")) {
				this.#jumpMode = null;
				return;
			}

			const printableText = extractPrintableText(data);
			if (printableText) {
				const direction = this.#jumpMode;
				this.#jumpMode = null;
				this.#jumpToChar(printableText, direction);
				return;
			}

			// Control character - cancel and fall through to normal handling
			this.#jumpMode = null;
		}

		// Handle bracketed paste mode
		const paste = this.#pasteHandler.process(data);
		if (paste.handled) {
			if (paste.pasteContent !== undefined) {
				this.#handlePaste(paste.pasteContent);
				if (paste.remaining.length > 0) {
					this.handleInput(paste.remaining);
				}
			}
			return;
		}

		// Handle special key combinations first

		// Ctrl+C is reserved by parent components for app-level handling.
		// Do not consume arbitrary user-bound "copy" keys here, since the editor
		// has no copy implementation and would make those keys disappear.
		if (matchesKey(data, "ctrl+c")) {
			return;
		}

		// Undo
		if (kb.matches(data, "tui.editor.undo")) {
			this.#applyUndo();
			return;
		}

		if (kb.matches(data, "tui.input.tab") && this.onTab?.(this.getText())) {
			return;
		}

		// Handle autocomplete special keys first (but don't block other input)
		if (this.#autocompleteState && this.#autocompleteList) {
			// Escape - cancel autocomplete
			if (kb.matches(data, "tui.select.cancel")) {
				this.#cancelAutocomplete(true);
				return;
			}
			// Let the autocomplete list handle navigation and selection
			else if (
				kb.matches(data, "tui.select.up") ||
				kb.matches(data, "tui.select.down") ||
				kb.matches(data, "tui.select.pageUp") ||
				kb.matches(data, "tui.select.pageDown") ||
				kb.matches(data, "tui.input.submit") ||
				data === "\n" ||
				kb.matches(data, "tui.input.tab")
			) {
				// Only pass navigation keys to the list, not Enter/Tab (we handle those directly)
				if (
					kb.matches(data, "tui.select.up") ||
					kb.matches(data, "tui.select.down") ||
					kb.matches(data, "tui.select.pageUp") ||
					kb.matches(data, "tui.select.pageDown")
				) {
					this.#autocompleteList.handleInput(data);
					this.onAutocompleteUpdate?.();
					return;
				}

				// If Tab was pressed, always apply the selection
				if (kb.matches(data, "tui.input.tab")) {
					const selected = this.#autocompleteList.getSelectedItem();
					if (selected && this.#autocompleteProvider) {
						const shouldChainSlashCommandAutocomplete = this.#isSlashCommandNameAutocompleteSelection();
						const result = this.#autocompleteProvider.applyCompletion(
							this.#state.lines,
							this.#state.cursorLine,
							this.#state.cursorCol,
							selected,
							this.#autocompletePrefix,
						);

						this.#applyCompletion(result.lines, result.cursorLine, result.cursorCol);

						this.#cancelAutocomplete();
						this.onAutocompleteUpdate?.();

						if (this.onChange) {
							this.onChange(this.getText());
						}

						result.onApplied?.();

						if (shouldChainSlashCommandAutocomplete && this.#isCompletedSlashCommandAtCursor()) {
							void this.#tryTriggerAutocomplete();
						}
					}
					return;
				}

				// If Enter was pressed on a slash command, apply completion and submit
				if ((kb.matches(data, "tui.input.submit") || data === "\n") && this.#autocompletePrefix.startsWith("/")) {
					// Check for stale autocomplete state due to debounce
					const currentLine = this.#state.lines[this.#state.cursorLine] ?? "";
					const currentTextBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
					if (!currentTextBeforeCursor.endsWith(this.#autocompletePrefix)) {
						// Autocomplete is stale - cancel and fall through to normal submission
						this.#cancelAutocomplete();
					} else {
						const selected = this.#autocompleteList.getSelectedItem();
						if (selected && this.#autocompleteProvider) {
							const result = this.#autocompleteProvider.applyCompletion(
								this.#state.lines,
								this.#state.cursorLine,
								this.#state.cursorCol,
								selected,
								this.#autocompletePrefix,
							);

							this.#applyCompletion(result.lines, result.cursorLine, result.cursorCol);
							result.onApplied?.();
						}
						this.#cancelAutocomplete();
					}
					// Don't return - fall through to submission logic
				}
				// If Enter was pressed on a file path, apply completion
				else if (kb.matches(data, "tui.input.submit") || data === "\n") {
					const selected = this.#autocompleteList.getSelectedItem();
					if (selected && this.#autocompleteProvider) {
						const result = this.#autocompleteProvider.applyCompletion(
							this.#state.lines,
							this.#state.cursorLine,
							this.#state.cursorCol,
							selected,
							this.#autocompletePrefix,
						);

						this.#applyCompletion(result.lines, result.cursorLine, result.cursorCol);

						this.#cancelAutocomplete();
						this.onAutocompleteUpdate?.();

						if (this.onChange) {
							this.onChange(this.getText());
						}

						result.onApplied?.();
					}
					return;
				}
			}
			// For other keys (like regular typing), DON'T return here
			// Let them fall through to normal character handling
		}

		// Tab key - context-aware completion (but not when already autocompleting)
		if (kb.matches(data, "tui.input.tab") && !this.#autocompleteState) {
			this.#handleTabCompletion();
			return;
		}

		// Continue with rest of input handling
		// Ctrl+K - Delete to end of line
		if (matchesKey(data, "ctrl+k")) {
			this.#deleteToEndOfLine();
		}
		// Ctrl+U - Delete to start of line
		else if (matchesKey(data, "ctrl+u")) {
			this.#deleteToStartOfLine();
		}
		// Ctrl+W - Delete word backwards
		else if (matchesKey(data, "ctrl+w")) {
			this.#deleteWordBackwards();
		}
		// Option/Alt+Backspace - Delete word backwards
		else if (matchesKey(data, "alt+backspace")) {
			this.#deleteWordBackwards();
		}
		// Option/Alt+D - Delete word forwards
		else if (matchesKey(data, "alt+d") || matchesKey(data, "alt+delete")) {
			this.#deleteWordForwards();
		}
		// Ctrl+Y - Yank from kill ring
		else if (matchesKey(data, "ctrl+y")) {
			this.#yankFromKillRing();
		}
		// Alt+Y - Yank-pop (cycle kill ring)
		else if (matchesKey(data, "alt+y")) {
			this.#yankPop();
		}
		// Ctrl+A - Move to start of line
		else if (matchesKey(data, "ctrl+a")) {
			this.#moveToLineStart();
		}
		// Ctrl+E - Move to end of line
		else if (matchesKey(data, "ctrl+e")) {
			this.#moveToLineEnd();
		}
		// Alt+Enter - special handler if callback exists, otherwise new line
		else if (matchesKey(data, "alt+enter")) {
			if (this.onAltEnter) {
				this.onAltEnter(this.getText());
			} else {
				this.#addNewLine();
			}
		}
		// New line
		else if (
			(data.charCodeAt(0) === 10 && data.length > 1) || // Ctrl+Enter with modifiers
			matchesKey(data, "ctrl+enter") || // Ctrl+Enter (Kitty/modifyOtherKeys, including lock bits/keypad Enter)
			matchesKey(data, "ctrl+shift+enter") || // Ctrl+Shift+Enter (Kitty/modifyOtherKeys combined modifier)
			data === "\x1b\r" || // Option+Enter in some terminals (legacy)
			data === "\x1b[13;2~" || // Shift+Enter in some terminals (legacy format)
			kb.matches(data, "tui.input.newLine") || // Shift+Enter (Kitty protocol, handles lock bits)
			(data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
			(data === "\n" && data.length === 1) // Shift+Enter from terminal sendInput mapping
		) {
			if (this.#shouldSubmitOnBackslashEnter(data, kb)) {
				this.#handleBackspace();
				this.#submitValue();
				return;
			}
			this.#addNewLine();
		}
		// Plain Enter - submit (handles both legacy \r and Kitty protocol with lock bits)
		else if (kb.matches(data, "tui.input.submit") || data === "\n") {
			// If submit is disabled, do nothing
			if (this.disableSubmit) {
				return;
			}

			// Synchronous slash command completion for the race condition where
			// async autocomplete hasn't resolved yet (user types /q quickly + Enter).
			// Match the existing selected-item behavior when autocomplete IS showing.
			if (!this.#autocompleteState) {
				const currentLine = this.#state.lines[this.#state.cursorLine] ?? "";
				const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
				if (
					(this.#isInSubmittedSlashCommandContext() ||
						this.#getSlashTokenBeforeCursor()?.startsWith("/skill") === true) &&
					this.#autocompleteProvider?.trySyncSlashCompletion
				) {
					const syncResult = this.#autocompleteProvider.trySyncSlashCompletion(textBeforeCursor);
					if (syncResult && syncResult.items.length > 0) {
						// Invalidate any pending async autocomplete so its stale results are discarded
						this.#autocompleteRequestId += 1;
						// Apply the best match and submit the completed command
						const selected = syncResult.items[0]!;
						const result = this.#autocompleteProvider.applyCompletion(
							this.#state.lines,
							this.#state.cursorLine,
							this.#state.cursorCol,
							selected,
							syncResult.prefix,
						);
						this.#applyCompletion(result.lines, result.cursorLine, result.cursorCol);
						result.onApplied?.();
					}
				}
			}

			this.#submitValue();
		}
		// Backspace (including Shift+Backspace)
		else if (kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace")) {
			this.#handleBackspace();
		}
		// Line navigation shortcuts (Home/End keys)
		else if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.#moveToLineStart();
		} else if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.#moveToLineEnd();
		}
		// Page navigation (PageUp/PageDown)
		else if (kb.matches(data, "tui.editor.pageUp")) {
			if (this.#isEditorEmpty()) {
				this.#navigateHistory(-1);
			} else if (this.#historyIndex > -1 && this.#isOnFirstVisualLine()) {
				this.#navigateHistory(-1);
			} else {
				this.#pageScroll(-1);
			}
		} else if (kb.matches(data, "tui.editor.pageDown")) {
			if (this.#historyIndex > -1 && this.#isOnLastVisualLine()) {
				this.#navigateHistory(1);
			} else {
				this.#pageScroll(1);
			}
		}
		// Forward delete (Fn+Backspace or Delete key, including Shift+Delete)
		else if (kb.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete")) {
			this.#handleForwardDelete();
		}
		// Word navigation (Option/Alt + Arrow or Ctrl + Arrow)
		else if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			// Word left
			this.#resetKillSequence();
			this.#moveWordBackwards();
		} else if (kb.matches(data, "tui.editor.cursorWordRight")) {
			// Word right
			this.#resetKillSequence();
			this.#moveWordForwards();
		}
		// Arrow keys
		else if (kb.matches(data, "tui.editor.cursorUp")) {
			// Up - history navigation or cursor movement
			if (this.#isEditorEmpty()) {
				this.#navigateHistory(-1); // Start browsing history
			} else if (this.#historyIndex > -1 && this.#isOnFirstVisualLine()) {
				this.#navigateHistory(-1); // Navigate to older history entry
			} else if (this.#isOnFirstVisualLine()) {
				// Already at top - jump to start of line
				this.#moveToLineStart();
			} else {
				this.#moveCursor(-1, 0); // Cursor movement (within text or history entry)
			}
		} else if (kb.matches(data, "tui.editor.cursorDown")) {
			// Down - history navigation or cursor movement
			if (this.#historyIndex > -1 && this.#isOnLastVisualLine()) {
				this.#navigateHistory(1); // Navigate to newer history entry or clear
			} else if (this.#isOnLastVisualLine()) {
				// Already at bottom - jump to end of line
				this.#moveToLineEnd();
			} else {
				this.#moveCursor(1, 0); // Cursor movement (within text or history entry)
			}
		} else if (kb.matches(data, "tui.editor.cursorRight")) {
			// Right
			this.#moveCursor(0, 1);
		} else if (kb.matches(data, "tui.editor.cursorLeft")) {
			// Left
			this.#moveCursor(0, -1);
		}
		// Shift+Space - insert regular space (Kitty protocol sends escape sequence)
		else if (matchesKey(data, "shift+space")) {
			this.#insertCharacter(" ");
		}
		// Character jump mode triggers
		else if (kb.matches(data, "tui.editor.jumpForward")) {
			this.#jumpMode = "forward";
		} else if (kb.matches(data, "tui.editor.jumpBackward")) {
			this.#jumpMode = "backward";
		}
		// Printable keystrokes, including Kitty CSI-u text-producing sequences.
		else {
			const printableText = extractPrintableText(data);
			if (printableText) {
				if (
					process.platform === "darwin" &&
					printableText.length === 1 &&
					Date.now() - this.#lastLineDeleteAt < 50
				) {
					const code = printableText.charCodeAt(0);
					const isHangul =
						(code >= 0xac00 && code <= 0xd7a3) ||
						(code >= 0x1100 && code <= 0x11ff) ||
						(code >= 0x3130 && code <= 0x318f);
					if (isHangul) {
						this.#lastLineDeleteAt = 0;
						return;
					}
				}
				this.#insertCharacter(printableText);
			}
		}
	}

	#applyCompletion(lines: string[], cursorLine: number, cursorCol: number): void {
		let first = 0;
		while (first < this.#state.lines.length && first < lines.length && this.#state.lines[first] === lines[first])
			first++;
		let oldLast = this.#state.lines.length - 1;
		let newLast = lines.length - 1;
		while (oldLast >= first && newLast >= first && this.#state.lines[oldLast] === lines[newLast]) {
			oldLast--;
			newLast--;
		}
		if (first > oldLast && first > newLast) return;
		const start = this.#documentOffset(first, 0);
		const end = oldLast < first ? start : this.#documentOffset(oldLast, (this.#state.lines[oldLast] || "").length);
		const inserted = newLast < first ? "" : lines.slice(first, newLast + 1).join("\n");
		this.#applyRangeEdit(start, end, inserted, { line: cursorLine, col: cursorCol }, "replace");
	}

	#wrappedLineBytes(entry: CachedWrappedLine): number {
		return (
			48 +
			Buffer.byteLength(entry.lineRef, "utf8") +
			entry.chunks.reduce((bytes, chunk) => bytes + 24 + Buffer.byteLength(chunk.text, "utf8"), 0)
		);
	}

	#getWrappedLine(lineIndex: number, contentWidth: number): WrappedLine {
		const line = this.#state.lines[lineIndex] || "";
		const cached = this.#wrappedLineCache[lineIndex];
		if (cached?.lineRef === line && cached.contentWidth === contentWidth) return cached;
		if (cached) this.#wrappedLineCacheBytes -= this.#wrappedLineBytes(cached);
		const width = isPrintableAscii(line) ? line.length : visibleWidth(line);
		const chunks =
			width <= contentWidth
				? [{ text: line, startIndex: 0, endIndex: line.length }]
				: wordWrapLine(line, contentWidth);
		const wrapped = { lineRef: line, contentWidth, width, chunks };
		this.#wrappedLineCache[lineIndex] = wrapped;
		this.#wrappedLineCacheBytes += this.#wrappedLineBytes(wrapped);
		return wrapped;
	}

	/** Test-only seam: current wrap-cache entry count (memory-bound assertions). */
	get wrappedLineCacheSize(): number {
		return this.#wrappedLineCache.length;
	}

	#makeLayoutCacheKey(contentWidth: number): LayoutCacheKey {
		return {
			docVersion: this.#docVersion,
			contentWidth,
			optionsKey: JSON.stringify({
				borderVisible: this.#borderVisible,
				borderStyle: this.#borderStyle,
				closedBorderBox: this.#closedBorderBox,
				inputPrefix: this.#inputPrefix,
				inputPrefixWidth: this.#inputPrefixWidth,
				placeholder: this.#placeholder,
				promptGutter: this.#promptGutter,
				useTerminalCursor: this.#useTerminalCursor,
				cursorOverride: this.cursorOverride,
				cursorOverrideWidth: this.cursorOverrideWidth,
				autocompleteState: this.#autocompleteState,
				autocompletePrefix: this.#autocompletePrefix,
				autocompleteHint: this.#autocompleteList?.getSelectedItem()?.hint,
			}),
		};
	}

	#layoutLine(text: string, logicalLine: number, hasCursor: boolean, cursorPos?: number): LayoutLine {
		__editorPerfCounters.visibleWidthMeasurements += 1;
		return {
			text,
			visibleWidth: visibleWidth(text),
			logicalLine,
			hasCursor,
			cursorPos,
		};
	}

	#layoutLogicalLine(lineIndex: number, contentWidth: number): LayoutLine[] {
		__editorPerfCounters.layoutLogicalLinesProcessed += 1;
		const line = this.#state.lines[lineIndex] || "";
		const isCurrentLine = lineIndex === this.#state.cursorLine;
		const wrappedLine = this.#getWrappedLine(lineIndex, contentWidth);
		const layoutLines: LayoutLine[] = [];

		if (wrappedLine.width <= contentWidth) {
			layoutLines.push(
				this.#layoutLine(line, lineIndex, isCurrentLine, isCurrentLine ? this.#state.cursorCol : undefined),
			);
			return layoutLines;
		}

		const chunks = wrappedLine.chunks;
		for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
			const chunk = chunks[chunkIndex];
			if (!chunk) continue;

			const cursorPos = this.#state.cursorCol;
			const isLastChunk = chunkIndex === chunks.length - 1;
			let hasCursorInChunk = false;
			let adjustedCursorPos = 0;

			if (isCurrentLine) {
				if (isLastChunk) {
					hasCursorInChunk = cursorPos >= chunk.startIndex;
					adjustedCursorPos = cursorPos - chunk.startIndex;
				} else {
					hasCursorInChunk = cursorPos >= chunk.startIndex && cursorPos < chunk.endIndex;
					if (hasCursorInChunk) {
						adjustedCursorPos = cursorPos - chunk.startIndex;
						if (adjustedCursorPos > chunk.text.length) {
							adjustedCursorPos = chunk.text.length;
						}
					}
				}
			}

			if (hasCursorInChunk) {
				let displayChunkText = chunk.text;
				let displayCursorPos = adjustedCursorPos;
				if (displayCursorPos > displayChunkText.length) {
					let hiddenWhitespaceWidth = displayCursorPos - displayChunkText.length;
					const displayChunkWidth = visibleWidth(displayChunkText);
					__editorPerfCounters.visibleWidthMeasurements += 1;
					if (displayChunkWidth + hiddenWhitespaceWidth <= contentWidth) {
						displayChunkText += padding(hiddenWhitespaceWidth);
					} else {
						layoutLines.push(this.#layoutLine(displayChunkText, lineIndex, false));
						hiddenWhitespaceWidth -= Math.max(0, contentWidth - displayChunkWidth);
						while (hiddenWhitespaceWidth > contentWidth) {
							layoutLines.push(this.#layoutLine(padding(contentWidth), lineIndex, false));
							hiddenWhitespaceWidth -= contentWidth;
						}
						displayChunkText = padding(hiddenWhitespaceWidth);
						displayCursorPos = hiddenWhitespaceWidth;
					}
				}
				layoutLines.push(this.#layoutLine(displayChunkText, lineIndex, true, displayCursorPos));
			} else {
				layoutLines.push(this.#layoutLine(chunk.text, lineIndex, false));
			}
		}

		return layoutLines;
	}

	#sameLayoutCacheKey(a: LayoutCacheKey, b: LayoutCacheKey): boolean {
		return a.docVersion === b.docVersion && a.contentWidth === b.contentWidth && a.optionsKey === b.optionsKey;
	}

	#replaceCachedLogicalLine(cache: LayoutCache, lineIndex: number, contentWidth: number): void {
		const start = cache.lineStarts[lineIndex] ?? cache.lines.length;
		const oldCount = cache.lineCounts[lineIndex] ?? 0;
		const replacement = this.#layoutLogicalLine(lineIndex, contentWidth);
		const removed = cache.lines.splice(start, oldCount, ...replacement);
		this.#layoutCacheBytes +=
			replacement.reduce((bytes, line) => bytes + 40 + Buffer.byteLength(line.text, "utf8"), 0) -
			removed.reduce((bytes, line) => bytes + 40 + Buffer.byteLength(line.text, "utf8"), 0);
		cache.lineCounts[lineIndex] = replacement.length;
		const delta = replacement.length - oldCount;
		if (delta !== 0) {
			for (let i = lineIndex + 1; i < cache.lineStarts.length; i++) {
				cache.lineStarts[i] = (cache.lineStarts[i] ?? 0) + delta;
			}
		}
	}

	#patchCursorInCachedLayout(cache: LayoutCache, contentWidth: number): LayoutLine[] {
		const previousLine = cache.cursorLine;
		const currentLine = this.#state.cursorLine;
		this.#replaceCachedLogicalLine(cache, previousLine, contentWidth);
		if (currentLine !== previousLine) {
			this.#replaceCachedLogicalLine(cache, currentLine, contentWidth);
		}
		cache.cursorLine = currentLine;
		cache.cursorCol = this.#state.cursorCol;
		return cache.lines;
	}

	#layoutText(contentWidth: number): LayoutLine[] {
		__editorPerfCounters.layoutTextInvocations += 1;
		const key = this.#makeLayoutCacheKey(contentWidth);
		const cached = this.#layoutCache;
		if (cached && this.#sameLayoutCacheKey(cached.key, key)) {
			if (cached.cursorLine === this.#state.cursorLine && cached.cursorCol === this.#state.cursorCol) {
				return cached.lines;
			}
			return this.#patchCursorInCachedLayout(cached, contentWidth);
		}

		const layoutLines: LayoutLine[] = [];
		const lineStarts: number[] = [];
		const lineCounts: number[] = [];

		if (this.#state.lines.length === 0 || (this.#state.lines.length === 1 && this.#state.lines[0] === "")) {
			this.#clearWrappedLineCache();
			lineStarts[0] = 0;
			lineCounts[0] = 1;
			layoutLines.push(this.#layoutLine("", 0, true, 0));
		} else {
			for (let i = 0; i < this.#state.lines.length; i++) {
				lineStarts[i] = layoutLines.length;
				const logicalLayout = this.#layoutLogicalLine(i, contentWidth);
				lineCounts[i] = logicalLayout.length;
				layoutLines.push(...logicalLayout);
			}
		}
		while (this.#wrappedLineCache.length > this.#state.lines.length) {
			const removed = this.#wrappedLineCache.pop();
			if (removed) this.#wrappedLineCacheBytes -= this.#wrappedLineBytes(removed);
		}
		this.#layoutCache = {
			key,
			cursorLine: this.#state.cursorLine,
			cursorCol: this.#state.cursorCol,
			lines: layoutLines,
			lineStarts,
			lineCounts,
		};
		this.#layoutCacheBytes =
			96 +
			lineStarts.length * 8 +
			lineCounts.length * 8 +
			layoutLines.reduce((bytes, line) => bytes + 40 + Buffer.byteLength(line.text, "utf8"), 0);
		return layoutLines;
	}

	getText(): string {
		return this.#state.lines.join("\n");
	}

	#expandPasteMarkers(text: string): string {
		let result = text;
		for (const [pasteId, pasteContent] of this.#pastes) {
			const markerRegex = new RegExp(`\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g");
			result = result.replace(markerRegex, () => pasteContent);
		}
		return result;
	}

	/**
	 * Get text with paste markers expanded to their actual content.
	 * Use this when you need the full content (e.g., for external editor).
	 */
	getExpandedText(): string {
		return this.#expandPasteMarkers(this.#state.lines.join("\n"));
	}

	getLines(): string[] {
		return [...this.#state.lines];
	}

	getCursor(): { line: number; col: number } {
		return { line: this.#state.cursorLine, col: this.#state.cursorCol };
	}

	moveToLineStart(): void {
		this.#moveToLineStart();
	}

	moveToLineEnd(): void {
		this.#moveToLineEnd();
	}

	moveToMessageStart(): void {
		this.#moveToMessageStart();
	}

	moveToMessageEnd(): void {
		this.#moveToMessageEnd();
	}

	/**
	 * Undo the last meaningful edit while ignoring transient text that is still present at the cursor.
	 * Used for command-like autocomplete actions whose typed trigger should not count as the edit being undone.
	 */
	undoPastTransientText(transientText: string): void {
		if (transientText.length === 0) {
			this.#applyUndo();
			return;
		}

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const transientStartCol = this.#state.cursorCol - transientText.length;
		if (transientStartCol < 0 || currentLine.slice(transientStartCol, this.#state.cursorCol) !== transientText) {
			this.#applyUndo();
			return;
		}

		this.#historyIndex = -1;
		this.#resetKillSequence();
		this.#preferredVisualCol = null;
		const documentText = this.getText();
		const transientStart = documentText.length - (currentLine.length - transientStartCol);
		this.#withUndoSuspended(() =>
			this.#applyRangeEdit(
				transientStart,
				transientStart + transientText.length,
				"",
				{ line: this.#state.cursorLine, col: transientStartCol },
				"replace",
			),
		);

		const record = this.#undoStack.at(-1);
		if (
			record &&
			record.deletedText.length === 0 &&
			record.start + record.insertedText.length === transientStart + transientText.length &&
			record.insertedText.endsWith(transientText)
		) {
			this.#undoRetainedBytes -= record.bytes;
			record.insertedText = record.insertedText.slice(0, -transientText.length);
			record.bytes = 64 + Buffer.byteLength(record.insertedText, "utf8");
			this.#undoRetainedBytes += record.bytes;
			if (record.insertedText.length === 0) {
				this.#undoStack.pop();
				this.#undoRetainedBytes -= record.bytes;
			}
		}
		if (this.#undoStack.length === 0) {
			if (this.onChange) this.onChange(this.getText());
			return;
		}
		this.#applyUndo();
	}

	setText(text: string): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#resetKillSequence();
		this.#setTextInternal(text);
	}

	#exitHistoryForEditing(): void {
		if (this.#historyIndex === -1) return;
		if (this.#state.cursorLine === 0 && this.#state.cursorCol === 0) {
			this.#state.cursorLine = this.#state.lines.length - 1;
			const line = this.#state.lines[this.#state.cursorLine] || "";
			this.#setCursorCol(line.length);
		}
		this.#historyIndex = -1;
	}

	/** Insert text at the current cursor position */
	insertText(text: string): void {
		this.#exitHistoryForEditing();
		this.#insertTextAtCursor(text);
	}

	// All the editor methods from before...
	#insertCharacter(char: string): void {
		this.#exitHistoryForEditing();
		this.#resetKillSequence();
		const beforeInsertCursor = { line: this.#state.cursorLine, col: this.#state.cursorCol };
		const line = this.#state.lines[this.#state.cursorLine] || "";
		const inserted = insertTextNfcAt(line, this.#state.cursorCol, char);

		let prefix = 0;
		while (prefix < line.length && prefix < inserted.line.length && line[prefix] === inserted.line[prefix]) prefix++;
		let suffix = 0;
		while (
			suffix < line.length - prefix &&
			suffix < inserted.line.length - prefix &&
			line[line.length - suffix - 1] === inserted.line[inserted.line.length - suffix - 1]
		)
			suffix++;
		const start = this.#documentOffset(this.#state.cursorLine, prefix);
		const end = this.#documentOffset(this.#state.cursorLine, line.length - suffix);
		const insertedText = inserted.line.slice(prefix, inserted.line.length - suffix);
		this.#applyRangeEdit(
			start,
			end,
			insertedText,
			{ line: this.#state.cursorLine, col: inserted.cursorCol },
			"insert",
		);

		if (this.onChange) this.onChange(this.getText());

		// Synchronous inline replacement (e.g. emoji shortcodes `:joy:` → 😂).
		// Runs before autocomplete trigger so the popup doesn't briefly chase a
		// prefix that's about to be rewritten.
		if (char.length === 1 && this.#autocompleteProvider?.trySyncInlineReplace) {
			const replaceLine = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = replaceLine.slice(0, this.#state.cursorCol);
			const replacement = this.#autocompleteProvider.trySyncInlineReplace(textBeforeCursor);
			if (replacement) {
				const start = this.#documentOffset(this.#state.cursorLine, this.#state.cursorCol - replacement.replaceLen);
				const end = this.#documentOffset(this.#state.cursorLine, this.#state.cursorCol);
				this.#applyRangeEdit(
					start,
					end,
					replacement.insert,
					{
						line: this.#state.cursorLine,
						col: this.#state.cursorCol - replacement.replaceLen + replacement.insert.length,
					},
					"replace",
				);
				const replacementRecord = this.#undoStack.at(-1);
				const inputRecord = this.#undoStack.at(-2);
				if (
					replacementRecord &&
					inputRecord &&
					inputRecord.kind === "insert" &&
					inputRecord.deletedText.length === 0 &&
					inputRecord.insertedText.endsWith(insertedText) &&
					inputRecord.start + inputRecord.insertedText.length === end &&
					replacementRecord.deletedText.endsWith(insertedText)
				) {
					const retainedInsert = inputRecord.insertedText.slice(0, -insertedText.length);
					this.#undoRetainedBytes -= inputRecord.bytes + replacementRecord.bytes;
					if (retainedInsert) {
						inputRecord.insertedText = retainedInsert;
						inputRecord.afterCursor = beforeInsertCursor;
						inputRecord.bytes = 64 + Buffer.byteLength(retainedInsert, "utf8");
					} else {
						this.#undoStack.splice(-2, 1);
					}
					replacementRecord.deletedText = replacementRecord.deletedText.slice(0, -insertedText.length);
					replacementRecord.beforeCursor = beforeInsertCursor;
					replacementRecord.bytes =
						64 +
						Buffer.byteLength(replacementRecord.deletedText, "utf8") +
						Buffer.byteLength(replacementRecord.insertedText, "utf8");
					this.#undoRetainedBytes += replacementRecord.bytes + (retainedInsert ? inputRecord.bytes : 0);
				}
				if (this.onChange) this.onChange(this.getText());
				if (this.#autocompleteState) {
					this.#cancelAutocomplete();
					this.onAutocompleteUpdate?.();
				}
				return;
			}
		}

		// Check if we should trigger or update autocomplete
		if (!this.#autocompleteState) {
			// Auto-trigger for slash command tokens.
			if (char === "/" && (this.#isAtStartOfSubmittedMessage() || this.#isInSlashTokenContext())) {
				this.#tryTriggerAutocomplete();
			}
			// Auto-trigger for "@" file reference (fuzzy search)
			else if (char === "@") {
				const currentLine = this.#state.lines[this.#state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
				// Only trigger if @ is after whitespace or at start of line
				const charBeforeAt = textBeforeCursor[textBeforeCursor.length - 2];
				if (textBeforeCursor.length === 1 || charBeforeAt === " " || charBeforeAt === "\t") {
					this.#tryTriggerAutocomplete();
				}
			}
			// Auto-trigger for "#" prompt actions anywhere in the current token
			else if (char === "#") {
				this.#tryTriggerAutocomplete();
			}
			// Also auto-trigger when typing letters/path chars in a completable context
			else if (/[a-zA-Z0-9.\-_/]/.test(char)) {
				const currentLine = this.#state.lines[this.#state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
				// Check if we're in a slash command or inline slash token
				if (this.#isInSubmittedSlashCommandContext() || this.#isInSlashTokenContext()) {
					this.#tryTriggerAutocomplete();
				}
				// Check if we're in an @ file reference context
				else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
					this.#tryTriggerAutocomplete();
				}
				// Check if we're in a # prompt action context
				else if (textBeforeCursor.match(/#[^\s#]*$/)) {
					this.#tryTriggerAutocomplete();
				}
				// Check if we're in a :emoji shortcode context
				else if (textBeforeCursor.match(/(?:^|[\s([{>]):[a-zA-Z0-9_+-]*$/)) {
					this.#tryTriggerAutocomplete();
				}
			}
		} else {
			this.#debouncedUpdateAutocomplete();
		}
	}

	#handlePaste(pastedText: string): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#resetKillSequence();
		const hadAutocomplete = this.#autocompleteState !== null;
		this.#cancelAutocomplete();
		if (hadAutocomplete) {
			this.onAutocompleteUpdate?.();
		}

		// Some terminals (e.g. tmux popups with extended-keys-format=csi-u) re-encode
		// control bytes inside bracketed paste as CSI-u Ctrl+<letter> sequences
		// (ESC [ <codepoint> ; 5 u). Decode those back to their literal byte so the
		// per-char filter below preserves newlines instead of stripping ESC and
		// leaking the printable tail (e.g. "[106;5u") into the editor.
		const decodedText = pastedText.replace(/\x1b\[(\d+);5u/g, (match, code) => {
			const cp = Number(code);
			if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
			if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
			return match;
		});

		// Clean the pasted text. NFC-normalize so macOS Finder drag-drops of
		// Korean filenames (which arrive as NFD: e.g. `ᄒ`+`ᅪ` instead of `화`)
		// land in the buffer as the same precomposed syllables a terminal
		// renders — without this, cursor column accounting drifts by
		// `(NFD cells − NFC cells)` and the visible glyph desyncs from the
		// hardware cursor. Matches the `Input` component's prior fix; this
		// is the same fix on the real GJC prompt component (`Editor`).
		const cleanText = decodedText.replace(/\r\n?/g, "\n").normalize("NFC");

		// Convert tabs to spaces (4 spaces per tab)
		const tabExpandedText = cleanText.replace(/\t/g, "    ");

		// Filter out non-printable characters except newlines
		const filteredText = tabExpandedText
			.split("")
			.filter(char => char === "\n" || char.charCodeAt(0) >= 32)
			.join("");

		// Nothing survived filtering: the buffer is untouched, so don't record
		// an undo snapshot — a no-op entry would make the next undo appear dead.
		if (filteredText.length === 0) return;

		const pastedLines = filteredText.split("\n");
		const totalChars = filteredText.length;
		if (pastedLines.length > 10 || totalChars > 1000) {
			this.#pasteCounter++;
			const pasteId = this.#pasteCounter;
			this.#pastes.set(pasteId, filteredText);
			const marker =
				pastedLines.length > 10
					? `[paste #${pasteId} +${pastedLines.length} lines]`
					: `[paste #${pasteId} ${totalChars} chars]`;
			this.#insertTextAtCursor(marker, "paste");
			return;
		}
		this.#insertTextAtCursor(filteredText, "paste");
	}

	#addNewLine(): void {
		this.#historyIndex = -1;
		this.#resetKillSequence();
		const start = this.#documentOffset(this.#state.cursorLine, this.#state.cursorCol);
		this.#applyRangeEdit(start, start, "\n", { line: this.#state.cursorLine + 1, col: 0 }, "replace");
		if (this.onChange) this.onChange(this.getText());
	}

	#shouldSubmitOnBackslashEnter(data: string, kb: KeybindingsManager): boolean {
		if (this.disableSubmit) return false;
		if (!matchesKey(data, "enter")) return false;
		const submitKeys = kb.getKeys("tui.input.submit");
		const hasShiftEnter = submitKeys.includes("shift+enter") || submitKeys.includes("shift+return");
		if (!hasShiftEnter) return false;

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		return this.#state.cursorCol > 0 && currentLine[this.#state.cursorCol - 1] === "\\";
	}

	#submitValue(): void {
		this.#resetKillSequence();

		const result = this.#expandPasteMarkers(this.#state.lines.join("\n")).trim();

		this.#state = { lines: [""], cursorLine: 0, cursorCol: 0 };
		this.#bumpDocumentVersion();
		this.#pastes.clear();
		this.#pasteCounter = 0;
		this.#historyIndex = -1;
		this.#scrollOffset = 0;
		this.#clearUndo();
		this.#documentRetainedBytes = 0;
		this.#clearWrappedLineCache();

		if (this.onChange) this.onChange("");
		if (this.onSubmit) this.onSubmit(result);
	}

	#handleBackspace(): void {
		this.#historyIndex = -1;
		this.#resetKillSequence();
		if (this.#state.cursorCol > 0) {
			const line = this.#state.lines[this.#state.cursorLine] || "";
			const graphemes = [...segmenter.segment(line.slice(0, this.#state.cursorCol))];
			const length = graphemes.at(-1)?.segment.length || 1;
			const end = this.#documentOffset(this.#state.cursorLine, this.#state.cursorCol);
			this.#applyRangeEdit(
				end - length,
				end,
				"",
				{ line: this.#state.cursorLine, col: this.#state.cursorCol - length },
				"backspace",
			);
		} else if (this.#state.cursorLine > 0) {
			const previousLine = this.#state.lines[this.#state.cursorLine - 1] || "";
			const start = this.#documentOffset(this.#state.cursorLine - 1, previousLine.length);
			this.#applyRangeEdit(
				start,
				start + 1,
				"",
				{ line: this.#state.cursorLine - 1, col: previousLine.length },
				"backspace",
			);
		}
		if (this.onChange) this.onChange(this.getText());

		// Update or re-trigger autocomplete after backspace
		if (this.#autocompleteState) {
			this.#debouncedUpdateAutocomplete();
		} else {
			// If autocomplete was cancelled (no matches), re-trigger if we're in a completable context
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
			// Slash command or inline slash token context
			if (this.#isInSubmittedSlashCommandContext() || this.#isInSlashTokenContext()) {
				this.#tryTriggerAutocomplete();
			}
			// @ file reference context
			else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
				this.#tryTriggerAutocomplete();
			}
			// # prompt action context
			else if (textBeforeCursor.match(/#[^\s#]*$/)) {
				this.#tryTriggerAutocomplete();
			}
		}
	}

	/**
	 * Set cursor column and clear preferredVisualCol.
	 * Use this for all non-vertical cursor movements to reset sticky column behavior.
	 */
	#setCursorCol(col: number): void {
		this.#state.cursorCol = col;
		this.#preferredVisualCol = null;
	}

	/**
	 * Move cursor to a target visual line, applying sticky column logic.
	 * Shared by moveCursor() and pageScroll().
	 */
	#moveToVisualLine(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
		currentVisualLine: number,
		targetVisualLine: number,
	): void {
		const currentVL = visualLines[currentVisualLine];
		const targetVL = visualLines[targetVisualLine];

		if (currentVL && targetVL) {
			const currentVisualCol = this.#state.cursorCol - currentVL.startCol;

			// For non-last segments, clamp to length-1 to stay within the segment
			const isLastSourceSegment =
				currentVisualLine === visualLines.length - 1 ||
				visualLines[currentVisualLine + 1]?.logicalLine !== currentVL.logicalLine;
			const sourceMaxVisualCol = isLastSourceSegment ? currentVL.length : Math.max(0, currentVL.length - 1);

			const isLastTargetSegment =
				targetVisualLine === visualLines.length - 1 ||
				visualLines[targetVisualLine + 1]?.logicalLine !== targetVL.logicalLine;
			const targetMaxVisualCol = isLastTargetSegment ? targetVL.length : Math.max(0, targetVL.length - 1);

			const moveToVisualCol = this.#computeVerticalMoveColumn(
				currentVisualCol,
				sourceMaxVisualCol,
				targetMaxVisualCol,
			);

			// Set cursor position
			this.#state.cursorLine = targetVL.logicalLine;
			const targetCol = targetVL.startCol + moveToVisualCol;
			const logicalLine = this.#state.lines[targetVL.logicalLine] || "";
			this.#state.cursorCol = Math.min(targetCol, logicalLine.length);
		}
	}

	/**
	 * Compute the target visual column for vertical cursor movement.
	 * Implements the sticky column decision table.
	 */
	#computeVerticalMoveColumn(
		currentVisualCol: number,
		sourceMaxVisualCol: number,
		targetMaxVisualCol: number,
	): number {
		const hasPreferred = this.#preferredVisualCol !== null;
		const cursorInMiddle = currentVisualCol < sourceMaxVisualCol;
		const targetTooShort = targetMaxVisualCol < currentVisualCol;

		if (!hasPreferred || cursorInMiddle) {
			if (targetTooShort) {
				this.#preferredVisualCol = currentVisualCol;
				return targetMaxVisualCol;
			}
			this.#preferredVisualCol = null;
			return currentVisualCol;
		}

		const targetCantFitPreferred = targetMaxVisualCol < this.#preferredVisualCol!;
		if (targetTooShort || targetCantFitPreferred) {
			return targetMaxVisualCol;
		}

		const result = this.#preferredVisualCol!;
		this.#preferredVisualCol = null;
		return result;
	}

	#moveToLineStart(): void {
		this.#breakUndoCoalescing();
		this.#resetKillSequence();
		this.#setCursorCol(0);
	}

	#moveToLineEnd(): void {
		this.#breakUndoCoalescing();
		this.#resetKillSequence();
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		this.#setCursorCol(currentLine.length);
	}

	#moveToMessageStart(): void {
		this.#breakUndoCoalescing();
		this.#resetKillSequence();
		this.#state.cursorLine = 0;
		this.#setCursorCol(0);
	}

	#moveToMessageEnd(): void {
		this.#breakUndoCoalescing();
		this.#resetKillSequence();
		this.#state.cursorLine = this.#state.lines.length - 1;
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		this.#setCursorCol(currentLine.length);
	}

	#breakUndoCoalescing(): void {
		this.#undoSequence += 1;
	}

	#resetKillSequence(): void {
		this.#lastAction = null;
	}

	#withUndoSuspended<T>(fn: () => T): T {
		const wasSuspended = this.#suspendUndo;
		this.#suspendUndo = true;
		try {
			return fn();
		} finally {
			this.#suspendUndo = wasSuspended;
		}
	}

	#documentOffset(line: number, col: number): number {
		let offset = 0;
		for (let index = 0; index < line; index++) offset += (this.#state.lines[index] || "").length + 1;
		return offset + col;
	}

	#positionAtOffset(offset: number): CursorPosition {
		let remaining = offset;
		for (let line = 0; line < this.#state.lines.length; line++) {
			const text = this.#state.lines[line] || "";
			if (remaining <= text.length) return { line, col: remaining };
			remaining -= text.length + 1;
		}
		const line = this.#state.lines.length - 1;
		return { line, col: (this.#state.lines[line] || "").length };
	}

	#textInRange(start: number, end: number): string {
		const from = this.#positionAtOffset(start);
		const to = this.#positionAtOffset(end);
		if (from.line === to.line) return (this.#state.lines[from.line] || "").slice(from.col, to.col);
		const parts = [(this.#state.lines[from.line] || "").slice(from.col)];
		for (let line = from.line + 1; line < to.line; line++) parts.push(this.#state.lines[line] || "");
		parts.push((this.#state.lines[to.line] || "").slice(0, to.col));
		return parts.join("\n");
	}

	/** Sole document mutation primitive: applies and records one reversible range edit. */
	#applyRangeEdit(start: number, end: number, newText: string, afterCursor: CursorPosition, kind: UndoKind): void {
		const beforeCursor = { line: this.#state.cursorLine, col: this.#state.cursorCol };
		const deletedText = this.#textInRange(start, end);
		if (deletedText === newText) return;
		const from = this.#positionAtOffset(start);
		const to = this.#positionAtOffset(end);
		const before = (this.#state.lines[from.line] || "").slice(0, from.col);
		const after = (this.#state.lines[to.line] || "").slice(to.col);
		const replacements = newText.split("\n");
		const lines =
			replacements.length === 1
				? [before + replacements[0] + after]
				: [before + replacements[0], ...replacements.slice(1, -1), replacements.at(-1)! + after];
		this.#state.lines.splice(from.line, to.line - from.line + 1, ...lines);
		this.#state.cursorLine = afterCursor.line;
		this.#setCursorCol(afterCursor.col);
		this.#documentRetainedBytes += Buffer.byteLength(newText, "utf8") - Buffer.byteLength(deletedText, "utf8");
		const record: EditRecord = {
			sequence: this.#undoSequence,
			start,
			deletedText,
			insertedText: newText,
			beforeCursor,
			afterCursor,
			kind,
			bytes: 64 + Buffer.byteLength(deletedText, "utf8") + Buffer.byteLength(newText, "utf8"),
		};
		if (!this.#suspendUndo) {
			if (!this.#coalesceUndo(record)) {
				this.#undoStack.push(record);
				this.#undoRetainedBytes += record.bytes;
			}
			this.#evictUndo();
		}
		this.#bumpDocumentVersion();
	}

	#coalesceUndo(record: EditRecord): boolean {
		const previous = this.#undoStack.at(-1);
		if (!previous || previous.kind !== record.kind || previous.sequence !== record.sequence) return false;
		if (
			record.kind === "insert" || record.kind === "paste"
				? previous.deletedText.length === 0 &&
					record.deletedText.length === 0 &&
					previous.start + previous.insertedText.length === record.start
				: record.kind === "backspace"
					? previous.insertedText.length === 0 &&
						record.insertedText.length === 0 &&
						record.start + record.deletedText.length === previous.start
					: record.kind === "delete" &&
						previous.insertedText.length === 0 &&
						record.insertedText.length === 0 &&
						previous.start === record.start
		) {
			this.#undoRetainedBytes -= previous.bytes;
			if (record.kind === "backspace") {
				previous.start = record.start;
				previous.deletedText = record.deletedText + previous.deletedText;
			} else if (record.kind === "insert" || record.kind === "paste") {
				previous.insertedText += record.insertedText;
			} else {
				previous.deletedText += record.deletedText;
			}
			previous.afterCursor = record.afterCursor;
			previous.bytes =
				64 + Buffer.byteLength(previous.deletedText, "utf8") + Buffer.byteLength(previous.insertedText, "utf8");
			this.#undoRetainedBytes += previous.bytes;
			this.#undoCoalesceCount++;
			return true;
		}
		return false;
	}

	#evictUndo(): void {
		const budget = this.#documentRetainedBytes * 2 + 16 * 1024 * 1024;
		while (this.#undoStack.length > 1 && this.#undoRetainedBytes > budget) {
			const oldest = this.#undoStack.shift();
			if (oldest) this.#undoRetainedBytes -= oldest.bytes;
		}
	}

	#clearUndo(): void {
		this.#undoStack.length = 0;
		this.#undoRetainedBytes = 0;
	}

	getRetainedMemoryCounters(): EditorRetainedMemoryCounters {
		return {
			documentBytes: this.#documentRetainedBytes,
			undoBytes: this.#undoRetainedBytes,
			recordCount: this.#undoStack.length,
			coalesceCount: this.#undoCoalesceCount,
			editorCacheBuckets: { wrappedLineBytes: this.#wrappedLineCacheBytes, layoutBytes: this.#layoutCacheBytes },
		};
	}

	/** Test-only slow audit for the incrementally maintained editor cache buckets. */
	getRetainedMemoryCounterAudit(): EditorRetainedMemoryCounters["editorCacheBuckets"] {
		const wrappedLineBytes = this.#wrappedLineCache.reduce(
			(bytes, entry) => bytes + (entry ? this.#wrappedLineBytes(entry) : 0),
			0,
		);
		const layout = this.#layoutCache;
		const layoutBytes = layout
			? 96 +
				layout.lineStarts.length * 8 +
				layout.lineCounts.length * 8 +
				layout.lines.reduce((bytes, line) => bytes + 40 + Buffer.byteLength(line.text, "utf8"), 0)
			: 0;
		return { wrappedLineBytes, layoutBytes };
	}

	/** Slice 4 registry hook; sampling reads only incremental counters. */
	registerRetainedMemory(registry: RetainedMemoryRegistryFacade, id = "tui.editor"): RetainedMemoryRegistration {
		return registry.registerPool({
			id,
			bucketNames: ["document", "undo", "wrapped-line", "layout"],
			sampleBytes: () => {
				const counters = this.getRetainedMemoryCounters();
				return (
					counters.documentBytes +
					counters.undoBytes +
					counters.editorCacheBuckets.wrappedLineBytes +
					counters.editorCacheBuckets.layoutBytes
				);
			},
			sampleBuckets: () => {
				const counters = this.getRetainedMemoryCounters();
				return {
					document: counters.documentBytes,
					undo: counters.undoBytes,
					"wrapped-line": counters.editorCacheBuckets.wrappedLineBytes,
					layout: counters.editorCacheBuckets.layoutBytes,
				};
			},
			onEvict: () => this.invalidate(),
		});
	}

	#applyUndo(): void {
		const record = this.#undoStack.at(-1);
		if (!record) return;
		const end = record.start + record.insertedText.length;
		// Validate before changing the stack so a stale record never disappears.
		if (this.#textInRange(record.start, end) !== record.insertedText) return;
		this.#undoStack.pop();
		this.#undoRetainedBytes -= record.bytes;
		this.#withUndoSuspended(() =>
			this.#applyRangeEdit(record.start, end, record.deletedText, record.beforeCursor, "replace"),
		);
		this.#historyIndex = -1;
		this.#resetKillSequence();
		this.#preferredVisualCol = null;
		if (this.onChange) this.onChange(this.getText());
	}

	#recordKill(text: string, direction: "forward" | "backward", accumulate = this.#lastAction === "kill"): void {
		if (!text) return;
		this.#killRing.push(text, { prepend: direction === "backward", accumulate });
		this.#lastAction = "kill";
	}

	#insertTextAtCursor(text: string, kind: UndoKind = "replace"): void {
		this.#historyIndex = -1;
		this.#resetKillSequence();
		const normalized = text.replace(/\r\n?/g, "\n").normalize("NFC");
		const line = this.#state.lines[this.#state.cursorLine] || "";
		const inserted = normalized.includes("\n")
			? normalized
			: insertTextNfcAt(line, this.#state.cursorCol, normalized).line.slice(this.#state.cursorCol);
		const start = this.#documentOffset(this.#state.cursorLine, this.#state.cursorCol);
		const cursorLine = this.#state.cursorLine + normalized.split("\n").length - 1;
		const cursorCol = normalized.includes("\n")
			? (normalized.split("\n").at(-1) || "").length
			: this.#state.cursorCol + inserted.length;
		this.#applyRangeEdit(start, start, inserted, { line: cursorLine, col: cursorCol }, kind);
		if (this.onChange) this.onChange(this.getText());
	}

	#yankFromKillRing(): void {
		const text = this.#killRing.peek();
		if (!text) return;
		this.#insertTextAtCursor(text);
		this.#lastAction = "yank";
	}

	#yankPop(): void {
		if (this.#lastAction !== "yank" || this.#killRing.length <= 1) return;

		this.#historyIndex = -1;
		const yankedText = this.#killRing.peek();
		if (!yankedText) return;
		const end = this.#documentOffset(this.#state.cursorLine, this.#state.cursorCol);
		const start = end - yankedText.length;
		if (start < 0 || this.#textInRange(start, end) !== yankedText) return;

		this.#killRing.rotate();
		const replacement = this.#killRing.peek();
		if (!replacement) return;
		const from = this.#positionAtOffset(start);
		const replacementLines = replacement.split("\n");
		this.#applyRangeEdit(
			start,
			end,
			replacement,
			{
				line: from.line + replacementLines.length - 1,
				col: replacementLines.length === 1 ? from.col + replacement.length : replacementLines.at(-1)?.length || 0,
			},
			"replace",
		);
		this.#lastAction = "yank";
		if (this.onChange) this.onChange(this.getText());
	}

	#deleteToStartOfLine(): void {
		this.#historyIndex = -1; // Exit history browsing mode
		if (process.platform === "darwin") this.#lastLineDeleteAt = Date.now();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		if (this.#state.cursorCol > 0) {
			const end = this.#documentOffset(this.#state.cursorLine, this.#state.cursorCol);
			const deletedText = currentLine.slice(0, this.#state.cursorCol);
			this.#applyRangeEdit(end - deletedText.length, end, "", { line: this.#state.cursorLine, col: 0 }, "replace");
			this.#recordKill(deletedText, "backward");
		} else if (this.#state.cursorLine > 0) {
			const previousLine = this.#state.lines[this.#state.cursorLine - 1] || "";
			const end = this.#documentOffset(this.#state.cursorLine, 0);
			this.#applyRangeEdit(
				end - 1,
				end,
				"",
				{ line: this.#state.cursorLine - 1, col: previousLine.length },
				"replace",
			);
			this.#recordKill("\n", "backward");
		}
		if (this.onChange) this.onChange(this.getText());
	}

	#deleteToEndOfLine(): void {
		this.#historyIndex = -1; // Exit history browsing mode

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const start = this.#documentOffset(this.#state.cursorLine, this.#state.cursorCol);
		if (this.#state.cursorCol < currentLine.length) {
			const deletedText = currentLine.slice(this.#state.cursorCol);
			this.#applyRangeEdit(
				start,
				start + deletedText.length,
				"",
				{ line: this.#state.cursorLine, col: this.#state.cursorCol },
				"replace",
			);
			this.#recordKill(deletedText, "forward");
		} else if (this.#state.cursorLine < this.#state.lines.length - 1) {
			this.#applyRangeEdit(
				start,
				start + 1,
				"",
				{ line: this.#state.cursorLine, col: this.#state.cursorCol },
				"replace",
			);
			this.#recordKill("\n", "forward");
		}
		if (this.onChange) this.onChange(this.getText());
	}

	#deleteWordBackwards(): void {
		this.#historyIndex = -1; // Exit history browsing mode

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		if (this.#state.cursorCol === 0) {
			if (this.#state.cursorLine > 0) {
				const previousLine = this.#state.lines[this.#state.cursorLine - 1] || "";
				const end = this.#documentOffset(this.#state.cursorLine, 0);
				this.#applyRangeEdit(
					end - 1,
					end,
					"",
					{ line: this.#state.cursorLine - 1, col: previousLine.length },
					"replace",
				);
				this.#recordKill("\n", "backward");
			}
		} else {
			const oldCursorCol = this.#state.cursorCol;
			this.#moveWordBackwards();
			const deleteFrom = this.#state.cursorCol;
			this.#setCursorCol(oldCursorCol);
			const deletedText = currentLine.slice(deleteFrom, oldCursorCol);
			const end = this.#documentOffset(this.#state.cursorLine, oldCursorCol);
			this.#applyRangeEdit(
				end - deletedText.length,
				end,
				"",
				{ line: this.#state.cursorLine, col: deleteFrom },
				"replace",
			);
			this.#recordKill(deletedText, "backward");
		}
		if (this.onChange) this.onChange(this.getText());
	}

	#deleteWordForwards(): void {
		this.#historyIndex = -1; // Exit history browsing mode

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const start = this.#documentOffset(this.#state.cursorLine, this.#state.cursorCol);
		if (this.#state.cursorCol >= currentLine.length) {
			if (this.#state.cursorLine < this.#state.lines.length - 1) {
				this.#applyRangeEdit(
					start,
					start + 1,
					"",
					{ line: this.#state.cursorLine, col: this.#state.cursorCol },
					"replace",
				);
				this.#recordKill("\n", "forward");
			}
		} else {
			const oldCursorCol = this.#state.cursorCol;
			this.#moveWordForwards();
			const deleteTo = this.#state.cursorCol;
			this.#setCursorCol(oldCursorCol);
			const deletedText = currentLine.slice(oldCursorCol, deleteTo);
			this.#applyRangeEdit(
				start,
				start + deletedText.length,
				"",
				{ line: this.#state.cursorLine, col: oldCursorCol },
				"replace",
			);
			this.#recordKill(deletedText, "forward");
		}
		if (this.onChange) this.onChange(this.getText());
	}

	#handleForwardDelete(): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#resetKillSequence();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const start = this.#documentOffset(this.#state.cursorLine, this.#state.cursorCol);
		if (this.#state.cursorCol < currentLine.length) {
			const afterCursor = currentLine.slice(this.#state.cursorCol);
			const firstGrapheme = [...segmenter.segment(afterCursor)][0];
			const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;
			this.#applyRangeEdit(
				start,
				start + graphemeLength,
				"",
				{ line: this.#state.cursorLine, col: this.#state.cursorCol },
				"delete",
			);
		} else if (this.#state.cursorLine < this.#state.lines.length - 1) {
			this.#applyRangeEdit(
				start,
				start + 1,
				"",
				{ line: this.#state.cursorLine, col: this.#state.cursorCol },
				"delete",
			);
		}
		if (this.onChange) this.onChange(this.getText());
		// Update or re-trigger autocomplete after forward delete
		if (this.#autocompleteState) {
			this.#debouncedUpdateAutocomplete();
		} else {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
			// Slash command or inline slash token context
			if (this.#isInSubmittedSlashCommandContext() || this.#isInSlashTokenContext()) {
				this.#tryTriggerAutocomplete();
			}
			// @ file reference context
			else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
				this.#tryTriggerAutocomplete();
			}
			// # prompt action context
			else if (textBeforeCursor.match(/#[^\s#]*$/)) {
				this.#tryTriggerAutocomplete();
			}
		}
	}

	/**
	 * Build a mapping from visual lines to logical positions.
	 * Returns an array where each element represents a visual line with:
	 * - logicalLine: index into this.#state.lines
	 * - startCol: starting column in the logical line
	 * - length: length of this visual line segment
	 */
	#buildVisualLineMap(width: number): Array<{ logicalLine: number; startCol: number; length: number }> {
		const visualLines: Array<{ logicalLine: number; startCol: number; length: number }> = [];

		for (let i = 0; i < this.#state.lines.length; i++) {
			const line = this.#state.lines[i] || "";
			const wrappedLine = this.#getWrappedLine(i, width);
			if (line.length === 0) {
				// Empty line still takes one visual line
				visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
			} else if (wrappedLine.width <= width) {
				visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
			} else {
				// Line needs wrapping - use word-aware wrapping
				const chunks = wrappedLine.chunks;
				for (const chunk of chunks) {
					visualLines.push({
						logicalLine: i,
						startCol: chunk.startIndex,
						length: chunk.endIndex - chunk.startIndex,
					});
				}
			}
		}

		return visualLines;
	}

	/**
	 * Find the visual line index for the current cursor position.
	 */
	#findCurrentVisualLine(visualLines: Array<{ logicalLine: number; startCol: number; length: number }>): number {
		for (let i = 0; i < visualLines.length; i++) {
			const vl = visualLines[i];
			if (!vl) continue;
			if (vl.logicalLine === this.#state.cursorLine) {
				const colInSegment = this.#state.cursorCol - vl.startCol;
				// Cursor is in this segment if it's within range
				// For the last segment of a logical line, cursor can be at length (end position)
				const isLastSegmentOfLine =
					i === visualLines.length - 1 || visualLines[i + 1]?.logicalLine !== vl.logicalLine;
				if (colInSegment >= 0 && (colInSegment < vl.length || (isLastSegmentOfLine && colInSegment <= vl.length))) {
					return i;
				}
			}
		}
		// Fallback: return last visual line
		return visualLines.length - 1;
	}

	#moveCursor(deltaLine: number, deltaCol: number): void {
		this.#breakUndoCoalescing();
		this.#resetKillSequence();
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const needsVisualLines = deltaLine !== 0 || (deltaCol > 0 && this.#state.cursorCol >= currentLine.length);
		const visualLines = needsVisualLines ? this.#buildVisualLineMap(this.#lastLayoutWidth) : [];
		const currentVisualLine = needsVisualLines ? this.#findCurrentVisualLine(visualLines) : -1;

		if (deltaLine !== 0) {
			const targetVisualLine = currentVisualLine + deltaLine;

			if (targetVisualLine >= 0 && targetVisualLine < visualLines.length) {
				this.#moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
			}
		}

		if (deltaCol !== 0) {
			if (deltaCol > 0) {
				// Moving right - move by one grapheme (handles emojis, combining characters, etc.)
				if (this.#state.cursorCol < currentLine.length) {
					const charCode = currentLine.charCodeAt(this.#state.cursorCol);
					if (charCode >= 0x20 && charCode <= 0x7e) {
						this.#setCursorCol(this.#state.cursorCol + 1);
					} else {
						const afterCursor = currentLine.slice(this.#state.cursorCol);
						const graphemes = [...segmenter.segment(afterCursor)];
						const firstGrapheme = graphemes[0];
						this.#setCursorCol(this.#state.cursorCol + (firstGrapheme ? firstGrapheme.segment.length : 1));
					}
				} else if (this.#state.cursorLine < this.#state.lines.length - 1) {
					// Wrap to start of next logical line
					this.#state.cursorLine++;
					this.#setCursorCol(0);
				} else {
					// At end of last line - can't move, but set preferredVisualCol for up/down navigation
					const currentVL = visualLines[currentVisualLine];
					if (currentVL) {
						this.#preferredVisualCol = this.#state.cursorCol - currentVL.startCol;
					}
				}
			} else {
				// Moving left - move by one grapheme (handles emojis, combining characters, etc.)
				if (this.#state.cursorCol > 0) {
					const charCode = currentLine.charCodeAt(this.#state.cursorCol - 1);
					if (charCode >= 0x20 && charCode <= 0x7e) {
						this.#setCursorCol(this.#state.cursorCol - 1);
					} else {
						const beforeCursor = currentLine.slice(0, this.#state.cursorCol);
						const graphemes = [...segmenter.segment(beforeCursor)];
						const lastGrapheme = graphemes[graphemes.length - 1];
						this.#setCursorCol(this.#state.cursorCol - (lastGrapheme ? lastGrapheme.segment.length : 1));
					}
				} else if (this.#state.cursorLine > 0) {
					// Wrap to end of previous logical line
					this.#state.cursorLine--;
					const prevLine = this.#state.lines[this.#state.cursorLine] || "";
					this.#setCursorCol(prevLine.length);
				}
			}
		}
	}

	#pageScroll(direction: -1 | 1): void {
		this.#breakUndoCoalescing();
		this.#resetKillSequence();
		const visualLines = this.#buildVisualLineMap(this.#lastLayoutWidth);
		const currentVisualLine = this.#findCurrentVisualLine(visualLines);
		const step = this.#getPageScrollStep(visualLines.length);
		const targetVisualLine = Math.max(0, Math.min(visualLines.length - 1, currentVisualLine + direction * step));
		if (targetVisualLine === currentVisualLine) return;
		this.#moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
	}

	#moveWordBackwards(): void {
		this.#breakUndoCoalescing();
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		// If at start of line, move to end of previous line
		if (this.#state.cursorCol === 0) {
			if (this.#state.cursorLine > 0) {
				this.#state.cursorLine--;
				const prevLine = this.#state.lines[this.#state.cursorLine] || "";
				this.#setCursorCol(prevLine.length);
			}
			return;
		}

		this.#setCursorCol(moveWordLeft(currentLine, this.#state.cursorCol));
	}

	/**
	 * Jump to the first occurrence of a character in the specified direction.
	 * Multi-line search. Case-sensitive. Skips the current cursor position.
	 */
	#jumpToChar(char: string, direction: "forward" | "backward"): void {
		this.#resetKillSequence();
		const isForward = direction === "forward";
		const lines = this.#state.lines;

		const end = isForward ? lines.length : -1;
		const step = isForward ? 1 : -1;

		for (let lineIdx = this.#state.cursorLine; lineIdx !== end; lineIdx += step) {
			const line = lines[lineIdx] || "";
			const isCurrentLine = lineIdx === this.#state.cursorLine;

			// Current line: start after/before cursor; other lines: search full line
			const searchFrom = isCurrentLine
				? isForward
					? this.#state.cursorCol + 1
					: this.#state.cursorCol - 1
				: undefined;

			// Backward from column 0: lastIndexOf clamps a negative position to 0,
			// which would match the character under the cursor instead of skipping it
			if (!isForward && searchFrom !== undefined && searchFrom < 0) {
				continue;
			}

			const idx = isForward ? line.indexOf(char, searchFrom) : line.lastIndexOf(char, searchFrom);

			if (idx !== -1) {
				this.#state.cursorLine = lineIdx;
				this.#setCursorCol(idx);
				return;
			}
		}
		// No match found - cursor stays in place
	}

	#moveWordForwards(): void {
		this.#breakUndoCoalescing();
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		// If at end of line, move to start of next line
		if (this.#state.cursorCol >= currentLine.length) {
			if (this.#state.cursorLine < this.#state.lines.length - 1) {
				this.#state.cursorLine++;
				this.#setCursorCol(0);
			}
			return;
		}

		this.#setCursorCol(moveWordRight(currentLine, this.#state.cursorCol));
	}

	#hasOnlyWhitespaceBeforeCursorLine(): boolean {
		for (let i = 0; i < this.#state.cursorLine; i++) {
			if ((this.#state.lines[i] || "").trim() !== "") {
				return false;
			}
		}
		return true;
	}

	// Slash commands execute only when the submitted prompt starts with the command.
	#isAtStartOfSubmittedMessage(): boolean {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.#state.cursorCol);

		return this.#hasOnlyWhitespaceBeforeCursorLine() && (beforeCursor.trim() === "" || beforeCursor.trim() === "/");
	}

	#isInSubmittedSlashCommandContext(): boolean {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.#state.cursorCol);
		return this.#hasOnlyWhitespaceBeforeCursorLine() && beforeCursor.trimStart().startsWith("/");
	}

	#getSlashTokenBeforeCursor(): string | null {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.#state.cursorCol);
		return extractSlashCommandTokenPrefix(beforeCursor);
	}

	#isInSlashTokenContext(): boolean {
		return this.#getSlashTokenBeforeCursor() !== null;
	}

	#isSlashCommandNameAutocompleteSelection(): boolean {
		if (this.#autocompleteState !== "regular") {
			return false;
		}

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol).trimStart();
		return (
			this.#isInSubmittedSlashCommandContext() && textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ")
		);
	}

	#isCompletedSlashCommandAtCursor(): boolean {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		if (this.#state.cursorCol !== currentLine.length) {
			return false;
		}

		const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol).trimStart();
		return this.#isInSubmittedSlashCommandContext() && /^\/\S+ $/.test(textBeforeCursor);
	}

	// Autocomplete methods
	async #tryTriggerAutocomplete(explicitTab: boolean = false): Promise<void> {
		const declineExplicitTab = (): void => {
			if (explicitTab) this.onTabDeclined?.(this.getText());
		};
		if (!this.#autocompleteProvider) return;
		// Check if we should trigger file completion on Tab
		if (explicitTab) {
			const provider = this.#autocompleteProvider as CombinedAutocompleteProvider;
			const shouldTrigger =
				!provider.shouldTriggerFileCompletion ||
				provider.shouldTriggerFileCompletion(this.#state.lines, this.#state.cursorLine, this.#state.cursorCol);
			if (!shouldTrigger) {
				declineExplicitTab();
				return;
			}
		}

		const requestId = ++this.#autocompleteRequestId;

		const suggestions = await this.#autocompleteProvider.getSuggestions(
			this.#state.lines,
			this.#state.cursorLine,
			this.#state.cursorCol,
		);
		if (requestId !== this.#autocompleteRequestId) return;

		if (suggestions && Array.isArray(suggestions.items) && suggestions.items.length > 0) {
			this.#autocompletePrefix = suggestions.prefix;
			this.#autocompleteList = this.#createAutocompleteList(suggestions.prefix, suggestions.items);
			this.#autocompleteState = "regular";
			this.onAutocompleteUpdate?.();
		} else {
			this.#cancelAutocomplete();
			this.onAutocompleteUpdate?.();
			declineExplicitTab();
		}
	}
	#createAutocompleteList(
		prefix: string,
		items: Array<{ value: string; label: string; description?: string }>,
	): SelectList {
		// Layout options prepared for future SelectList enhancements (e.g., for slash commands)
		const layout = prefix.startsWith("/") ? SLASH_COMMAND_SELECT_LIST_LAYOUT : undefined;
		// TODO: Pass layout to SelectList when constructor is updated to support it
		void layout; // Use layout variable to avoid lint warnings
		return new SelectList(items, this.#autocompleteMaxVisible, this.#theme.selectList);
	}

	#handleTabCompletion(): void {
		if (!this.#autocompleteProvider) {
			this.onTabDeclined?.(this.getText());
			return;
		}

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.#state.cursorCol);

		// Check if we're in a slash command context
		if (
			(this.#isInSubmittedSlashCommandContext() && !beforeCursor.trimStart().includes(" ")) ||
			this.#isInSlashTokenContext()
		) {
			this.#handleSlashCommandCompletion();
		} else {
			this.#forceFileAutocomplete(true);
		}
	}

	#handleSlashCommandCompletion(): void {
		this.#tryTriggerAutocomplete(true);
	}

	/*
https://github.com/EsotericSoftware/spine-runtimes/actions/runs/19536643416/job/559322883
17 this job fails with https://github.com/EsotericSoftware/spine-runtimes/actions/runs/19
536643416/job/55932288317 havea  look at .gi
    */
	async #forceFileAutocomplete(explicitTab: boolean = false): Promise<void> {
		if (!this.#autocompleteProvider) return;

		// Check if provider supports force file suggestions via runtime check
		const provider = this.#autocompleteProvider as {
			getForceFileSuggestions?: CombinedAutocompleteProvider["getForceFileSuggestions"];
		};
		if (typeof provider.getForceFileSuggestions !== "function") {
			await this.#tryTriggerAutocomplete(true);
			return;
		}

		const requestId = ++this.#autocompleteRequestId;
		const suggestions = await provider.getForceFileSuggestions(
			this.#state.lines,
			this.#state.cursorLine,
			this.#state.cursorCol,
		);
		if (requestId !== this.#autocompleteRequestId) return;

		if (suggestions && Array.isArray(suggestions.items) && suggestions.items.length > 0) {
			// If there's exactly one suggestion and this was an explicit Tab press, apply it immediately
			if (explicitTab && suggestions.items.length === 1) {
				const item = suggestions.items[0]!;
				const result = this.#autocompleteProvider.applyCompletion(
					this.#state.lines,
					this.#state.cursorLine,
					this.#state.cursorCol,
					item,
					suggestions.prefix,
				);

				this.#applyCompletion(result.lines, result.cursorLine, result.cursorCol);

				if (this.onChange) {
					this.onChange(this.getText());
				}
				return;
			}

			this.#autocompletePrefix = suggestions.prefix;
			this.#autocompleteList = this.#createAutocompleteList(suggestions.prefix, suggestions.items);
			this.#autocompleteState = "force";
			this.onAutocompleteUpdate?.();
		} else {
			this.#cancelAutocomplete();
			this.onAutocompleteUpdate?.();
			if (explicitTab) this.onTabDeclined?.(this.getText());
		}
	}

	#cancelAutocomplete(notifyCancel: boolean = false): void {
		const wasAutocompleting = this.#autocompleteState !== null;
		this.#clearAutocompleteTimeout();
		this.#autocompleteRequestId += 1;
		this.#autocompleteState = null;
		this.#autocompleteList = undefined;
		this.#autocompletePrefix = "";
		if (notifyCancel && wasAutocompleting) {
			this.onAutocompleteCancel?.();
		}
	}

	isShowingAutocomplete(): boolean {
		return this.#autocompleteState !== null;
	}

	async #updateAutocomplete(): Promise<void> {
		if (!this.#autocompleteState || !this.#autocompleteProvider) return;

		// In force mode, use forceFileAutocomplete to get suggestions
		if (this.#autocompleteState === "force") {
			this.#forceFileAutocomplete();
			return;
		}

		const requestId = ++this.#autocompleteRequestId;

		const suggestions = await this.#autocompleteProvider.getSuggestions(
			this.#state.lines,
			this.#state.cursorLine,
			this.#state.cursorCol,
		);
		if (requestId !== this.#autocompleteRequestId) return;

		if (suggestions && Array.isArray(suggestions.items) && suggestions.items.length > 0) {
			this.#autocompletePrefix = suggestions.prefix;
			// Always create new SelectList to ensure update
			this.#autocompleteList = this.#createAutocompleteList(suggestions.prefix, suggestions.items);
			this.onAutocompleteUpdate?.();
		} else {
			this.#cancelAutocomplete();
			this.onAutocompleteUpdate?.();
		}
	}

	#debouncedUpdateAutocomplete(): void {
		if (this.#autocompleteTimeout) {
			clearTimeout(this.#autocompleteTimeout);
		}
		this.#autocompleteTimeout = setTimeout(() => {
			this.#updateAutocomplete();
			this.#autocompleteTimeout = undefined;
		}, 100);
	}

	#clearAutocompleteTimeout(): void {
		if (this.#autocompleteTimeout) {
			clearTimeout(this.#autocompleteTimeout);
			this.#autocompleteTimeout = undefined;
		}
	}

	/**
	 * Get inline hint text to show as dim ghost text after the cursor.
	 * Checks selected autocomplete item's hint first, then falls back to provider.
	 */
	#getInlineHint(): string | null {
		// Check selected autocomplete item for a hint
		if (this.#autocompleteState && this.#autocompleteList) {
			const selected = this.#autocompleteList.getSelectedItem();
			return selected?.hint ?? null;
		}

		// Fall back to provider's getInlineHint
		if (this.#autocompleteProvider?.getInlineHint) {
			return this.#autocompleteProvider.getInlineHint(
				this.#state.lines,
				this.#state.cursorLine,
				this.#state.cursorCol,
			);
		}

		return null;
	}
}
