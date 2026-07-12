import { createRequire } from "node:module";
import * as Diff from "diff";
import { normalizeForFuzzy } from "../normalize";

export type DiffLinePart = {
	added?: boolean;
	removed?: boolean;
	value: string;
};

export type DiffLinesFn = (oldStr: string, newStr: string) => DiffLinePart[];

export type NativeBestFuzzyMatchResult = {
	best?: {
		actualText: string;
		startIndex: number;
		startLine: number;
		confidence: number;
	};
	aboveThresholdCount: number;
	secondBestScore: number;
};

export type TypeScriptSequenceMatchOracleResult = {
	index: number | undefined;
	confidence: number;
};

export type NativeSequenceFuzzyResult = {
	index?: number;
	confidence: number;
	matchCount: number;
	matchIndices: number[];
	secondBestScore: number;
};

export type NativeFuzzyBindings = {
	h01FindBestFuzzyMatch?: (content: string, target: string, threshold: number) => NativeBestFuzzyMatchResult;
	h02ScoreSequenceFuzzy?: (
		lines: string[],
		pattern: string[],
		start: number,
		eof: boolean,
	) => NativeSequenceFuzzyResult;
};

const require = createRequire(import.meta.url);
const DIFF_LINES_TEST_OVERRIDE_UNSET = Symbol("DIFF_LINES_TEST_OVERRIDE_UNSET");
const NATIVE_FUZZY_TEST_OVERRIDE_UNSET = Symbol("NATIVE_FUZZY_TEST_OVERRIDE_UNSET");

let cachedNativeDiffLines: DiffLinesFn | null | undefined;
let diffLinesTestOverride: DiffLinesFn | null | typeof DIFF_LINES_TEST_OVERRIDE_UNSET = DIFF_LINES_TEST_OVERRIDE_UNSET;
let nativeFuzzyBindings: NativeFuzzyBindings | undefined;
let nativeFuzzyTestOverride: NativeFuzzyBindings | null | typeof NATIVE_FUZZY_TEST_OVERRIDE_UNSET =
	NATIVE_FUZZY_TEST_OVERRIDE_UNSET;

export function resolveNativeDiffLines(): DiffLinesFn {
	if (diffLinesTestOverride !== DIFF_LINES_TEST_OVERRIDE_UNSET) {
		if (diffLinesTestOverride) return diffLinesTestOverride;
		throw new Error("Native edit diff is unavailable: diffLines export is missing");
	}

	if (cachedNativeDiffLines === undefined) {
		try {
			const natives = require("@gajae-code/natives") as { diffLines?: unknown };
			cachedNativeDiffLines = typeof natives.diffLines === "function" ? (natives.diffLines as DiffLinesFn) : null;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Native edit diff failed to load: ${message}`, { cause: error });
		}
	}

	if (!cachedNativeDiffLines) throw new Error("Native edit diff is unavailable: diffLines export is missing");
	return cachedNativeDiffLines;
}

function levenshteinDistance(a: string, b: string): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	let current = new Array<number>(b.length + 1);
	for (let i = 1; i <= a.length; i++) {
		current[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
		}
		[previous, current] = [current, previous];
	}
	return previous[b.length];
}

function sequenceScoreAt(lines: string[], pattern: string[], index: number): number {
	let total = 0;
	for (let offset = 0; offset < pattern.length; offset++) {
		const line = normalizeForFuzzy(lines[index + offset]);
		const expected = normalizeForFuzzy(pattern[offset]);
		const maxLength = Math.max(line.length, expected.length);
		total += maxLength === 0 ? 1 : 1 - levenshteinDistance(line, expected) / maxLength;
	}
	return total / pattern.length;
}

/** Test oracle only. Production sequence diagnostics must use native results. */
export function __findClosestSequenceMatchTypeScriptOracle(
	lines: string[],
	pattern: string[],
	options?: { start?: number; eof?: boolean },
): TypeScriptSequenceMatchOracleResult {
	if (pattern.length === 0) return { index: options?.start ?? 0, confidence: 1 };
	if (pattern.length > lines.length) return { index: undefined, confidence: 0 };
	const start = options?.start ?? 0;
	const maxStart = lines.length - pattern.length;
	const searchStart = options?.eof ? maxStart : start;
	let bestIndex: number | undefined;
	let bestScore = 0;
	const scoreRange = (from: number, to: number) => {
		for (let index = from; index <= to; index++) {
			const score = sequenceScoreAt(lines, pattern, index);
			if (score > bestScore) {
				bestScore = score;
				bestIndex = index;
			}
		}
	};
	scoreRange(searchStart, maxStart);
	if (options?.eof && searchStart > start) scoreRange(start, searchStart - 1);
	return { index: bestIndex, confidence: bestScore };
}

export function resolveNativeFuzzyBindings(): NativeFuzzyBindings {
	if (nativeFuzzyTestOverride !== NATIVE_FUZZY_TEST_OVERRIDE_UNSET) {
		if (nativeFuzzyTestOverride) return nativeFuzzyTestOverride;
		throw new Error("Native edit fuzzy matching is unavailable: native exports are missing");
	}
	if (nativeFuzzyBindings === undefined) {
		try {
			nativeFuzzyBindings = require("@gajae-code/natives") as NativeFuzzyBindings;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Native edit fuzzy matching failed to load: ${message}`, { cause: error });
		}
	}
	return nativeFuzzyBindings;
}

/** Test oracle only. Production diff generation must use the native implementation. */
export function __diffLinesTypeScriptOracle(oldContent: string, newContent: string): DiffLinePart[] {
	return Diff.diffLines(oldContent, newContent);
}

export function __setDiffLinesForTest(diffLines: DiffLinesFn | null): void {
	diffLinesTestOverride = diffLines;
}

export function __clearDiffLinesForTest(): void {
	diffLinesTestOverride = DIFF_LINES_TEST_OVERRIDE_UNSET;
	cachedNativeDiffLines = undefined;
}

export function __getNativeDiffLinesForTest(): DiffLinesFn | undefined {
	try {
		return resolveNativeDiffLines();
	} catch {
		return undefined;
	}
}

export function __setNativeFuzzyBindingsForTest(bindings: NativeFuzzyBindings | null): void {
	nativeFuzzyTestOverride = bindings;
}

export function __clearNativeFuzzyBindingsForTest(): void {
	nativeFuzzyTestOverride = NATIVE_FUZZY_TEST_OVERRIDE_UNSET;
	nativeFuzzyBindings = undefined;
}
