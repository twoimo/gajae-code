import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	PLATFORM_SHORTCUT_LABELS_SHOWCASE_ENTRIES,
	PLATFORM_SHORTCUT_LABELS_SHOWCASE_EXPECTED_ENTRY_COUNT,
	type PlatformShortcutLabelsShowcaseEntry,
	renderPlatformShortcutLabelsShowcase,
} from "../test/fixtures/tui/platform-shortcut-labels-showcase";

const CANONICAL_COMMAND =
	"bun packages/coding-agent/scripts/capture-platform-shortcut-labels-showcase.ts --output .gjc/qa/platform-shortcut-labels";
const CAPTURE_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const CAPTURE_TOOL_VERSION = "platform-shortcut-labels-fixture-injected-platform-v1";
const EXPECTED_KEYS = [
	"darwin/composer-idle/80x24/unicode-color",
	"darwin/composer-idle/120x36/unicode-color",
	"darwin/composer-idle/160x48/unicode-color",
	"darwin/composer-busy-effective-queue-remap/80x24/unicode-color",
	"darwin/composer-busy-effective-queue-remap/120x36/unicode-color",
	"darwin/composer-busy-effective-queue-remap/160x48/unicode-color",
	"darwin/status-effective-remap-unbound/80x24/unicode-color",
	"darwin/status-effective-remap-unbound/120x36/unicode-color",
	"darwin/status-effective-remap-unbound/160x48/unicode-color",
	"darwin/welcome-flow/80x24/unicode-color",
	"darwin/welcome-flow/120x36/unicode-color",
	"darwin/welcome-flow/160x48/unicode-color",
	"win32/composer-idle/80x24/unicode-color",
	"win32/composer-idle/120x36/unicode-color",
	"win32/composer-busy-effective-queue-remap/80x24/unicode-color",
	"win32/composer-busy-effective-queue-remap/120x36/unicode-color",
	"win32/status-effective-remap-unbound/80x24/unicode-color",
	"win32/status-effective-remap-unbound/120x36/unicode-color",
	"win32/welcome-flow/80x24/unicode-color",
	"win32/welcome-flow/120x36/unicode-color",
	"linux/composer-idle/80x24/unicode-color",
	"linux/composer-idle/120x36/unicode-color",
	"linux/composer-busy-effective-queue-remap/80x24/unicode-color",
	"linux/composer-busy-effective-queue-remap/120x36/unicode-color",
	"linux/status-effective-remap-unbound/80x24/unicode-color",
	"linux/status-effective-remap-unbound/120x36/unicode-color",
	"linux/welcome-flow/80x24/unicode-color",
	"linux/welcome-flow/120x36/unicode-color",
	"darwin/composer-idle/80x24/ascii-no-color",
	"darwin/composer-busy-effective-queue-remap/80x24/ascii-no-color",
	"darwin/status-effective-remap-unbound/80x24/ascii-no-color",
	"darwin/welcome-flow/80x24/ascii-no-color",
	"darwin/status-effective-remap-unbound/48x36/unicode-color",
	"darwin/welcome-flow/48x36/unicode-color",
] as const;

type ArtifactFile = { path: string; sha256: string; byte_length: number };
type ManifestEntry = {
	key: string;
	platform: string;
	surface: string;
	viewport: { id: string; columns: number; rows: number };
	render_mode: string;
	capture_mode: "fixture-injected-platform";
	files: ArtifactFile[];
};

