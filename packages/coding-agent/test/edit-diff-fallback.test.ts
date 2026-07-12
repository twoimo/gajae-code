import { afterEach, describe, expect, test } from "bun:test";
import { generateDiffString } from "../src/edit/diff";
import {
	__clearDiffLinesForTest,
	__diffLinesTypeScriptOracle,
	__getNativeDiffLinesForTest,
	__setDiffLinesForTest,
} from "../src/edit/testing/native-edit-test-hooks";

const cases = [
	{ name: "unicode", oldContent: "hello\ncafe\nemoji 😀\n", newContent: "hello\ncafé\nemoji 😎\n" },
	{ name: "lf trailing newline", oldContent: "one\ntwo\nthree\n", newContent: "one\n2\nthree\n" },
	{ name: "lf no trailing newline", oldContent: "one\ntwo\nthree", newContent: "one\n2\nthree" },
	{ name: "crlf trailing newline", oldContent: "one\r\ntwo\r\nthree\r\n", newContent: "one\r\n2\r\nthree\r\n" },
	{ name: "crlf no trailing newline", oldContent: "one\r\ntwo\r\nthree", newContent: "one\r\n2\r\nthree" },
	{ name: "cr-only trailing newline", oldContent: "one\rtwo\rthree\r", newContent: "one\r2\rthree\r" },
	{ name: "cr-only no trailing newline", oldContent: "one\rtwo\rthree", newContent: "one\r2\rthree" },
	{
		name: "adjacent insert and remove blocks",
		oldContent: "alpha\nremove-a\nremove-b\nshared\nomega\n",
		newContent: "alpha\nadd-a\nadd-b\nshared\nomega\n",
	},
];

describe("generateDiffString native ownership", () => {
	afterEach(() => {
		__clearDiffLinesForTest();
	});

	test("surfaces a missing native diff export", () => {
		__setDiffLinesForTest(null);
		expect(() => generateDiffString("old\n", "new\n")).toThrow(
			"Native edit diff is unavailable: diffLines export is missing",
		);
	});

	test("surfaces a native diff runtime failure", () => {
		__setDiffLinesForTest(() => {
			throw new Error("native diff failed");
		});
		expect(() => generateDiffString("old\n", "new\n")).toThrow("Native edit diff failed: native diff failed");
	});

	test("keeps the TypeScript implementation as a differential oracle", () => {
		const nativeDiffLines = __getNativeDiffLinesForTest();
		if (!nativeDiffLines) return;

		for (const item of cases) {
			__setDiffLinesForTest(nativeDiffLines);
			const nativeResult = generateDiffString(item.oldContent, item.newContent);
			__setDiffLinesForTest(__diffLinesTypeScriptOracle);
			const oracleResult = generateDiffString(item.oldContent, item.newContent);
			expect(nativeResult, item.name).toEqual(oracleResult);
		}
	});
});
