import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type ExpectedPlatformTestMode = "skipped" | "executed";

export interface JunitCounts {
	tests: number;
	failures: number;
	errors: number;
	skipped: number;
}

export interface PlatformTestPolicyArguments {
	mode: ExpectedPlatformTestMode;
	testFile: string;
}

interface TestExecution {
	exitCode: number;
	stderr: string;
	stdout: string;
}

const XML_NAME_PATTERN = /^[A-Za-z_:][A-Za-z0-9_:.-]*/;
const XML_WHITESPACE_PATTERN = /^[\x20\x09\x0a\x0d]*/;
const XML_DECLARATION_PATTERN =
	/^<\?xml[ \t\r\n]+version=(["'])1\.0\1(?:[ \t\r\n]+encoding=(["'])[A-Za-z][A-Za-z0-9._-]*\2)?(?:[ \t\r\n]+standalone=(["'])(?:yes|no)\3)?[ \t\r\n]*\?>[ \t\r\n]*/;
const JUNIT_RECONCILED_COUNT_ATTRIBUTES = ["tests", "failures", "errors", "skipped"] as const;
const MAX_JUNIT_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_JUNIT_REPORT_CHARACTERS = MAX_JUNIT_REPORT_BYTES;
const MAX_JUNIT_XML_DEPTH = 64;
const MAX_JUNIT_ELEMENTS = 100_000;
const MAX_JUNIT_TAG_LENGTH = 16 * 1024;
const MAX_JUNIT_MARKUP_LENGTH = 64 * 1024;
const MAX_JUNIT_ATTRIBUTES_PER_ELEMENT = 64;
const MAX_JUNIT_ENTITY_LENGTH = 64;

type JunitCountAttribute = (typeof JUNIT_RECONCILED_COUNT_ATTRIBUTES)[number];
type TestcaseOutcome = "failure" | "error" | "skipped";

interface SuiteFrame {
	declared: JunitCounts;
	observed: JunitCounts;
}

interface TestcaseFrame {
	identity: string;
	outcome: TestcaseOutcome | undefined;
}

interface ParsedElement {
	name: string;
	suite: SuiteFrame | undefined;
	testcase: TestcaseFrame | undefined;
}