function usage(): never {
	throw new Error(`Usage: ${CANONICAL_COMMAND}`);
}
function outputPath(args: string[]): string {
	if (args.length !== 2 || args[0] !== "--output" || !args[1]) usage();
	return args[1];
}
function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}
function sha256(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function ansiToHtml(value: string): string {
	const body = escapeHtml(value).replace(/\x1b\[[0-9;]*m/g, "");
	return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><title>Platform shortcut labels showcase</title><style>body{margin:0;background:#110b0b;color:#ffe7dc}pre{margin:0;padding:1em;white-space:pre-wrap;font-family:ui-monospace,monospace;line-height:1.2}</style></head><body><pre>${body}</pre></body></html>\n`;
}
function validateMatrix(entries: readonly PlatformShortcutLabelsShowcaseEntry[]): void {
	if (PLATFORM_SHORTCUT_LABELS_SHOWCASE_EXPECTED_ENTRY_COUNT !== 34)
		throw new Error("Expected showcase entry count must remain 34");
	if (entries.length !== PLATFORM_SHORTCUT_LABELS_SHOWCASE_EXPECTED_ENTRY_COUNT)
		throw new Error(`Showcase matrix changed: expected 34 entries, received ${entries.length}`);
	const actual = entries.map(entry => entry.key);
	if (new Set(actual).size !== actual.length) throw new Error("Showcase matrix contains duplicate entry keys");
	const expected = new Set<string>(EXPECTED_KEYS);
	const missing = EXPECTED_KEYS.filter(key => !actual.includes(key));
	const surplus = actual.filter(key => !expected.has(key));
	if (missing.length || surplus.length || actual.some((key, index) => key !== EXPECTED_KEYS[index]))
		throw new Error(
			`Showcase matrix keys differ; missing=${missing.join(",") || "none"}; surplus=${surplus.join(",") || "none"}`,
		);
}
async function writeArtifact(filePath: string, content: string, outputRoot: string): Promise<ArtifactFile> {
	await Bun.write(filePath, content);
	return {
		path: path.relative(outputRoot, filePath).split(path.sep).join("/"),
		sha256: sha256(content),
		byte_length: Buffer.byteLength(content, "utf8"),
	};
}
async function captureEntry(entry: PlatformShortcutLabelsShowcaseEntry, outputRoot: string): Promise<ManifestEntry> {
	const rendered = await renderPlatformShortcutLabelsShowcase(entry);
	const directory = path.join(outputRoot, entry.platform, entry.surface, entry.viewport.id, entry.renderMode);
	await fs.mkdir(directory, { recursive: true });
	const html = ansiToHtml(rendered.terminalAnsiText);
	const metadata = json({
		schema_version: 1,
		entry_key: entry.key,
		platform: entry.platform,
		viewport: entry.viewport,
		render_mode: entry.renderMode,
		capture_mode: rendered.captureMode,
		platform_provenance: rendered.platformProvenance,
		key_display_context: rendered.keyDisplayContext,
		components: rendered.components,
		capture_timestamp: CAPTURE_TIMESTAMP,
		command_or_replay_source: CANONICAL_COMMAND,
		fixture_source: "packages/coding-agent/test/fixtures/tui/platform-shortcut-labels-showcase.ts",
		tool_version: CAPTURE_TOOL_VERSION,
		terminal: {
			columns: entry.viewport.columns,
			rows: entry.viewport.rows,
			font_rendering_assumptions:
				"Embedded red-claw truecolor theme; HTML uses a monospace terminal fallback stack.",
			wrapping_policy:
				"Real components render at the recorded terminal-cell width; CJK content is retained for width review.",
			ansi_control_semantics:
				"terminal-ansi.txt preserves emitted SGR sequences; terminal.txt strips them; ascii-no-color strips styling only.",
		},
		provenance: {
			platform: "fixture-injected-platform",
			live_capture: false,
			native_platform_claim: entry.platform === "darwin" ? "none (fixture only)" : "none",
		},
		fixed_clock_timestamp: rendered.fixedClockTimestamp,
	});
	const files = await Promise.all([
		writeArtifact(path.join(directory, "terminal.txt"), rendered.terminalText, outputRoot),
		writeArtifact(path.join(directory, "terminal-ansi.txt"), rendered.terminalAnsiText, outputRoot),
		writeArtifact(path.join(directory, "terminal.html"), html, outputRoot),
		writeArtifact(path.join(directory, "metadata.json"), metadata, outputRoot),
	]);
	return {
		key: entry.key,
		platform: entry.platform,
		surface: entry.surface,
		viewport: entry.viewport,
		render_mode: entry.renderMode,
		capture_mode: rendered.captureMode,
		files,
	};
}
async function main(): Promise<void> {
	const root = path.resolve(outputPath(process.argv.slice(2)));
	validateMatrix(PLATFORM_SHORTCUT_LABELS_SHOWCASE_ENTRIES);
	await fs.mkdir(root, { recursive: true });
	const entries: ManifestEntry[] = [];
	for (const entry of PLATFORM_SHORTCUT_LABELS_SHOWCASE_ENTRIES) entries.push(await captureEntry(entry, root));
	const manifest = json({
		schema_version: 1,
		capture_tool: CAPTURE_TOOL_VERSION,
		capture_mode: "fixture-injected-platform",
		command: CANONICAL_COMMAND,
		expected_entry_count: 34,
		entry_count: entries.length,
		ordered_keys: EXPECTED_KEYS,
		provenance: "fixture-injected-platform",
		review_input_file: "visual-review-input.json",
		entries,
	});
	const manifestSha256 = sha256(manifest);
	await Bun.write(path.join(root, "manifest.json"), manifest);
	await Bun.write(
		path.join(root, "visual-review-input.json"),
		json({
			schema_version: 1,
			manifest_sha256: manifestSha256,
			expected_manifest_entries: 34,
			ordered_keys: EXPECTED_KEYS,
			evidence_scope: {
				component_surface: "Real CustomEditor, StatusLineComponent, and WelcomeComponent rendering.",
				operations_boundary: "Fixed clock, in-memory settings, and explicit injected KeyDisplayContext platform.",
				external_effects: "No network, filesystem settings, daemon, or live native platform capture is invoked.",
			},
			review_requirements: [
				"Inspect every recorded key.",
				"Confirm Darwin glyphs and ASCII/no-color variants retain the same labels.",
				"Confirm CJK and terminal-cell width evidence in both 48x36 entries.",
				"Confirm all platform provenance is fixture-injected-platform.",
			],
			required_feature_cases: [
				{
					id: "darwin-composer",
					entry_key: "darwin/composer-idle/80x24/unicode-color",
					focus: "Darwin modifier and Enter glyph labels.",
				},
				{
					id: "effective-remap",
					entry_key: "darwin/status-effective-remap-unbound/80x24/unicode-color",
					focus: "Effective remap and unbound action labels.",
				},
				{ id: "cjk-width", entry_key: "darwin/welcome-flow/48x36/unicode-color", focus: "CJK width and wrapping." },
			],
		}),
	);
	process.stdout.write(
		`Captured ${entries.length} deterministic platform shortcut showcase entries to ${root}\nmanifest.json sha256: ${manifestSha256}\n`,
	);
}
await main();
