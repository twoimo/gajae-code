#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	Editor,
	Image,
	ImageProtocol,
	Markdown,
	setKittyTransmitWriter,
	setTerminalImageProtocol,
	TERMINAL,
	TUI,
	type Component,
	type Terminal,
	type TerminalAppearance,
	type ViewportRowComponent,
	clearImageProtocolCache,
	clearRenderCache,
	createImageSource,
	getImageProtocolCacheAudit,
	getRenderCacheRetainedBytes,
	resetKittyTransmissions,
} from "@gajae-code/tui";
import { RetainedMemoryRegistry } from "@gajae-code/utils/retained-memory";
import { TranscriptContainer } from "../packages/coding-agent/src/modes/components/transcript-container";

const MEBIBYTE = 1024 * 1024;
const WARMUPS = 2;
const RUNS = 5;

const repoRoot = path.join(import.meta.dir, "..");
const baselinePath = path.join(import.meta.dir, "tui-retention-baseline.json");

export type TuiRetentionGate = { name: string; actual: number; limit: number; pass: boolean };
export type TuiRetentionGateInput = {
	documentBytes: number;
	undoBytes: number;
	editP95Ms: number;
	frameP95Ms: number;
	frameAllocationBytes: number;
	fullTranscriptAllocationBaselineBytes: number;
	frameGrowthPercent: number;
	markdownRegisteredBytes: number;
	uniqueImageBytes: number;
	duplicateImageOwnershipBytes: number;
	terminalProtocolCacheBytes: number;
};

	type FrameMeasurement = { p95Ms: number; allocationBytes: number; viewportRetainedBytes: number; dirtyWriteBytes: number };

type TuiRetentionMeasurements = {
	editor: { documentBytes: number; undoBytes: number; editP95Ms: number };
	tenK: FrameMeasurement;
	hundredK: FrameMeasurement;
	markdownRegisteredBytes: number;
	images: { uniqueImageBytes: number; duplicateImageOwnershipBytes: number; terminalProtocolCacheBytes: number };
};
type Corpus = {
	name: "full" | "fast";
	documentBytes: number;
	edits: number;
	markdownTokens: number;
	tenKLines: number;
	hundredKLines: number;
	imageCount: number;
	imageBytes: number;
};
type Baseline = { fixtureHash: string; fullTranscriptAllocationBaselineBytes: number; reviewNote: string };
type BaselineFile = { schemaVersion: number; baselines: Record<string, Baseline> };

const fullCorpus: Corpus = {
	name: "full", documentBytes: MEBIBYTE, edits: 10_000, markdownTokens: 10_000,
	tenKLines: 10_000, hundredKLines: 100_000, imageCount: 20, imageBytes: 5 * MEBIBYTE,
};
const fastCorpus: Corpus = {
	name: "fast", documentBytes: 256 * 1024, edits: 2_000, markdownTokens: 2_000,
	tenKLines: 2_000, hundredKLines: 10_000, imageCount: 4, imageBytes: MEBIBYTE,
};

export function percentile95(values: readonly number[]): number {
	if (values.length === 0) throw new Error("Cannot calculate p95 of an empty sample.");
	return [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1]!;
}

export function evaluateTuiRetentionGates(input: TuiRetentionGateInput): TuiRetentionGate[] {
	const gate = (name: string, actual: number, limit: number): TuiRetentionGate => ({ name, actual, limit, pass: actual <= limit });
	return [
		gate("editor undo", input.undoBytes, 2 * input.documentBytes + 16 * MEBIBYTE),
		gate("edit p95", input.editP95Ms, 20),
		gate("frame p95", input.frameP95Ms, 16),
		gate("allocs/frame", input.frameAllocationBytes, input.fullTranscriptAllocationBaselineBytes * 0.25),
		gate("10K->100K off-screen frame-time growth", input.frameGrowthPercent, 10),
		gate("markdown registered", input.markdownRegisteredBytes, 32 * MEBIBYTE),
		gate("duplicate image ownership", input.duplicateImageOwnershipBytes, input.uniqueImageBytes * 0.05),
		gate("terminal protocol cache", input.terminalProtocolCacheBytes, 32 * MEBIBYTE),
	];
}

