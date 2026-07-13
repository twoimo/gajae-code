import { describe, expect, test } from "bun:test";
import {
	combinePrimaryAndCleanupErrors,
	parseJunitCounts,
	parsePlatformTestPolicyArguments,
	validatePlatformTestPolicy,
	type ExpectedPlatformTestMode,
} from "./verify-platform-test-policy";

const ROOT_COUNTS = 'tests="1" failures="0" skipped="0"';
const SUITE_COUNTS = 'tests="1" failures="0" skipped="0"';
const PASSING_TESTCASE = '<testcase name="case" classname="suite" file="suite.test.ts" line="1" />';
const SKIPPED_TESTCASE = '<testcase name="case" classname="suite" file="suite.test.ts" line="1"><skipped /></testcase>';

function junitRoot(attributes: string, body: string): string {
	return `<?xml version="1.0"?><testsuites ${attributes}>${body}</testsuites>`;
}

function junitSuite(attributes: string, body: string): string {
	return `<testsuite name="suite" file="suite.test.ts" ${attributes}>${body}</testsuite>`;
}

function junitReport(rootAttributes = ROOT_COUNTS, suiteAttributes = SUITE_COUNTS, body = PASSING_TESTCASE): string {
	return junitRoot(rootAttributes, junitSuite(suiteAttributes, body));
}

