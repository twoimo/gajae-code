import { describe, expect, test } from "bun:test";
import {
	combinePrimaryAndCleanupErrors,
	parseJunitCounts,
	parsePlatformTestPolicyArguments,
	validatePlatformTestPolicy,
	type ExpectedPlatformTestMode,
} from "./verify-platform-test-policy";

function junitRoot(attributes: string): string {
	return `<?xml version="1.0"?><testsuites ${attributes}></testsuites>`;
}

describe("verify-platform-test-policy JUnit parsing", () => {
	test("accepts valid executed and skipped root counts", () => {
		const executed = parseJunitCounts(
			'<?xml version="1.0"?><testsuites tests="3" failures="0" skipped="0"><testsuite name="suite"><testcase name="case" /></testsuite></testsuites>',
		);
		const skipped = parseJunitCounts(junitRoot('tests="3" failures="0" skipped="3"'));

		expect(executed).toEqual({ tests: 3, failures: 0, skipped: 0 });
		expect(skipped).toEqual({ tests: 3, failures: 0, skipped: 3 });
		validatePlatformTestPolicy("executed", executed, 0);
		validatePlatformTestPolicy("skipped", skipped, 0);
	});

	test("rejects malformed reports and missing required root attributes", () => {
		expect(() => parseJunitCounts("<testsuite tests=\"1\" failures=\"0\" skipped=\"0\" />")).toThrow(
			"<testsuites> root",
		);
		expect(() => parseJunitCounts(junitRoot('tests="1" failures="0"'))).toThrow("skipped attribute");
	});

	test("rejects non-numeric root counts", () => {
		expect(() => parseJunitCounts(junitRoot('tests="one" failures="0" skipped="0"'))).toThrow("non-negative integer");
	});
	test("rejects malformed nested attributes and invalid entity references", () => {
		const attributes = 'tests="1" failures="0" skipped="0"';
		expect(() => parseJunitCounts(`<testsuites ${attributes}><testsuite malformed=></testsuite></testsuites>`)).toThrow(
			"malformed attributes",
		);
		expect(() => parseJunitCounts(`<testsuites ${attributes}><testsuite name="a" name="b" /></testsuites>`)).toThrow(
			"duplicate name attributes",
		);
		expect(() => parseJunitCounts(`<testsuites ${attributes}><testsuite>bare & text</testsuite></testsuites>`)).toThrow(
			"unterminated XML entity",
		);
		expect(() => parseJunitCounts(`<testsuites ${attributes}><testsuite name="&unknown;" /></testsuites>`)).toThrow(
			"invalid XML entity",
		);
		expect(() => parseJunitCounts(`<testsuites ${attributes}><!DOCTYPE suite></testsuites>`)).toThrow(
			"unsupported XML declaration",
		);
	});

	test("accepts escaped and numeric entities in JUnit content", () => {
		const counts = parseJunitCounts(
			'<?xml version="1.0"?><testsuites tests="1" failures="0" skipped="0"><testsuite name="suite &amp; &#65;"><testcase name="case &#x41;">escaped &lt;text&gt; &#65;<!--foo--><![CDATA[bare & < > <?xml]]><?report data?></testcase></testsuite></testsuites>',
		);

		expect(counts).toEqual({ tests: 1, failures: 0, skipped: 0 });
	});
	test("enforces XML S at parser grammar boundaries", () => {
		const attributes = 'tests="1" failures="0" skipped="0"';

		expect(() => parseJunitCounts(`<testsuites\u00a0${attributes}></testsuites>`)).toThrow("malformed attributes");
		expect(() => parseJunitCounts(`<testsuites ${attributes}></ testsuites>`)).toThrow("close tag");
		expect(() => parseJunitCounts(`<testsuites ${attributes}><testsuite/ ></testsuites>`)).toThrow("malformed");
		expect(() => parseJunitCounts(`<testsuites ${attributes}><? report?></testsuites>`)).toThrow(
			"invalid XML processing instruction",
		);

		expect(
			parseJunitCounts(
				'<testsuites tests \t= \n"1" failures \r= "0" skipped =\t"0"><testsuite /><?report?></testsuites \n>',
			),
		).toEqual({ tests: 1, failures: 0, skipped: 0 });
	});
	test("rejects malformed XML comments and forbidden text terminators", () => {
		const attributes = 'tests="1" failures="0" skipped="0"';
		expect(() => parseJunitCounts(`<testsuites ${attributes}><testsuite><!--foo---></testsuite></testsuites>`)).toThrow(
			"malformed XML comment",
		);
		expect(() => parseJunitCounts(`<testsuites ${attributes}><testsuite><!--foo--bar--></testsuite></testsuites>`)).toThrow(
			"malformed XML comment",
		);
		expect(() => parseJunitCounts(`<testsuites ${attributes}><testsuite>text ]]></testsuite></testsuites>`)).toThrow(
			"forbidden ]]> sequence",
		);
	});

	test("rejects illegal XML 1.0 numeric references and raw characters", () => {
		const attributes = 'tests="1" failures="0" skipped="0"';
		for (const entity of ["&#1;", "&#x1;", "&#xD800;", "&#xFFFE;", "&#xFFFF;"]) {
			expect(() => parseJunitCounts(`<testsuites ${attributes}><testsuite>${entity}</testsuite></testsuites>`)).toThrow(
				"invalid XML entity",
			);
		}
		expect(() => parseJunitCounts(`<testsuites ${attributes}><testsuite>\u0001</testsuite></testsuites>`)).toThrow(
			"illegal XML 1.0 character",
		);
		expect(() => parseJunitCounts(`<testsuites ${attributes} name="\uD800"></testsuites>`)).toThrow(
			"illegal XML 1.0 character",
		);
	});

	test("accepts XML 1.0 numeric character boundaries", () => {
		const counts = parseJunitCounts(
			'<testsuites tests="1" failures="0" skipped="0"><testsuite name="&#x9;&#xA;&#xD;&#x20;&#xD7FF;&#xE000;&#xFFFD;&#x10000;&#x10FFFF;" /></testsuites>',
		);

		expect(counts).toEqual({ tests: 1, failures: 0, skipped: 0 });
	});

	test("validates the XML declaration at the exact document start", () => {
		const attributes = 'tests="1" failures="0" skipped="0"';
		expect(parseJunitCounts(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?> \n<testsuites ${attributes}></testsuites>`)).toEqual({
			tests: 1,
			failures: 0,
			skipped: 0,
		});
		expect(parseJunitCounts(` \t\n<testsuites ${attributes}></testsuites>`)).toEqual({ tests: 1, failures: 0, skipped: 0 });
		expect(() => parseJunitCounts(`<?xml bogus?><testsuites ${attributes}></testsuites>`)).toThrow(
			"malformed XML declaration",
		);
		for (const prefix of [" \n", "content"]) {
			expect(() => parseJunitCounts(`${prefix}<?xml version="1.0"?><testsuites ${attributes}></testsuites>`)).toThrow(
				"XML declaration must begin at the start",
			);
		}
	});
	test("rejects incomplete, mismatched, trailing, and spliced root documents", () => {
		const attributes = 'tests="1" failures="0" skipped="0"';
		expect(() => parseJunitCounts(`<testsuites ${attributes}>`)).toThrow("incomplete XML document");
		expect(() => parseJunitCounts(`<testsuites ${attributes}></testsuite>`)).toThrow("expected </testsuites>");
		expect(() => parseJunitCounts(`<testsuites ${attributes}></testsuites>trailing`)).toThrow(
			"exactly one complete",
		);
		expect(() => parseJunitCounts(`<testsuites ${attributes}></testsuites><testsuites ${attributes}></testsuites>`)).toThrow(
			"exactly one complete",
		);
		expect(() => parseJunitCounts(`<testsuites ${attributes}><testsuites ${attributes}></testsuites></testsuites>`)).toThrow(
			"exactly one <testsuites>",
		);
	});
});

describe("verify-platform-test-policy cleanup errors", () => {
	test("preserves primary and cleanup diagnostics", () => {
		const combined = combinePrimaryAndCleanupErrors(new Error("primary failure"), new Error("cleanup failure"));

		expect(combined?.message).toContain("primary failure");
		expect(combined?.message).toContain("Cleanup failed: cleanup failure");
	});

	test("reports cleanup failure after otherwise successful verification", () => {
		expect(combinePrimaryAndCleanupErrors(undefined, new Error("cleanup failure"))?.message).toBe(
			"Cleanup failed: cleanup failure",
		);
	});
});
describe("verify-platform-test-policy validation", () => {
	test("rejects child failures and nonzero test exits", () => {
		expect(() => validatePlatformTestPolicy("executed", { tests: 1, failures: 1, skipped: 0 }, 0)).toThrow("1 failures");
		expect(() => validatePlatformTestPolicy("executed", { tests: 1, failures: 0, skipped: 0 }, 1)).toThrow(
			"code 1",
		);
	});

	test("rejects zero executed tests", () => {
		expect(() => validatePlatformTestPolicy("executed", { tests: 0, failures: 0, skipped: 0 }, 0)).toThrow("zero tests");
	});

	test("rejects mixed skipped counts", () => {
		expect(() => validatePlatformTestPolicy("skipped", { tests: 2, failures: 0, skipped: 1 }, 0)).toThrow(
			"every test to be skipped",
		);
		expect(() => validatePlatformTestPolicy("executed", { tests: 2, failures: 0, skipped: 1 }, 0)).toThrow(
			"no skipped tests",
		);
	});

	test("rejects invalid mode boundaries", () => {
		expect(() =>
			validatePlatformTestPolicy("unsupported" as ExpectedPlatformTestMode, { tests: 1, failures: 0, skipped: 0 }, 0),
		).toThrow("Unknown expected platform test mode");
	});
});

describe("verify-platform-test-policy CLI arguments", () => {
	test("accepts exactly one expectation flag and one test file", () => {
		expect(parsePlatformTestPolicyArguments(["--expect-skipped", "scripts/gjc-session/create.test.ts"])).toEqual({
			mode: "skipped",
			testFile: "scripts/gjc-session/create.test.ts",
		});
		expect(parsePlatformTestPolicyArguments(["--expect-executed", "scripts/gjc-session/create.test.ts"])).toEqual({
			mode: "executed",
			testFile: "scripts/gjc-session/create.test.ts",
		});
	});

	test("rejects invalid flags, missing files, and extra arguments", () => {
		expect(() => parsePlatformTestPolicyArguments(["--expect-other", "test.ts"])).toThrow("Unknown expectation");
		expect(() => parsePlatformTestPolicyArguments(["--expect-skipped"])).toThrow("Usage:");
		expect(() => parsePlatformTestPolicyArguments(["--expect-executed", "test.ts", "extra"])).toThrow("Usage:");
	});
});
