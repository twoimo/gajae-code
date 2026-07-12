/**
 * Post-build script: reads the napi-rs generated `index.d.ts`, rewrites
 * TypeScript-only enum declarations to runtime-backed declarations, and writes
 * `native/index.js` from the checked-in ESM loader template.
 *
 * Why explicit ESM exports matter (issue #892):
 *
 * Consumers import named symbols from `@gajae-code/natives`. The native addon
 * loader returns most values dynamically, while napi-rs `#[napi(string_enum)]`
 * emits `const enum` in the .d.ts — a TypeScript-only construct with no JS
 * runtime value. This script renders the ESM loader template and emits one
 * explicit `export const X = …` per public class/function declared in
 * `index.d.ts`, plus literal runtime objects for each enum.
 *
 * Run after `napi build`: `bun packages/natives/scripts/gen-enums.ts`
 */
import * as path from "node:path";

const nativeDir = path.resolve(import.meta.dir, "../native");
const dtsPath = path.join(nativeDir, "index.d.ts");
const jsPath = path.join(nativeDir, "index.js");

const MARKER_START = "// --- generated native exports (do not edit) ---";
const MARKER_END = "// --- end generated native exports ---";

// Match each `export declare const enum Name { ... }` block. The closing `}`
// is matched only at line start (enum bodies are indented).
const CONST_ENUM_RE = /export declare (?:const )?enum (\w+)\s*\{(.*?)\n\}/gs;

// Match `export declare class Name` (signatures or block headers). napi-rs
// always emits these as top-level declarations; we just need the name.
const CLASS_RE = /^export declare class (\w+)/gm;

// Match `export declare function name(...)`. Same shape rationale.
const FUNCTION_RE = /^export declare function (\w+)/gm;

interface EnumExport {
	name: string;
	entries: string[];
}

function collectEnums(dts: string): EnumExport[] {
	const enums: EnumExport[] = [];
	CONST_ENUM_RE.lastIndex = 0;
	for (;;) {
		const match = CONST_ENUM_RE.exec(dts);
		if (match === null) break;
		const name = match[1]!;
		const body = match[2]!;
		const entries: string[] = [];
		for (const line of body.split("\n")) {
			const m = line.match(/^\s*(\w+)\s*=\s*'([^']*)'/) ?? line.match(/^\s*(\w+)\s*=\s*(\d+)/);
			if (m) {
				const rawValue = m[2]!;
				const value = rawValue.match(/^\d+$/) ? rawValue : JSON.stringify(rawValue);
				entries.push(`\t${m[1]}: ${value},`);
			}
		}
		if (entries.length > 0) {
			enums.push({ name, entries });
		}
	}
	return enums;
}

function collectMatches(dts: string, re: RegExp): string[] {
	const names: string[] = [];
	re.lastIndex = 0;
	for (;;) {
		const match = re.exec(dts);
		if (match === null) break;
		names.push(match[1]!);
	}
	return names;
}

function buildGeneratedBlock(dts: string): string {
	const classes = collectMatches(dts, CLASS_RE);
	const functions = collectMatches(dts, FUNCTION_RE);
	const enums = collectEnums(dts);

	if (classes.length === 0 && functions.length === 0 && enums.length === 0) {
		throw new Error("No public symbols found in index.d.ts — check napi build output");
	}

	const lines: string[] = [];
	if (classes.length > 0) {
		lines.push("// classes");
		for (const name of classes) {
			lines.push(`export const ${name} = nativeBindings.${name};`);
		}
	}
	if (functions.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("// functions");
		for (const name of functions) {
			lines.push(`export const ${name} = nativeBindings.${name};`);
		}
	}
	if (enums.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("// string/numeric enums (napi-rs string_enum produces TS-only const enum)");
		for (const e of enums) {
			lines.push(`export const ${e.name} = {\n${e.entries.join("\n")}\n};`);
		}
	}

	return `${MARKER_START}\n${lines.join("\n")}\n${MARKER_END}`;
}
// N-API accepts one object shape at runtime; only its declarations need the
// command/direct-executable discriminated union that Rust validates at runtime.
const PTY_START_OPTIONS_MARKER_START = "// --- generated PtyStartOptions union (do not edit) ---";
const PTY_START_OPTIONS_MARKER_END = "// --- end generated PtyStartOptions union ---";
const PTY_START_OPTIONS_RE = /^export interface PtyStartOptions \{\n[\s\S]*?^\}$/m;

function assertPtyStartModeFields(declaration: string): void {
	for (const field of ["command", "executable", "args", "shell"]) {
		if (!new RegExp(`^\\s*${field}\\??:`, "m").test(declaration)) {
			throw new Error(`gen-enums: generated PtyStartOptions is missing '${field}'`);
		}
	}
}