describe("verify-platform-test-policy JUnit parsing", () => {
	test("accepts valid Bun JUnit reports for executed and fully skipped suites", () => {
		const executed = parseJunitCounts(junitReport());
		const skipped = parseJunitCounts(junitReport('tests="1" failures="0" skipped="1"', 'tests="1" failures="0" skipped="1"', SKIPPED_TESTCASE));

		expect(executed).toEqual({ tests: 1, failures: 0, errors: 0, skipped: 0 });
		expect(skipped).toEqual({ tests: 1, failures: 0, errors: 0, skipped: 1 });
		validatePlatformTestPolicy("executed", executed, 0);
		validatePlatformTestPolicy("skipped", skipped, 0);
	});

	test("reconciles nested Bun suites against their testcase descendants", () => {
		const testcase = '<testcase name="nested case" classname="inner > outer" file="suite.test.ts" line="2" />';
		const report = junitRoot(
			'tests="2" failures="0" skipped="0"',
			`<testsuite name="outer" file="suite.test.ts" tests="2" failures="0" skipped="0">
				<testsuite name="inner" file="suite.test.ts" line="1" tests="1" failures="0" skipped="0">${testcase}</testsuite>
				<testcase name="outer case" classname="outer" file="suite.test.ts" line="3" />
			</testsuite>`,
		);

		expect(parseJunitCounts(report)).toEqual({ tests: 2, failures: 0, errors: 0, skipped: 0 });
	});

	test("rejects malformed reports and missing required root attributes", () => {
		expect(() => parseJunitCounts('<testsuite tests="1" failures="0" skipped="0" />')).toThrow("<testsuites> root");
		expect(() => parseJunitCounts(junitRoot('tests="1" failures="0"', ""))).toThrow("skipped attribute");
	});

	test("rejects non-numeric root counts", () => {
		expect(() => parseJunitCounts(junitRoot('tests="one" failures="0" skipped="0"', ""))).toThrow("non-negative integer");
	});

	test("rejects malformed nested attributes and invalid entity references", () => {
		const attributes = 'tests="1" failures="0" skipped="0"';
		expect(() => parseJunitCounts(junitRoot(attributes, '<testsuite malformed=></testsuite>'))).toThrow("malformed attributes");
		expect(() => parseJunitCounts(junitRoot(attributes, '<testsuite name="a" name="b" />'))).toThrow("duplicate name attributes");
		expect(() => parseJunitCounts(junitRoot(attributes, `${junitSuite(attributes, "bare & text")}`))).toThrow(
			"unterminated XML entity",
		);
		expect(() => parseJunitCounts(junitRoot(`${attributes} name="&unknown;"`, junitSuite(attributes, PASSING_TESTCASE)))).toThrow(
			"invalid XML entity",
		);
		expect(() => parseJunitCounts(junitRoot(attributes, "<!DOCTYPE suite>"))).toThrow("unsupported XML declaration");
	});

	test("accepts escaped and numeric entities in valid Bun JUnit content", () => {
		const report = junitRoot(
			ROOT_COUNTS,
			`<testsuite name="suite &amp; &#65;" file="suite.test.ts" ${SUITE_COUNTS}><testcase name="case &#x41;" classname="suite &amp; &#65;" file="suite.test.ts" line="1">escaped &lt;text&gt; &#65;<!--foo--><![CDATA[bare & < > <?xml]]><?report data?></testcase></testsuite>`,
		);

		expect(parseJunitCounts(report)).toEqual({ tests: 1, failures: 0, errors: 0, skipped: 0 });
	});

	test("enforces XML S at parser grammar boundaries", () => {
		const attributes = ROOT_COUNTS;

		expect(() => parseJunitCounts(`<testsuites\u00a0${attributes}></testsuites>`)).toThrow("malformed attributes");
		expect(() => parseJunitCounts(junitRoot(attributes, `${junitSuite(SUITE_COUNTS, PASSING_TESTCASE)}</ testsuites>`))).toThrow(
			"close tag",
		);
		expect(() => parseJunitCounts(junitRoot(attributes, "<testsuite/ >"))).toThrow("malformed");
		expect(() => parseJunitCounts(junitRoot(attributes, "<? report?>"))).toThrow("invalid XML processing instruction");

		expect(
		parseJunitCounts(
			'<testsuites tests \t= \n"1" failures \r= "0" skipped =\t"0"><testsuite name="suite" file="suite.test.ts" tests="1" failures="0" skipped="0"><testcase name="case" classname="suite" file="suite.test.ts" line="1" /></testsuite><?report?></testsuites \n>',
		),
	).toEqual({ tests: 1, failures: 0, errors: 0, skipped: 0 });
	});

	test("rejects malformed XML comments and forbidden text terminators", () => {
		expect(() => parseJunitCounts(junitReport(ROOT_COUNTS, SUITE_COUNTS, "<!--foo--->"))).toThrow("malformed XML comment");
		expect(() => parseJunitCounts(junitReport(ROOT_COUNTS, SUITE_COUNTS, "<!--foo--bar-->"))).toThrow("malformed XML comment");
		expect(() => parseJunitCounts(junitReport(ROOT_COUNTS, SUITE_COUNTS, "text ]]>"))).toThrow("forbidden ]]> sequence");
	});

	test("rejects illegal XML 1.0 numeric references and raw characters", () => {
		for (const entity of ["&#1;", "&#x1;", "&#xD800;", "&#xFFFE;", "&#xFFFF;"]) {
			expect(() => parseJunitCounts(junitReport(ROOT_COUNTS, SUITE_COUNTS, `${entity}${PASSING_TESTCASE}`))).toThrow(
				"invalid XML entity",
			);
		}
		expect(() => parseJunitCounts(junitReport(ROOT_COUNTS, SUITE_COUNTS, `\u0001${PASSING_TESTCASE}`))).toThrow(
			"illegal XML 1.0 character",
		);
		expect(() => parseJunitCounts(junitRoot(`${ROOT_COUNTS} name="\uD800"`, junitSuite(SUITE_COUNTS, PASSING_TESTCASE)))).toThrow(
			"illegal XML 1.0 character",
		);
	});

	test("accepts XML 1.0 numeric character boundaries", () => {
		const report = junitRoot(
			ROOT_COUNTS,
			`<testsuite name="&#x9;&#xA;&#xD;&#x20;&#xD7FF;&#xE000;&#xFFFD;&#x10000;&#x10FFFF;" file="suite.test.ts" ${SUITE_COUNTS}>${PASSING_TESTCASE}</testsuite>`,
		);

		expect(parseJunitCounts(report)).toEqual({ tests: 1, failures: 0, errors: 0, skipped: 0 });
	});

	test("validates the XML declaration at the exact document start", () => {
		const report = junitReport();
		expect(parseJunitCounts(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?> \n${report.slice(report.indexOf("<testsuites"))}`)).toEqual({
			tests: 1,
			failures: 0,
			errors: 0,
			skipped: 0,
		});
		expect(parseJunitCounts(` \t\n${report.slice(report.indexOf("<testsuites"))}`)).toEqual({ tests: 1, failures: 0, errors: 0, skipped: 0 });
		expect(() => parseJunitCounts(`<?xml bogus?>${report.slice(report.indexOf("<testsuites"))}`)).toThrow("malformed XML declaration");
		for (const prefix of [" \n", "content"]) {
			expect(() => parseJunitCounts(`${prefix}<?xml version="1.0"?>${report.slice(report.indexOf("<testsuites"))}`)).toThrow(
				"XML declaration must begin at the start",
			);
		}
	});

	test("rejects incomplete, mismatched, trailing, and spliced root documents", () => {
		expect(() => parseJunitCounts(`<testsuites ${ROOT_COUNTS}>`)).toThrow("incomplete XML document");
		expect(() =>
			parseJunitCounts(
				`<testsuites ${ROOT_COUNTS}><testsuite name="suite" file="suite.test.ts" ${SUITE_COUNTS}><testcase name="case" file="suite.test.ts" line="1">`,
			),
		).toThrow("incomplete XML document");
		expect(() => parseJunitCounts(`<testsuites ${ROOT_COUNTS}></testsuite>`)).toThrow("expected </testsuites>");
		expect(() => parseJunitCounts(`${junitReport()}trailing`)).toThrow("exactly one complete");
		expect(() => parseJunitCounts(`${junitReport()}${junitReport()}`)).toThrow("exactly one complete");
		expect(() => parseJunitCounts(junitRoot(ROOT_COUNTS, `<testsuites ${ROOT_COUNTS}></testsuites>`))).toThrow(
			"exactly one <testsuites>",
		);
	});

	test("rejects count-only and empty-body reports", () => {
		expect(() => parseJunitCounts(junitRoot(ROOT_COUNTS, ""))).toThrow("at least one testcase");
		expect(() => parseJunitCounts(junitReport(ROOT_COUNTS, SUITE_COUNTS, ""))).toThrow("at least one testcase");
	});

	test("rejects root and nested suite reconciliation mismatches", () => {
		expect(() => parseJunitCounts(junitReport('tests="999" failures="0" skipped="0"'))).toThrow("<testsuites> count mismatch for tests");
		expect(() => parseJunitCounts(junitReport(ROOT_COUNTS, 'tests="999" failures="0" skipped="0"'))).toThrow(
			"<testsuite> count mismatch for tests",
		);
		expect(() => parseJunitCounts(junitReport('tests="1" failures="1" skipped="0"'))).toThrow("count mismatch for failures");
		expect(() => parseJunitCounts(junitReport('tests="1" failures="0" skipped="1"'))).toThrow("count mismatch for skipped");
	});

	test("rejects nested errors whether omitted or explicitly reported by counts", () => {
		const errored = '<testcase name="case" classname="suite" file="suite.test.ts" line="1"><error type="Error" /></testcase>';
		expect(() => parseJunitCounts(junitReport(ROOT_COUNTS, SUITE_COUNTS, errored))).toThrow("count mismatch for errors");

		const counts = parseJunitCounts(
			junitReport('tests="1" failures="0" errors="1" skipped="0"', 'tests="1" failures="0" errors="1" skipped="0"', errored),
		);
		expect(counts).toEqual({ tests: 1, failures: 0, errors: 1, skipped: 0 });
		expect(() => validatePlatformTestPolicy("executed", counts, 0)).toThrow("1 errors");
	});

	test("rejects duplicate and incomplete testcase identities after entity decoding", () => {
		const first = '<testcase name="case &#x41;" classname="suite" file="suite.test.ts" line="1" />';
		const second = '<testcase name="case A" classname="suite" file="suite.test.ts" line="1" />';
		expect(() => parseJunitCounts(junitReport('tests="2" failures="0" skipped="0"', 'tests="2" failures="0" skipped="0"', `${first}${second}`))).toThrow(
			"duplicate testcase identities",
		);
		expect(() => parseJunitCounts(junitReport(ROOT_COUNTS, SUITE_COUNTS, '<testcase name="case" line="1" />'))).toThrow(
			"file and name attributes",
		);
		expect(() => parseJunitCounts(junitReport(ROOT_COUNTS, SUITE_COUNTS, '<testcase name="case" file="suite.test.ts" line="0" />'))).toThrow(
			"positive safe-integer line",
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
	test("rejects child failures, errors, and nonzero test exits", () => {
		expect(() => validatePlatformTestPolicy("executed", { tests: 1, failures: 1, errors: 0, skipped: 0 }, 0)).toThrow("1 failures");
		expect(() => validatePlatformTestPolicy("executed", { tests: 1, failures: 0, errors: 1, skipped: 0 }, 0)).toThrow("1 errors");
		expect(() => validatePlatformTestPolicy("executed", { tests: 1, failures: 0, errors: 0, skipped: 0 }, 1)).toThrow(
			"code 1",
		);
	});

	test("rejects zero executed tests", () => {
		expect(() => validatePlatformTestPolicy("executed", { tests: 0, failures: 0, errors: 0, skipped: 0 }, 0)).toThrow("zero tests");
	});

	test("distinguishes exact whole-suite skips from executed zero-skip suites", () => {
		expect(() => validatePlatformTestPolicy("skipped", { tests: 2, failures: 0, errors: 0, skipped: 1 }, 0)).toThrow(
			"every test to be skipped",
		);
		expect(() => validatePlatformTestPolicy("executed", { tests: 2, failures: 0, errors: 0, skipped: 1 }, 0)).toThrow(
			"no skipped tests",
		);
	});

	test("rejects invalid mode boundaries", () => {
		expect(() =>
		validatePlatformTestPolicy("unsupported" as ExpectedPlatformTestMode, { tests: 1, failures: 0, errors: 0, skipped: 0 }, 0),
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