export function tuiRetentionStatus(gates: readonly TuiRetentionGate[]): "passed" | "failed" {
	return gates.every(gate => gate.pass) ? "passed" : "failed";
}

export function fixtureHash(corpus: Corpus = fullCorpus): string {
	const descriptor = `tui-retention-v2:${corpus.name}:editor=${corpus.documentBytes}/${corpus.edits};markdown=${corpus.markdownTokens};transcript=${corpus.tenKLines}/${corpus.hundredKLines}@80x24;images=${corpus.imageCount}x${corpus.imageBytes}`;
	return new Bun.SHA256().update(descriptor).digest("hex");
}

/** Resolves a platform-specific baseline, bootstrapping only when its entry is absent. */
export function baselineCheckMode(file: BaselineFile, corpus: Corpus = fullCorpus, platform = process.platform, arch = process.arch): { key: string; baseline?: Baseline } {
	if (file.schemaVersion !== 3 || !file.baselines || typeof file.baselines !== "object" || Array.isArray(file.baselines)) {
		throw new Error("Invalid tui retention baseline schema; --check fails closed.");
	}
	const key = `${platform}-${arch}:${corpus.name}`;
	if (!Object.hasOwn(file.baselines, key)) return { key };
	const baseline = file.baselines[key];
	if (!baseline || baseline.fixtureHash !== fixtureHash(corpus) || baseline.fullTranscriptAllocationBaselineBytes <= 0 || !baseline.reviewNote) {
		throw new Error(`Mismatched or stale tui retention baseline for ${key}; --check fails closed.`);
	}
	return { key, baseline };
}

/** Rejects a checked report from another operating system or CPU architecture. */
export function checkedBaseline(file: BaselineFile, corpus: Corpus = fullCorpus, platform = process.platform, arch = process.arch): Baseline {
	const { baseline, key } = baselineCheckMode(file, corpus, platform, arch);
	if (!baseline) throw new Error(`Missing tui retention baseline for ${key}; --check fails closed.`);
	return baseline;
}

export function baselineBootstrapNotice(platform = process.platform, arch = process.arch): string {
	return `baseline-bootstrap: no checked baseline for ${platform}-${arch}, uploading measured values for review`;
}

export function retentionCheckExitCode(check: boolean, status: "passed" | "failed", bootstrapping: boolean): number {
	return check && !bootstrapping && status !== "passed" ? 1 : 0;
}

const identity = (text: string) => text;
const symbols = { cursor: ">", inputCursor: "|", quoteBorder: "|", hrChar: "-", spinnerFrames: ["-"], boxRound: { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|" }, boxSharp: { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|", teeDown: "+", teeUp: "+", teeLeft: "+", teeRight: "+", cross: "+" }, table: { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|", teeDown: "+", teeUp: "+", teeLeft: "+", teeRight: "+", cross: "+" } };
const editorTheme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity, symbols }, symbols };
const markdownTheme = { heading: identity, link: identity, linkUrl: identity, code: identity, codeBlock: identity, codeBlockBorder: identity, quote: identity, quoteBorder: identity, hr: identity, listBullet: identity, bold: identity, italic: identity, strikethrough: identity, underline: identity, symbols };

class RetentionTerminal implements Terminal {
	columns = 80;
	rows = 24;
	available = true;
	kittyProtocolActive = false;
	appearance: TerminalAppearance | undefined;
	writtenBytes = 0;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void { this.writtenBytes += Buffer.byteLength(data); }
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
}




