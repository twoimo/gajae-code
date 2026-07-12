#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import ts from "typescript";

export const SMOKE_CASES = ["help", "session", "web-search", "browser-worker", "manifest"] as const;
export type SmokeCase = (typeof SMOKE_CASES)[number];
export const DYNAMIC_IMPORT_PROBES = ["load", "resolve-only", "handshake"] as const;
export type DynamicImportProbe = (typeof DYNAMIC_IMPORT_PROBES)[number];


export interface DynamicImportException {
	importer: string;
	target: string;
	reason: string;
	smokeCase: SmokeCase;
	owner: string;
	probe: DynamicImportProbe;
}

export interface DynamicImportOccurrence {
	importer: string;
	target: string;
	line: number;
}

const DEFAULT_ROOTS = ["packages/coding-agent/src", "packages/ai/src"];
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;

async function collectSourceFiles(root: string): Promise<string[]> {
	const stat = await fs.stat(root);
	if (stat.isFile()) return SOURCE_EXTENSION.test(root) ? [root] : [];
	const files: string[] = [];
	for (const entry of await fs.readdir(root, { withFileTypes: true })) {
		const child = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await collectSourceFiles(child)));
		else if (SOURCE_EXTENSION.test(entry.name)) files.push(child);
	}
	return files;
}

function describeTarget(node: ts.Expression | undefined, sourceFile: ts.SourceFile): string {
	if (node && ts.isStringLiteralLike(node)) return node.text;
	return `expression:${node?.getText(sourceFile).replace(/\s+/g, " ") ?? "<missing>"}`;
}

export async function scanDynamicImports(repoRoot: string, roots = DEFAULT_ROOTS): Promise<DynamicImportOccurrence[]> {
	const files = (await Promise.all(roots.map(root => collectSourceFiles(path.resolve(repoRoot, root))))).flat().sort();
	const occurrences: DynamicImportOccurrence[] = [];
	for (const file of files) {
		const text = await Bun.file(file).text();
		const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				occurrences.push({
					importer: path.relative(repoRoot, file).split(path.sep).join("/"),
					target: describeTarget(node.arguments[0], sourceFile),
					line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
				});
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return occurrences;
}

export async function readDynamicImportManifest(manifestPath: string): Promise<DynamicImportException[]> {
	const parsed: unknown = await Bun.file(manifestPath).json();
	if (!Array.isArray(parsed)) throw new Error("Dynamic-import manifest must be a JSON array");
	return parsed as DynamicImportException[];
}

function occurrenceKey(value: Pick<DynamicImportOccurrence, "importer" | "target">): string {
	return `${value.importer}\0${value.target}`;
}



export function validateDynamicImportPolicy(
	occurrences: DynamicImportOccurrence[],
	exceptions: DynamicImportException[],
): string[] {
	const errors: string[] = [];
	const remaining = new Map<string, number>();
	for (const occurrence of occurrences) {
		const key = occurrenceKey(occurrence);
		remaining.set(key, (remaining.get(key) ?? 0) + 1);
	}
	// A handshake validates a loaded target, not a particular syntactic occurrence. Duplicate
	// occurrences may share that probe only when every manifest entry for the importer/target
	// pair declares the same handshake coverage.
	const probesByTarget = new Map<string, Set<DynamicImportProbe>>();
	for (const exception of exceptions) {
		const key = occurrenceKey(exception);
		const probes = probesByTarget.get(key) ?? new Set<DynamicImportProbe>();
		probes.add(exception.probe);
		probesByTarget.set(key, probes);
	}
	for (const [key, probes] of probesByTarget) {
		if (probes.has("handshake") && probes.size > 1) {
			const [importer, target] = key.split("\0");
			errors.push(`Handshake coverage must be target-level for ${importer} -> ${target}`);
		}
	}
	for (const [index, exception] of exceptions.entries()) {
		if (!exception.importer || !exception.target || !exception.reason || !exception.owner || !exception.probe) {
			errors.push(`Manifest entry ${index + 1} is missing a required field`);
			continue;
		}
		if (!SMOKE_CASES.includes(exception.smokeCase)) {
			errors.push(`Manifest entry ${index + 1} has invalid smokeCase: ${exception.smokeCase}`);
		}
		if (!DYNAMIC_IMPORT_PROBES.includes(exception.probe)) {
			errors.push(`Manifest entry ${index + 1} has invalid probe: ${exception.probe}`);
		}
		if (exception.probe === "handshake" && exception.smokeCase !== "browser-worker") {
			errors.push(`Manifest entry ${index + 1} handshake probe must use browser-worker smokeCase`);
		}
		const key = occurrenceKey(exception);
		const count = remaining.get(key) ?? 0;
		if (count === 0) errors.push(`Stale manifest entry: ${exception.importer} -> ${exception.target}`);
		else remaining.set(key, count - 1);
	}
	for (const occurrence of occurrences) {
		const key = occurrenceKey(occurrence);
		const count = remaining.get(key) ?? 0;
		if (count > 0) {
			errors.push(`Unlisted dynamic import: ${occurrence.importer}:${occurrence.line} -> ${occurrence.target}`);
			remaining.set(key, count - 1);
		}
	}
	return errors;
}

export async function checkDynamicImportPolicy(options?: {
	repoRoot?: string;
	manifestPath?: string;
	roots?: string[];
}): Promise<{ occurrences: DynamicImportOccurrence[]; exceptions: DynamicImportException[] }> {
	const repoRoot = options?.repoRoot ?? path.resolve(import.meta.dir, "..");
	const manifestPath = options?.manifestPath ?? path.join(repoRoot, "scripts/dynamic-import-exceptions.json");
	const [occurrences, exceptions] = await Promise.all([
		scanDynamicImports(repoRoot, options?.roots),
		readDynamicImportManifest(manifestPath),
	]);
	const errors = validateDynamicImportPolicy(occurrences, exceptions);
	if (errors.length > 0) throw new Error(errors.join("\n"));
	return { occurrences, exceptions };
}

if (import.meta.main) {
	const { occurrences } = await checkDynamicImportPolicy();
	process.stdout.write(`PASS dynamic-import policy (${occurrences.length} exceptions)\n`);
}