function renderPtyStartOptionsUnion(generatedInterface: string): string {
	assertPtyStartModeFields(generatedInterface);
	const generatedOptions = generatedInterface.replace(
		/^export interface PtyStartOptions \{/,
		"interface PtyStartOptionsGenerated {",
	);
	return `${PTY_START_OPTIONS_MARKER_START}
${generatedOptions}
type PtyStartOptionsCommon = Omit<PtyStartOptionsGenerated, "command" | "executable" | "args" | "shell">

export type PtyStartOptions =
  | (PtyStartOptionsCommon & {
      /** Command string to execute through a shell. */
      command: NonNullable<PtyStartOptionsGenerated["command"]>
      /** Direct executable mode is incompatible with command mode. */
      executable?: never
      /** Direct executable arguments are incompatible with command mode. */
      args?: never
      /** Shell binary to use (e.g. "sh", "bash", or an absolute path). */
      shell?: PtyStartOptionsGenerated["shell"]
    })
  | (PtyStartOptionsCommon & {
      /** Shell command mode is incompatible with direct executable mode. */
      command?: never
      /** Executable to invoke directly, without a shell. */
      executable: NonNullable<PtyStartOptionsGenerated["executable"]>
      /** Arguments to pass directly to executable. */
      args?: PtyStartOptionsGenerated["args"]
      /** Shell selection is incompatible with direct executable mode. */
      shell?: never
    })
${PTY_START_OPTIONS_MARKER_END}`;
}

export function rewritePtyStartOptions(dts: string): string {
	const markerStart = dts.indexOf(PTY_START_OPTIONS_MARKER_START);
	const markerEnd = dts.indexOf(PTY_START_OPTIONS_MARKER_END);
	if (markerStart !== -1 || markerEnd !== -1) {
		if (markerStart === -1) {
			throw new Error("gen-enums: generated PtyStartOptions union has an end marker without a start marker");
		}
		if (markerEnd === -1) {
			throw new Error("gen-enums: generated PtyStartOptions union is missing its end marker");
		}
		if (markerEnd < markerStart) {
			throw new Error("gen-enums: generated PtyStartOptions union end marker precedes its start marker");
		}
		if (
			dts.indexOf(PTY_START_OPTIONS_MARKER_START, markerStart + PTY_START_OPTIONS_MARKER_START.length) !== -1 ||
			dts.indexOf(PTY_START_OPTIONS_MARKER_END, markerEnd + PTY_START_OPTIONS_MARKER_END.length) !== -1
		) {
			throw new Error("gen-enums: generated PtyStartOptions union has duplicate markers");
		}
		const generatedDeclaration = dts.slice(markerStart, markerEnd + PTY_START_OPTIONS_MARKER_END.length);
		assertPtyStartModeFields(generatedDeclaration);
		return dts;
	}

	const generatedInterface = dts.match(PTY_START_OPTIONS_RE)?.[0];
	if (generatedInterface === undefined) {
		throw new Error("gen-enums: generated index.d.ts is missing PtyStartOptions");
	}
	return dts.replace(generatedInterface, renderPtyStartOptionsUnion(generatedInterface));
}

export async function generateEnumExports(): Promise<void> {
	const dts = await Bun.file(dtsPath).text();
	const existing = await Bun.file(jsPath).text();
	const generatedBlock = buildGeneratedBlock(dts);

	// Patch the generated block in place. `native/index.js` is the hand-edited
	// loader; only the block between MARKER_START and MARKER_END is owned by
	// this script. The markers are committed to disk so the patch is purely
	// content replacement — no scaffold, no template file.
	const blockStart = existing.indexOf(MARKER_START);
	const blockEnd = existing.indexOf(MARKER_END);
	if (blockStart === -1 || blockEnd === -1 || blockEnd < blockStart) {
		throw new Error(
			`gen-enums: ${jsPath} is missing the generated marker block. ` +
				`Add\n\n${MARKER_START}\n${MARKER_END}\n\nplaceholders before running.`,
		);
	}
	const js = existing.slice(0, blockStart) + generatedBlock + existing.slice(blockEnd + MARKER_END.length);

	await Bun.write(jsPath, js);

	// Also fix the .d.ts: replace `const enum` with `enum` so TS allows
	// assigning string literals to enum types without casts, then turn the
	// N-API PTY object declaration into an exact command/direct-executable union.
	const constEnumCount = (dts.match(/export (?:declare )?const enum/g) ?? []).length;
	const dtsContent = rewritePtyStartOptions(
		dts
			.replaceAll("export const enum", "export declare enum")
			.replaceAll("export declare const enum", "export declare enum"),
	);
	await Bun.write(dtsPath, dtsContent);

	const symbolCount = (generatedBlock.match(/^export const /gm) ?? []).length;
	console.log(
		`Generated ${symbolCount} explicit ESM exports, fixed ${constEnumCount} const enums, and regenerated PtyStartOptions.`,
	);
}

if (import.meta.main) {
	await generateEnumExports();
}
