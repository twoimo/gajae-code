import { afterEach, describe, expect, test } from "bun:test";
import { generateDiffString } from "../src/edit/diff";
import { findMatch, seekSequence } from "../src/edit/modes/replace";
import {
	__clearDiffLinesForTest,
	__clearNativeFuzzyBindingsForTest,
	__setDiffLinesForTest,
	__setNativeFuzzyBindingsForTest,
} from "../src/edit/testing/native-edit-test-hooks";

describe("native edit failure contract", () => {
	afterEach(() => {
		__clearDiffLinesForTest();
		__clearNativeFuzzyBindingsForTest();
	});

	test("diff generation reports a native exception instead of switching to TypeScript", () => {
		__setDiffLinesForTest(() => {
			throw new Error("simulated diff failure");
		});

		expect(() => generateDiffString("before\n", "after\n")).toThrow(
			"Native edit diff failed: simulated diff failure",
		);
	});

	test("replace fuzzy matching reports a native exception instead of switching to TypeScript", () => {
		__setNativeFuzzyBindingsForTest({
			h01FindBestFuzzyMatch() {
				throw new Error("simulated fuzzy failure");
			},
		});

		expect(() => findMatch("alpha beta gamma", "alpha beta gamme", { allowFuzzy: true })).toThrow(
			"Native edit fuzzy matching h01FindBestFuzzyMatch failed: simulated fuzzy failure",
		);
	});

	test("sequence fuzzy matching reports a missing native export instead of using its TypeScript oracle", () => {
		__setNativeFuzzyBindingsForTest({});

		expect(() => seekSequence(["alpha beta gamma"], ["alpha beta gamme"], 0, false)).toThrow(
			"Native edit fuzzy matching is unavailable: h02ScoreSequenceFuzzy export is missing",
		);
	});

	test("sequence fuzzy matching keeps an authoritative native no-match", () => {
		__setNativeFuzzyBindingsForTest({
			h02ScoreSequenceFuzzy() {
				return { confidence: 0.5, matchCount: 0, matchIndices: [], secondBestScore: 0.4 };
			},
		});

		expect(seekSequence(["alpha beta gamma"], ["alpha beta gamme"], 0, false)).toEqual({
			index: undefined,
			confidence: 0.5,
			matchCount: 0,
		});
	});
});
