import { afterEach, describe, expect, it } from "bun:test";
import { invalidateTabWidthCache, visibleWidth, visibleWidthsNative } from "@gajae-code/tui/utils";
import { getDefaultTabWidth, setDefaultTabWidth } from "@gajae-code/utils";

const originalTabWidth = getDefaultTabWidth();

function normalizeWidthInput(value: unknown): string {
	return typeof value === "string" ? value : String(value ?? "");
}

function expectNativeParity(values: readonly unknown[]): void {
	const normalized = values.map(normalizeWidthInput);
	expect(visibleWidthsNative(values as readonly string[])).toEqual(normalized.map(visibleWidth));
}

it("treats bidi formatting controls as zero-width in both paths", () => {
	expectNativeParity([
		"\u202Eabc\u202C",
		"\u202Aleft\u202C \u202Bright\u202C \u202Doverride\u202C",
		"\u2066isolate\u2069 \u2067rtl\u2069 \u2068first\u2069",
		"\u061Carabic mark",
		"שלום \u202Eworld\u202C mixed עברית",
	]);
	expect(visibleWidth("\u202Eabc\u202C")).toBe(3);
	expect(visibleWidth("\u2066\u2067\u2068\u2069\u061C")).toBe(0);
});

it("preserves grapheme boundaries around bidi formatting controls", () => {
	const cases = [
		{ text: "ᄒ\u202Eᅡ\u202Cᆫ \u2066글\u2069", width: 5 },
		{ text: "\uD83D\uDC69\u202E\u200D\uD83D\uDCBB", width: 4 },
		{ text: "\uD83D\u202E\uDE00", width: 1 },
		{ text: "\u2764\u202E\uFE0F", width: 1 },
	];

	for (const { text, width } of cases) {
		expect(visibleWidth(text)).toBe(width);
		expectNativeParity([text]);
	}
});

it("preserves visible bidi boundaries around ANSI sequences", () => {
	const cases = [
		{ text: "\x1b[31m\u2764\u202E\uFE0F\x1b[0m", width: 1 },
		{ text: "\x1b[1m\uD83D\uDC69\u202E\u200D\uD83D\uDCBB\x1b[0m", width: 4 },
		{ text: "\x1b[31\u202Emred\x1b[0m", width: 3 },
		{ text: "\x1b]8;;https://example.com/\u202Epath\x07\u2764\u202E\uFE0F\x1b]8;;\x07", width: 1 },
		{ text: "\u202E\x1b[31mred\x1b[0m\u202C", width: 3 },
	];

	for (const { text, width } of cases) {
		expect(visibleWidth(text)).toBe(width);
		expectNativeParity([text]);
	}
});

afterEach(() => {
	setDefaultTabWidth(originalTabWidth);
	invalidateTabWidthCache();
});

describe("visibleWidthsNative parity", () => {
	it("matches scalar visibleWidth across terminal text classes", () => {
		expectNativeParity([
			"",
			"plain ASCII 0123456789",
			"a\tb\tend",
			"\x1b[31mred\x1b[0m and \x1b]8;;https://example.com\x07link\x1b]8;;\x07",
			"Cafe\u0301 and e\u0301",
			"emoji 👩‍💻 🚀 and CJK 漢字かなカナ",
			"Thai AM ำ ไทยคำ and Lao AM ຳ ຄໍາ",
			"Hangul Jamo 한글 and compatibility ㅁㄴㅇ",
		]);
	});

	it("uses the configured tab width in native and scalar paths", () => {
		for (const tabWidth of [2, 5]) {
			setDefaultTabWidth(tabWidth);
			invalidateTabWidthCache();
			expectNativeParity(["\t", "a\tb", "left\tmiddle\tright"]);
		}
	});

	it("handles empty arrays", () => {
		expectNativeParity([]);
	});

	it("matches scalar defensive normalization for non-string values", () => {
		expectNativeParity([null, undefined, 42, false, { toString: () => "漢" }]);
	});
});
