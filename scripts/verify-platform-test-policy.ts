import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type ExpectedPlatformTestMode = "skipped" | "executed";

export interface JunitCounts {
	tests: number;
	failures: number;
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
const JUNIT_COUNT_ATTRIBUTES = ["tests", "failures", "skipped"] as const;

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

function validateXmlText(value: string): void {
	if (value.includes("]]>")) {
		throw new Error("JUnit XML text contains the forbidden ]]> sequence.");
	}
	validateXmlCharacters(value, "XML text");
	validateXmlEntities(value, "XML text");
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

function validateXmlEntities(value: string, context: string): void {
	let cursor = 0;
	while (cursor < value.length) {
		const entityStart = value.indexOf("&", cursor);
		if (entityStart === -1) return;

		const entityEnd = value.indexOf(";", entityStart + 1);
		if (entityEnd === -1) {
			throw new Error(`JUnit ${context} contains an unterminated XML entity reference.`);
		}

		const entity = value.slice(entityStart + 1, entityEnd);
		if (/^(?:amp|apos|gt|lt|quot)$/.test(entity)) {
			cursor = entityEnd + 1;
			continue;
		}

		const numeric = entity.match(/^#(?:(\d+)|x([0-9A-Fa-f]+))$/);
		if (numeric) {
			const codePoint = Number.parseInt(numeric[1] ?? numeric[2] ?? "", numeric[1] ? 10 : 16);
			if (Number.isSafeInteger(codePoint) && isLegalXmlCharacter(codePoint)) {
				cursor = entityEnd + 1;
				continue;
			}
		}

		throw new Error(`JUnit ${context} contains an invalid XML entity reference.`);
	}
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
		validateXmlEntities(value, `<${elementName}> attribute ${name}`);
		if (values.has(name)) {
			throw new Error(`JUnit <${elementName}> contains duplicate ${name} attributes.`);
		}
		values.set(name, value);
		cursor = valueEnd + 1;
	}

	return values;
}

function parseCountAttributes(attributes: string): Map<string, string> {
	return parseXmlAttributes(attributes, "testsuites");
}

function parseCountAttribute(attributes: Map<string, string>, name: (typeof JUNIT_COUNT_ATTRIBUTES)[number]): number {
	const value = attributes.get(name);
	if (value === undefined) {
		throw new Error(`JUnit <testsuites> root must contain exactly one ${name} attribute.`);
	}
	if (!/^\d+$/.test(value)) {
		throw new Error(`JUnit <testsuites> ${name} attribute must be a non-negative integer, received ${JSON.stringify(value)}.`);
	}

	const count = Number(value);
	if (!Number.isSafeInteger(count)) {
		throw new Error(`JUnit <testsuites> ${name} attribute must be a safe integer, received ${JSON.stringify(value)}.`);
	}
	return count;
}

function findXmlTagEnd(report: string, start: number): number {
	let quote: string | undefined;
	for (let index = start + 1; index < report.length; index += 1) {
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
	throw new Error("JUnit report contains an incomplete XML tag.");
}
function findXmlCommentEnd(report: string, start: number): number {
	for (let index = start + 4; index < report.length; index += 1) {
		if (report[index] !== "-" || report[index + 1] !== "-") continue;
		const terminator = report[index + 2];
		if (terminator === ">") return index;
		if (terminator === undefined) break;
		throw new Error("JUnit report contains a malformed XML comment.");
	}
	throw new Error("JUnit report contains an incomplete XML comment.");
}

function validateCompleteTestsuitesDocument(report: string): string {
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
	parseXmlAttributes(rootContents.slice("testsuites".length), "testsuites");

	const stack = ["testsuites"];
	let cursor = rootEnd + 1;
	while (stack.length > 0) {
		const nextTag = report.indexOf("<", cursor);
		if (nextTag === -1) {
			throw new Error("JUnit report contains an incomplete XML document.");
		}
		validateXmlText(report.slice(cursor, nextTag));
		cursor = nextTag;

		if (report.startsWith("<!--", cursor)) {
			const end = findXmlCommentEnd(report, cursor);
			const content = report.slice(cursor + 4, end);
			validateXmlCharacters(content, "XML comment");
			cursor = end + 3;
			continue;
		}
		if (report.startsWith("<![CDATA[", cursor)) {
			const end = report.indexOf("]]>", cursor + 9);
			if (end === -1) throw new Error("JUnit report contains an incomplete CDATA section.");
			const content = report.slice(cursor + 9, end);
			validateXmlCharacters(content, "CDATA section");
			cursor = end + 3;
			continue;
		}
		if (report.startsWith("<?", cursor)) {
			const end = report.indexOf("?>", cursor + 2);
			if (end === -1) throw new Error("JUnit report contains an incomplete XML processing instruction.");
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
			const expectedName = stack.pop();
			if (!closingName || !isOnlyXmlWhitespace(closingWhitespace) || closingName !== expectedName) {
				throw new Error(`JUnit XML close tag </${closingContents}> does not match expected </${expectedName}>.`);
			}
			continue;
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
		parseXmlAttributes(openingTag.slice(name.length), name);
		if (!selfClosing) stack.push(name);
	}

	if (!/^[\x20\x09\x0a\x0d]*$/.test(report.slice(cursor))) {
		throw new Error("JUnit report must contain exactly one complete <testsuites> root document.");
	}
	return rootTag.slice("<testsuites".length, -1);
}

export function parseJunitCounts(report: string): JunitCounts {
	const attributes = validateCompleteTestsuitesDocument(report);
	const values = parseCountAttributes(attributes);

	return {
		tests: parseCountAttribute(values, "tests"),
		failures: parseCountAttribute(values, "failures"),
		skipped: parseCountAttribute(values, "skipped"),
	};
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

		const counts = parseJunitCounts(await report.text());
		validatePlatformTestPolicy(args.mode, counts, exitCode);
		process.stdout.write(
			`Platform test policy passed for ${args.testFile}: tests=${counts.tests}, failures=${counts.failures}, skipped=${counts.skipped}.\n`,
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