function formatChildOutput(execution: TestExecution): string {
	return [
		"Child stdout:",
		execution.stdout || "(empty)",
		"Child stderr:",
		execution.stderr || "(empty)",
	].join("\n");
}
export function combinePrimaryAndCleanupErrors(
	primaryError: Error | undefined,
	cleanupError: Error | undefined,
): Error | undefined {
	if (primaryError && cleanupError) {
		return new Error(`${primaryError.message}\nCleanup failed: ${cleanupError.message}`);
	}
	if (cleanupError) {
		return new Error(`Cleanup failed: ${cleanupError.message}`);
	}
	return primaryError;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function isLegalXmlCharacter(codePoint: number): boolean {
	return (
		codePoint === 0x9 ||
		codePoint === 0xa ||
		codePoint === 0xd ||
		(codePoint >= 0x20 && codePoint <= 0xd7ff) ||
		(codePoint >= 0xe000 && codePoint <= 0xfffd) ||
		(codePoint >= 0x10000 && codePoint <= 0x10ffff)
	);
}

function isXmlWhitespace(character: string | undefined): boolean {
	return character === "\x20" || character === "\x09" || character === "\x0a" || character === "\x0d";
}

function isOnlyXmlWhitespace(value: string): boolean {
	for (const character of value) {
		if (!isXmlWhitespace(character)) return false;
	}
	return true;
}

function validateXmlCharacters(value: string, context: string): void {
	for (let index = 0; index < value.length; ) {
		const codePoint = value.codePointAt(index);
		if (codePoint === undefined || !isLegalXmlCharacter(codePoint)) {
			throw new Error(`JUnit ${context} contains an illegal XML 1.0 character.`);
		}
		index += codePoint > 0xffff ? 2 : 1;
	}
}

function decodeXmlEntities(value: string, context: string): string {
	let decoded = "";
	let cursor = 0;

	while (cursor < value.length) {
		const entityStart = value.indexOf("&", cursor);
		if (entityStart === -1) return decoded + value.slice(cursor);
		decoded += value.slice(cursor, entityStart);

		let entityEnd = entityStart + 1;
		while (entityEnd < value.length && value[entityEnd] !== ";") {
			if (value[entityEnd] === "&") {
				throw new Error(`JUnit ${context} contains an unterminated XML entity reference.`);
			}
			if (entityEnd - entityStart > MAX_JUNIT_ENTITY_LENGTH) {
				throw new Error(`JUnit ${context} contains an XML entity reference that exceeds the parser bound.`);
			}
			entityEnd += 1;
		}
		if (entityEnd === value.length) {
			throw new Error(`JUnit ${context} contains an unterminated XML entity reference.`);
		}

		const entity = value.slice(entityStart + 1, entityEnd);
		switch (entity) {
			case "amp":
				decoded += "&";
				break;
			case "apos":
				decoded += "'";
				break;
			case "gt":
				decoded += ">";
				break;
			case "lt":
				decoded += "<";
				break;
			case "quot":
				decoded += '"';
				break;
			default: {
				const decimal = /^#\d+$/.test(entity);
				const hexadecimal = /^#x[0-9A-Fa-f]+$/.test(entity);
				if (!decimal && !hexadecimal) {
					throw new Error(`JUnit ${context} contains an invalid XML entity reference.`);
				}
				const codePoint = Number.parseInt(entity.slice(decimal ? 1 : 2), decimal ? 10 : 16);
				if (!Number.isSafeInteger(codePoint) || !isLegalXmlCharacter(codePoint)) {
					throw new Error(`JUnit ${context} contains an invalid XML entity reference.`);
				}
				decoded += String.fromCodePoint(codePoint);
			}
		}
		cursor = entityEnd + 1;
	}

	return decoded;
}

function validateXmlText(value: string): void {
	if (value.includes("]]>")) {
		throw new Error("JUnit XML text contains the forbidden ]]> sequence.");
	}
	validateXmlCharacters(value, "XML text");
	decodeXmlEntities(value, "XML text");
}

function findXmlRootStart(report: string): number {
	const declarationStart = report.indexOf("<?xml");
	if (declarationStart === 0) {
		const declaration = report.match(XML_DECLARATION_PATTERN);
		if (!declaration) {
			throw new Error("JUnit report contains a malformed XML declaration.");
		}
		return declaration[0].length;
	}
	const rootStart = report.indexOf("<testsuites");
	if (declarationStart !== -1 && (rootStart === -1 || declarationStart < rootStart)) {
		throw new Error("JUnit XML declaration must begin at the start of the document.");
	}
	return report.match(XML_WHITESPACE_PATTERN)?.[0].length ?? 0;
}

function parseXmlAttributes(attributes: string, elementName: string): Map<string, string> {
	const values = new Map<string, string>();
	let cursor = 0;

	while (cursor < attributes.length) {
		if (!isXmlWhitespace(attributes[cursor])) {
			throw new Error(`JUnit <${elementName}> has malformed attributes.`);
		}
		while (isXmlWhitespace(attributes[cursor])) cursor += 1;
		if (cursor === attributes.length) break;
		if (values.size >= MAX_JUNIT_ATTRIBUTES_PER_ELEMENT) {
			throw new Error(`JUnit <${elementName}> exceeds the attribute parser bound.`);
		}

		const name = attributes.slice(cursor).match(XML_NAME_PATTERN)?.[0];
		if (!name) {
			throw new Error(`JUnit <${elementName}> has malformed attributes.`);
		}
		cursor += name.length;
		while (isXmlWhitespace(attributes[cursor])) cursor += 1;
		if (attributes[cursor] !== "=") {
			throw new Error(`JUnit <${elementName}> has malformed attributes.`);
		}
		cursor += 1;
		while (isXmlWhitespace(attributes[cursor])) cursor += 1;

		const quote = attributes[cursor];
		if (quote !== '"' && quote !== "'") {
			throw new Error(`JUnit <${elementName}> has malformed attributes.`);
		}
		const valueStart = cursor + 1;
		const valueEnd = attributes.indexOf(quote, valueStart);
		if (valueEnd === -1) {
			throw new Error(`JUnit <${elementName}> has malformed attributes.`);
		}
		const value = attributes.slice(valueStart, valueEnd);
		validateXmlCharacters(value, `<${elementName}> attribute ${name}`);
		if (value.includes("<")) {
			throw new Error(`JUnit <${elementName}> has malformed attributes.`);
		}
		const decodedValue = decodeXmlEntities(value, `<${elementName}> attribute ${name}`);
		if (values.has(name)) {
			throw new Error(`JUnit <${elementName}> contains duplicate ${name} attributes.`);
		}
		values.set(name, decodedValue);
		cursor = valueEnd + 1;
	}

	return values;
}

function parseCountAttribute(
	attributes: Map<string, string>,
	name: JunitCountAttribute,
	elementName: "testsuites" | "testsuite",
): number {
	const value = attributes.get(name);
	const label = elementName === "testsuites" ? "<testsuites> root" : "<testsuite>";
	if (value === undefined) {
		throw new Error(`JUnit ${label} must contain exactly one ${name} attribute.`);
	}
	if (!/^\d+$/.test(value)) {
		throw new Error(`JUnit ${label} ${name} attribute must be a non-negative integer, received ${JSON.stringify(value)}.`);
	}

	const count = Number(value);
	if (!Number.isSafeInteger(count)) {
		throw new Error(`JUnit ${label} ${name} attribute must be a safe integer, received ${JSON.stringify(value)}.`);
	}
	return count;
}

function parseDeclaredCounts(attributes: Map<string, string>, elementName: "testsuites" | "testsuite"): JunitCounts {
	return {
		tests: parseCountAttribute(attributes, "tests", elementName),
		failures: parseCountAttribute(attributes, "failures", elementName),
		// Bun omits this attribute, so absence is a declared zero rather than an unchecked count.
		errors: attributes.has("errors") ? parseCountAttribute(attributes, "errors", elementName) : 0,
		skipped: parseCountAttribute(attributes, "skipped", elementName),
	};
}

function emptyCounts(): JunitCounts {
	return { tests: 0, failures: 0, errors: 0, skipped: 0 };
}

function addCounts(target: JunitCounts, source: JunitCounts): void {
	target.tests += source.tests;
	target.failures += source.failures;
	target.errors += source.errors;
	target.skipped += source.skipped;
}

function assertCountsMatch(elementName: "testsuites" | "testsuite", declared: JunitCounts, observed: JunitCounts): void {
	for (const name of JUNIT_RECONCILED_COUNT_ATTRIBUTES) {
		if (declared[name] !== observed[name]) {
			throw new Error(
				`JUnit <${elementName}> count mismatch for ${name}: declared ${declared[name]}, observed ${observed[name]}.`,
			);
		}
	}
}

function findXmlTagEnd(report: string, start: number): number {
	let quote: string | undefined;
	const limit = Math.min(report.length, start + MAX_JUNIT_TAG_LENGTH);
	for (let index = start + 1; index < limit; index += 1) {
		const character = report[index];
		if (character === undefined) continue;
		if (quote) {
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === ">") return index;
	}
	if (limit < report.length) {
		throw new Error("JUnit report contains an XML tag that exceeds the parser bound.");
	}
	throw new Error("JUnit report contains an incomplete XML tag.");
}

function findXmlCommentEnd(report: string, start: number): number {
	const limit = Math.min(report.length, start + MAX_JUNIT_MARKUP_LENGTH);
	for (let index = start + 4; index < limit; index += 1) {
		if (report[index] !== "-" || report[index + 1] !== "-") continue;
		const terminator = report[index + 2];
		if (terminator === ">") return index;
		if (terminator === undefined) break;
		throw new Error("JUnit report contains a malformed XML comment.");
	}
	if (limit < report.length) {
		throw new Error("JUnit report contains an XML comment that exceeds the parser bound.");
	}
	throw new Error("JUnit report contains an incomplete XML comment.");
}

function findBoundedTerminator(report: string, start: number, offset: number, terminator: string, description: string): number {
	const end = report.indexOf(terminator, start + offset);
	if (end === -1) {
		throw new Error(`JUnit report contains an incomplete ${description}.`);
	}
	if (end - start > MAX_JUNIT_MARKUP_LENGTH) {
		throw new Error(`JUnit report contains a ${description} that exceeds the parser bound.`);
	}
	return end;
}

function validateContainerText(elementName: string, text: string): void {
	if (
		(elementName === "testsuites" || elementName === "testsuite" || elementName === "properties") &&
		!isOnlyXmlWhitespace(text)
	) {
		throw new Error(`JUnit <${elementName}> may not contain unstructured text.`);
	}
}

function validateChildElement(parentName: string, childName: string): void {
	const allowed =
		parentName === "testsuites"
			? ["testsuite"]
			: parentName === "testsuite"
				? ["testsuite", "testcase", "properties", "system-out", "system-err"]
				: parentName === "testcase"
					? ["failure", "error", "skipped", "system-out", "system-err"]
					: parentName === "properties"
						? ["property"]
						: [];
	if (!allowed.includes(childName)) {
		throw new Error(`JUnit <${parentName}> cannot contain <${childName}>.`);
	}
}

function createElement(
	name: string,
	attributes: Map<string, string>,
	testcaseIdentities: Set<string>,
): ParsedElement {
	if (name === "testsuite") {
		return {
			name,
			suite: { declared: parseDeclaredCounts(attributes, "testsuite"), observed: emptyCounts() },
			testcase: undefined,
		};
	}
	if (name === "testcase") {
		const file = attributes.get("file");
		const line = attributes.get("line");
		const testcaseName = attributes.get("name");
		const className = attributes.get("classname") ?? "";
		if (!file || file.trim().length === 0 || !testcaseName || testcaseName.trim().length === 0) {
			throw new Error("JUnit <testcase> must contain non-empty file and name attributes.");
		}
		if (!/^[1-9]\d*$/.test(line ?? "") || !Number.isSafeInteger(Number(line))) {
			throw new Error("JUnit <testcase> must contain a positive safe-integer line attribute.");
		}
		const identity = `${file}\u0000${line}\u0000${className}\u0000${testcaseName}`;
		if (testcaseIdentities.has(identity)) {
			throw new Error("JUnit report contains duplicate testcase identities.");
		}
		testcaseIdentities.add(identity);
		return { name, suite: undefined, testcase: { identity, outcome: undefined } };
	}
	return { name, suite: undefined, testcase: undefined };
}

function recordTestcaseOutcome(parent: ParsedElement, childName: string): void {
	if (!parent.testcase || (childName !== "failure" && childName !== "error" && childName !== "skipped")) return;
	if (parent.testcase.outcome !== undefined) {
		throw new Error(`JUnit testcase ${JSON.stringify(parent.testcase.identity)} contains multiple result elements.`);
	}
	parent.testcase.outcome = childName;
}

function completeElement(element: ParsedElement, ancestors: ParsedElement[], rootObserved: JunitCounts): void {
	if (element.testcase) {
		const observed = emptyCounts();
		observed.tests = 1;
		if (element.testcase.outcome === "failure") observed.failures = 1;
		if (element.testcase.outcome === "error") observed.errors = 1;
		if (element.testcase.outcome === "skipped") observed.skipped = 1;
		addCounts(rootObserved, observed);
		for (const ancestor of ancestors) {
			if (ancestor.suite) addCounts(ancestor.suite.observed, observed);
		}
		return;
	}
	if (element.suite) {
		if (element.suite.observed.tests === 0) {
			throw new Error("JUnit <testsuite> must contain at least one testcase.");
		}
		assertCountsMatch("testsuite", element.suite.declared, element.suite.observed);
	}
}

export function parseJunitCounts(report: string): JunitCounts {
	if (report.length > MAX_JUNIT_REPORT_CHARACTERS) {
		throw new Error(`JUnit report exceeds the ${MAX_JUNIT_REPORT_BYTES}-byte parser bound.`);
	}

	const rootStart = findXmlRootStart(report);
	if (!report.startsWith("<testsuites", rootStart)) {
		throw new Error("JUnit report must begin with a <testsuites> root element.");
	}

	const rootEnd = findXmlTagEnd(report, rootStart);
	const rootTag = report.slice(rootStart, rootEnd + 1);
	const rootContents = rootTag.slice(1, -1);
	const rootName = rootContents.match(XML_NAME_PATTERN)?.[0];
	if (rootName !== "testsuites" || rootContents.endsWith("/")) {
		throw new Error("JUnit report must begin with a non-self-closing <testsuites> root element.");
	}
	const rootAttributes = parseXmlAttributes(rootContents.slice("testsuites".length), "testsuites");
	const declaredRootCounts = parseDeclaredCounts(rootAttributes, "testsuites");
	const rootObserved = emptyCounts();
	const stack: ParsedElement[] = [{ name: "testsuites", suite: undefined, testcase: undefined }];
	const testcaseIdentities = new Set<string>();
	let cursor = rootEnd + 1;
	let elementCount = 0;

	while (stack.length > 0) {
		const parent = stack[stack.length - 1];
		if (parent === undefined) throw new Error("JUnit report contains an invalid XML nesting state.");
		const nextTag = report.indexOf("<", cursor);
		if (nextTag === -1) {
			throw new Error("JUnit report contains an incomplete XML document.");
		}
		const text = report.slice(cursor, nextTag);
		validateXmlText(text);
		validateContainerText(parent.name, text);
		cursor = nextTag;

		if (report.startsWith("<!--", cursor)) {
			const end = findXmlCommentEnd(report, cursor);
			validateXmlCharacters(report.slice(cursor + 4, end), "XML comment");
			cursor = end + 3;
			continue;
		}
		if (report.startsWith("<![CDATA[", cursor)) {
			const end = findBoundedTerminator(report, cursor, 9, "]]>", "CDATA section");
			const content = report.slice(cursor + 9, end);
			validateXmlCharacters(content, "CDATA section");
			validateContainerText(parent.name, content);
			cursor = end + 3;
			continue;
		}
		if (report.startsWith("<?", cursor)) {
			const end = findBoundedTerminator(report, cursor, 2, "?>", "XML processing instruction");
			const contents = report.slice(cursor + 2, end);
			validateXmlCharacters(contents, "XML processing instruction");
			const target = contents.match(XML_NAME_PATTERN)?.[0];
			const data = target === undefined ? undefined : contents.slice(target.length);
			if (
				!target ||
				data === undefined ||
				(data.length > 0 && !isXmlWhitespace(data[0])) ||
				target.toLowerCase() === "xml"
			) {
				throw new Error("JUnit report contains an invalid XML processing instruction.");
			}
			cursor = end + 2;
			continue;
		}
		if (report.startsWith("<!", cursor)) {
			throw new Error("JUnit report contains an unsupported XML declaration.");
		}

		const tagEnd = findXmlTagEnd(report, cursor);
		const tag = report.slice(cursor + 1, tagEnd);
		cursor = tagEnd + 1;

		if (tag.startsWith("/")) {
			const closingContents = tag.slice(1);
			const closingName = closingContents.match(XML_NAME_PATTERN)?.[0];
			const closingWhitespace = closingName === undefined ? "" : closingContents.slice(closingName.length);
			const expected = stack.pop();
			if (!expected || !closingName || !isOnlyXmlWhitespace(closingWhitespace) || closingName !== expected.name) {
				throw new Error(`JUnit XML close tag </${closingContents}> does not match expected </${expected?.name}>.`);
			}
			completeElement(expected, stack, rootObserved);
			continue;
		}

		elementCount += 1;
		if (elementCount > MAX_JUNIT_ELEMENTS) {
			throw new Error("JUnit report exceeds the XML element parser bound.");
		}
		const selfClosing = tag.endsWith("/");
		const openingTag = selfClosing ? tag.slice(0, -1) : tag;
		const name = openingTag.match(XML_NAME_PATTERN)?.[0];
		if (!name || (openingTag.length > name.length && !isXmlWhitespace(openingTag[name.length]))) {
			throw new Error("JUnit report contains a malformed XML tag.");
		}
		if (name === "testsuites") {
			throw new Error("JUnit report must contain exactly one <testsuites> root element.");
		}
		const attributes = parseXmlAttributes(openingTag.slice(name.length), name);
		validateChildElement(parent.name, name);
		recordTestcaseOutcome(parent, name);
		const element = createElement(name, attributes, testcaseIdentities);
		if (selfClosing) {
			completeElement(element, stack, rootObserved);
			continue;
		}
		if (stack.length >= MAX_JUNIT_XML_DEPTH) {
			throw new Error("JUnit report exceeds the XML nesting-depth parser bound.");
		}
		stack.push(element);
	}

	if (!isOnlyXmlWhitespace(report.slice(cursor))) {
		throw new Error("JUnit report must contain exactly one complete <testsuites> root document.");
	}
	if (rootObserved.tests === 0) {
		throw new Error("JUnit report must contain at least one testcase.");
	}
	assertCountsMatch("testsuites", declaredRootCounts, rootObserved);
	return rootObserved;
}

export function validatePlatformTestPolicy(
	mode: ExpectedPlatformTestMode,
	counts: JunitCounts,
	exitCode: number,
): void {
	if (exitCode !== 0) {
		throw new Error(`bun test exited with code ${exitCode}; expected 0.`);
	}
	if (counts.failures !== 0) {
		throw new Error(`JUnit reported ${counts.failures} failures; expected 0.`);
	}
	if (counts.errors !== 0) {
		throw new Error(`JUnit reported ${counts.errors} errors; expected 0.`);
	}

	if (mode === "skipped") {
		if (counts.skipped === 0) {
			throw new Error("Expected the test suite to be skipped, but JUnit reported zero skipped tests.");
		}
		if (counts.tests !== counts.skipped) {
			throw new Error(
				`Expected every test to be skipped, but JUnit reported tests=${counts.tests} and skipped=${counts.skipped}.`,
			);
		}
		return;
	}

	if (mode === "executed") {
		if (counts.tests === 0) {
			throw new Error("Expected the test suite to execute, but JUnit reported zero tests.");
		}
		if (counts.skipped !== 0) {
			throw new Error(`Expected no skipped tests, but JUnit reported skipped=${counts.skipped}.`);
		}
		return;
	}

	throw new Error(`Unknown expected platform test mode: ${String(mode)}.`);
}

export function parsePlatformTestPolicyArguments(args: string[]): PlatformTestPolicyArguments {
	if (args.length !== 2) {
		throw new Error("Usage: bun scripts/verify-platform-test-policy.ts --expect-skipped|--expect-executed <test-file>");
	}

	const [flag, testFile] = args;
	if (!testFile || testFile.trim().length === 0) {
		throw new Error("A non-empty test file path is required.");
	}
	if (flag === "--expect-skipped") return { mode: "skipped", testFile };
	if (flag === "--expect-executed") return { mode: "executed", testFile };
	throw new Error(`Unknown expectation ${JSON.stringify(flag)}. Use --expect-skipped or --expect-executed.`);
}

export async function verifyPlatformTestPolicy(args: PlatformTestPolicyArguments): Promise<void> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-platform-test-policy-"));
	let execution: TestExecution | undefined;

	let primaryError: Error | undefined;
	try {
		const reportPath = path.join(tempDir, `${crypto.randomUUID()}.junit.xml`);
		const child = Bun.spawn(
			["bun", "test", args.testFile, "--reporter=junit", `--reporter-outfile=${reportPath}`],
			{ stderr: "pipe", stdout: "pipe" },
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		execution = { exitCode, stderr, stdout };

		if (exitCode !== 0) {
			throw new Error(`bun test ${args.testFile} exited with code ${exitCode}.\n${formatChildOutput(execution)}`);
		}
		const report = Bun.file(reportPath);
		if (!(await report.exists())) {
			throw new Error(`bun test completed without creating its JUnit report at ${reportPath}.\n${formatChildOutput(execution)}`);
		}
		if (report.size > MAX_JUNIT_REPORT_BYTES) {
			throw new Error(`JUnit report at ${reportPath} exceeds the ${MAX_JUNIT_REPORT_BYTES}-byte parser bound.`);
		}

		const counts = parseJunitCounts(await report.text());
		validatePlatformTestPolicy(args.mode, counts, exitCode);
		process.stdout.write(
			`Platform test policy passed for ${args.testFile}: tests=${counts.tests}, failures=${counts.failures}, errors=${counts.errors}, skipped=${counts.skipped}.\n`,
		);
	} catch (error) {
		const detail = toError(error).message;
		primaryError = new Error(
			execution && !detail.includes("Child stdout:") ? `${detail}\n${formatChildOutput(execution)}` : detail,
		);
	}

	let cleanupError: Error | undefined;
	try {
		await fs.rm(tempDir, { force: true, recursive: true });
	} catch (error) {
		cleanupError = toError(error);
	}

	const combinedError = combinePrimaryAndCleanupErrors(primaryError, cleanupError);
	if (combinedError) throw combinedError;
}

if (import.meta.main) {
	try {
		await verifyPlatformTestPolicy(parsePlatformTestPolicyArguments(process.argv.slice(2)));
	} catch (error) {
		process.stderr.write(`verify-platform-test-policy: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