/** A realistic row-addressable transcript message: one retained component per logical row. */
class TranscriptLine implements ViewportRowComponent {
	readonly #text: string;
	constructor(index: number) { this.#text = `transcript ${index.toString().padStart(6, "0")} ${"x".repeat(58)}`; }
	getLogicalRowCount(): number { return 1; }
	renderRows(_width: number, start: number, end: number): string[] { return start === 0 && end > 0 ? [this.#text] : []; }
	render(width: number): string[] { return this.renderRows(width, 0, 1); }
	invalidate(): void {}
	readonly rowCountIsWidthInvariant = true;
}


/** Full-transcript source used to exercise the legacy materialization path. */
class LegacyTranscript implements Component {
	#lines: string[];
	#tui: TUI;
	constructor(tui: TUI, lines: number) {
		this.#tui = tui;
		this.#lines = Array.from({ length: lines }, (_value, index) => `transcript ${index.toString().padStart(6, "0")} ${"x".repeat(58)}`);
	}
	setLastFrame(frame: number): void { this.#lines[this.#lines.length - 1] = `transcript ${String(frame).padStart(6, "0")} ${"x".repeat(58)}`; }
	invalidate(): void {}
	render(_width: number): string[] {
		const rows = this.#lines.slice();
		this.#tui.recordFrameAllocationRowArray(rows);
		return rows;
	}
}




function makeDocument(bytes: number): string { return `${"a".repeat(bytes - 1)}\n`; }

function measureEditor(corpus: Corpus): TuiRetentionMeasurements["editor"] {
	const editor = new Editor(editorTheme);
	editor.setText(makeDocument(corpus.documentBytes));
	for (let index = 0; index < corpus.edits; index++) editor.insertText(String.fromCharCode(97 + (index % 26)));
	const timings: number[] = [];
	for (let index = 0; index < WARMUPS + RUNS; index++) {
		const started = performance.now();
		editor.insertText("x");
		if (index >= WARMUPS) timings.push(performance.now() - started);
	}
	const counters = editor.getRetainedMemoryCounters();
	editor.dispose();
	return { documentBytes: counters.documentBytes, undoBytes: counters.undoBytes, editP95Ms: percentile95(timings) };
}

/** Measure TUI's deterministic, complete frame-allocation counter. */
async function measureFrameAllocation(
	renderFrame: () => Promise<number>,
	timings: number[],
): Promise<number> {
	for (let index = 0; index < WARMUPS; index++) await renderFrame();
	const samples: number[] = [];
	for (let sample = 0; sample < RUNS; sample++) {
		const started = performance.now();
		const allocationBytes = await renderFrame();
		timings.push(performance.now() - started);
		samples.push(allocationBytes);
	}
	const allocationBytes = samples[0] ?? 0;
	if (samples.some(sample => sample !== allocationBytes)) {
		throw new Error(`Frame allocation counter was non-deterministic: ${samples.join(", ")}`);
	}
	return allocationBytes;
}

async function measureFrame(lines: number): Promise<FrameMeasurement> {
	const terminal = new RetentionTerminal();
	const tui = new TUI(terminal);
	const transcript = new TranscriptContainer();
	for (let index = 0; index < lines; index++) transcript.addChild(new TranscriptLine(index));

	const registry = new RetainedMemoryRegistry();
	const registrations = tui.registerRetainedMemory(registry);
	tui.addChild(transcript);
	tui.start();
	// Build the production row index and initial viewport outside the steady-state sample.
	await Bun.sleep(100);
	const dirtyLine = transcript.children.at(-1);

	if (!dirtyLine) throw new Error("Retention transcript did not populate.");
	const timings: number[] = [];
	let viewportRetainedBytes = 0;
	let dirtyWriteBytes = 0;

	const allocationBytes = await measureFrameAllocation(async () => {
		const writesBefore = terminal.writtenBytes;
		transcript.markChildDirty(dirtyLine);
		tui.requestRender(false, "input");
		const renderComplete = Promise.withResolvers<void>();
		process.nextTick(renderComplete.resolve);
		await renderComplete.promise;
		dirtyWriteBytes = Math.max(dirtyWriteBytes, terminal.writtenBytes - writesBefore);
		const pool = registry.sample().pools.find(entry => entry.id === "tui.viewport-frame");
		viewportRetainedBytes = Math.max(viewportRetainedBytes, pool?.buckets.frame ?? 0);
		return tui.getLastFrameAllocationBytes();
	}, timings);




	for (const registration of registrations) registration.dispose();
	tui.stop();
	tui.dispose();
	return { p95Ms: percentile95(timings), allocationBytes, viewportRetainedBytes, dirtyWriteBytes };

}

async function measureLegacyFullTranscriptFrame(lines: number): Promise<number> {
	const priorVirtualViewport = Bun.env.PI_TUI_VIRTUAL_VIEWPORT;
	Bun.env.PI_TUI_VIRTUAL_VIEWPORT = "0";
	try {
		const terminal = new RetentionTerminal();
		const tui = new TUI(terminal);
		const transcript = new LegacyTranscript(tui, lines);

		tui.addChild(transcript);
		tui.start();
		await Bun.sleep(25);
		let frame = 0;
		const allocationBytes = await measureFrameAllocation(async () => {
			transcript.setLastFrame(frame++);
			tui.requestRender(false, "input");
			const renderComplete = Promise.withResolvers<void>();
			process.nextTick(renderComplete.resolve);
			await renderComplete.promise;
			return tui.getLastFrameAllocationBytes();
		}, []);
		tui.stop();
		tui.dispose();
		return allocationBytes;
	} finally {
		if (priorVirtualViewport === undefined) delete Bun.env.PI_TUI_VIRTUAL_VIEWPORT;
		else Bun.env.PI_TUI_VIRTUAL_VIEWPORT = priorVirtualViewport;
	}
}


function measureMarkdown(corpus: Corpus): number {
	clearRenderCache();
	const markdown = new Markdown("", 0, 0, markdownTheme);
	let stream = "";
	for (let token = 0; token < corpus.markdownTokens; token++) {
		stream += `token-${token} `;
		markdown.setText(stream, { streaming: true });
		if (token % 256 === 0) markdown.render(80);
	}
	markdown.setText(stream, { streaming: false });
	markdown.render(80);
	return getRenderCacheRetainedBytes();
}

async function measureImages(corpus: Corpus): Promise<TuiRetentionMeasurements["images"]> {
	clearImageProtocolCache();
	resetKittyTransmissions();
	const priorProtocol = TERMINAL.imageProtocol;
	setTerminalImageProtocol(ImageProtocol.Kitty);
	setKittyTransmitWriter(() => {});
	try {
		const imageTheme = { fallbackColor: identity };
		const components: Component[] = [];
		for (let index = 0; index < corpus.imageCount; index++) {
			const data = Buffer.alloc(corpus.imageBytes, index).toString("base64");
			const source = createImageSource(data, "image/png", { widthPx: 800, heightPx: 600 }, `retention-${index}`);
			components.push(new Image(source, "image/png", imageTheme, {}, { widthPx: 800, heightPx: 600 }));
		}
		for (const component of components) component.render(80);
		const audit = getImageProtocolCacheAudit();
		for (const component of components) component.dispose?.();
		return {
			uniqueImageBytes: audit.uniqueSourceBytes,
			duplicateImageOwnershipBytes: audit.duplicatedRetainedBytes,
			terminalProtocolCacheBytes: audit.protocolBytes + audit.decodeConversionBytes + audit.kittyTransmissionMetadataBytes,
		};
	} finally {
		setTerminalImageProtocol(priorProtocol);
		setKittyTransmitWriter(sequence => process.stdout.write(sequence));
	}
}

async function collectMeasurements(corpus: Corpus): Promise<TuiRetentionMeasurements & { fullTranscriptAllocationBaselineBytes: number }> {
	const editor = measureEditor(corpus);
	const tenK = await measureFrame(corpus.tenKLines);
	const hundredK = await measureFrame(corpus.hundredKLines);
	const fullTranscriptAllocationBaselineBytes = await measureLegacyFullTranscriptFrame(corpus.hundredKLines);
	const markdownRegisteredBytes = measureMarkdown(corpus);
	const images = await measureImages(corpus);
	return { editor, tenK, hundredK, fullTranscriptAllocationBaselineBytes, markdownRegisteredBytes, images };
}

async function runChild(corpus: Corpus): Promise<TuiRetentionMeasurements & { fullTranscriptAllocationBaselineBytes: number }> {

	const proc = Bun.spawn([process.execPath, import.meta.path, "--child", ...(corpus.name === "fast" ? ["--fast"] : [])], { stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	if (exitCode !== 0) throw new Error(`TUI retention child failed (${exitCode}): ${stderr}`);
	try { return JSON.parse(stdout) as TuiRetentionMeasurements & { fullTranscriptAllocationBaselineBytes: number }; }
	catch { throw new Error(`TUI retention child returned invalid JSON: ${stdout}`); }
}

async function main(): Promise<void> {
	const fast = process.argv.includes("--fast");
	const corpus = fast ? fastCorpus : fullCorpus;
	if (process.argv.includes("--child")) {
		console.log(JSON.stringify(await collectMeasurements(corpus)));
		return;
	}
	const check = process.argv.includes("--check");
	const baselineMode = baselineCheckMode(await Bun.file(baselinePath).json() as BaselineFile, corpus);
	const { editor, tenK, hundredK, fullTranscriptAllocationBaselineBytes, markdownRegisteredBytes, images } = await runChild(corpus);
	const wouldBeBaseline: Baseline = {
		fixtureHash: fixtureHash(corpus),
		fullTranscriptAllocationBaselineBytes,
		reviewNote: `Measured on ${process.platform}-${process.arch}; review this captured value before committing it as a checked baseline.`,
	};
	const baseline = baselineMode.baseline ?? wouldBeBaseline;
	const frameGrowthPercent = Math.max(0, ((hundredK.p95Ms - tenK.p95Ms) / Math.max(tenK.p95Ms, 0.001)) * 100);
	const gates = evaluateTuiRetentionGates({ ...editor, frameP95Ms: hundredK.p95Ms, frameAllocationBytes: hundredK.allocationBytes, fullTranscriptAllocationBaselineBytes: baseline.fullTranscriptAllocationBaselineBytes, frameGrowthPercent, markdownRegisteredBytes, ...images });
	const status = tuiRetentionStatus(gates);
	const bootstrapping = baselineMode.baseline === undefined;
	const artifact = { schemaVersion: 3, measuredAt: new Date().toISOString(), platform: process.platform, arch: process.arch, bun: Bun.version, corpus: corpus.name, fixtureHash: fixtureHash(corpus), warmups: WARMUPS, runs: RUNS, baseline: baselineMode.baseline, wouldBeBaseline, measuredFullTranscriptAllocationBaselineBytes: fullTranscriptAllocationBaselineBytes, editor, frames: { tenK, hundredK, frameGrowthPercent }, markdownRegisteredBytes, images, gates, status };
	await fs.mkdir(path.join(repoRoot, "artifacts"), { recursive: true });
	await Bun.write(path.join(repoRoot, `artifacts/tui-retention-${process.platform}-${process.arch}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
	if (bootstrapping) console.log(baselineBootstrapNotice());
	console.log(`TUI retention ${process.platform}-${process.arch}: ${status}\n${gates.map(gate => `${gate.name}: ${gate.pass ? "pass" : "fail"} (${gate.actual} <= ${gate.limit})`).join("\n")}`);
	process.exitCode = retentionCheckExitCode(check, status, bootstrapping);
}

if (import.meta.main) await main();
