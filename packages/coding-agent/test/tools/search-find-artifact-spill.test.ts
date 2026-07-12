import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { Settings } from "../../src/config/settings";
import { ArtifactManager } from "../../src/session/artifacts";
import { SessionManager } from "../../src/session/session-manager";
import { DEFAULT_ARTIFACT_MAX_BYTES } from "../../src/session/streaming-output";
import type { ToolSession } from "../../src/tools";
import { FindTool } from "../../src/tools/find";
import { wrapToolWithMetaNotice } from "../../src/tools/output-meta";
import { SearchTool } from "../../src/tools/search";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "search.contextBefore": 0, "search.contextAfter": 0 }),
	} as unknown as ToolSession;
}

function createContext(cwd: string, artifacts: ArtifactManager): AgentToolContext {
	const sessionManager = SessionManager.inMemory(cwd);
	sessionManager.adoptArtifactManager(artifacts);
	return {
		sessionManager,
		settings: Settings.isolated({
			"tools.artifactSpillThreshold": 1,
			"tools.artifactHeadBytes": 1,
			"tools.artifactTailBytes": 1,
			"tools.maxInlineResultBytes": 0,
		}),
		toolNames: ["search", "find"],
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	} as unknown as AgentToolContext;
}

describe("search/find artifact spill", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "search-find-spill-"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("spills Search's pre-inline-truncation raw output", async () => {
		const searchDir = path.join(tempDir, "search");
		await fs.mkdir(searchDir);
		const line = `needle ${"x".repeat(2_000)}\n`;
		for (let file = 0; file < 20; file++) {
			await Bun.write(path.join(searchDir, `${String(file).padStart(2, "0")}.txt`), line.repeat(20));
		}

		const params = { pattern: "needle", paths: [searchDir] };
		const raw = textOf(await new SearchTool(createSession(tempDir)).execute("raw-search", params));
		expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(50 * 1024);
		expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(DEFAULT_ARTIFACT_MAX_BYTES);

		const artifacts = new ArtifactManager(path.join(tempDir, "search-artifacts"));
		const result = await wrapToolWithMetaNotice(new SearchTool(createSession(tempDir))).execute(
			"spill-search",
			params,
			undefined,
			undefined,
			createContext(tempDir, artifacts),
		);
		const artifactId = result.details?.meta?.truncation?.artifactId;
		expect(artifactId).toBeString();
		const artifactPath = await artifacts.getPath(artifactId!);
		expect(await Bun.file(artifactPath!).text()).toBe(raw);
		expect(Buffer.byteLength(textOf(result), "utf8")).toBeLessThan(Buffer.byteLength(raw, "utf8"));
	});

	it("spills Find's pre-inline-truncation raw output", async () => {
		const findDir = path.join(tempDir, "find");
		await fs.mkdir(findDir);
		for (let file = 0; file < 600; file++) {
			await Bun.write(path.join(findDir, `${String(file).padStart(4, "0")}-${"x".repeat(100)}.txt`), "");
		}

		const params = { paths: ["find/**/*.txt"], limit: 600 };
		const raw = textOf(await new FindTool(createSession(tempDir)).execute("raw-find", params));
		expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(50 * 1024);
		expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(DEFAULT_ARTIFACT_MAX_BYTES);

		const artifacts = new ArtifactManager(path.join(tempDir, "find-artifacts"));
		const result = await wrapToolWithMetaNotice(new FindTool(createSession(tempDir))).execute(
			"spill-find",
			params,
			undefined,
			undefined,
			createContext(tempDir, artifacts),
		);
		const artifactId = result.details?.meta?.truncation?.artifactId;
		expect(artifactId).toBeString();
		const artifactPath = await artifacts.getPath(artifactId!);
		expect(await Bun.file(artifactPath!).text()).toBe(raw);
		expect(Buffer.byteLength(textOf(result), "utf8")).toBeLessThan(Buffer.byteLength(raw, "utf8"));
		expect(textOf(result)).toContain("Use skip=600 with the same limit to continue");
	});

	it("uses accepted tool-specific pagination without read-style selectors", async () => {
		const searchDir = path.join(tempDir, "pages");
		await fs.mkdir(searchDir);
		for (let file = 0; file < 25; file++) {
			await Bun.write(path.join(searchDir, `${String(file).padStart(2, "0")}.txt`), "needle\n");
		}

		const search = wrapToolWithMetaNotice(new SearchTool(createSession(tempDir)));
		const firstSearchPage = await search.execute("search-page-1", { pattern: "needle", paths: [searchDir] });
		const firstSearchFiles = firstSearchPage.details?.files ?? [];
		const secondSearchPage = await search.execute("search-page-2", {
			pattern: "needle",
			paths: [searchDir],
			skip: firstSearchFiles.length,
		});
		expect(new Set([...firstSearchFiles, ...(secondSearchPage.details?.files ?? [])]).size).toBe(25);

		const find = wrapToolWithMetaNotice(new FindTool(createSession(tempDir)));
		const firstFindPage = await find.execute("find-page-1", { paths: ["pages/*.txt"], limit: 10 });
		const firstFindFiles = firstFindPage.details?.files ?? [];
		const secondFindPage = await find.execute("find-page-2", {
			paths: ["pages/*.txt"],
			limit: 10,
			skip: firstFindFiles.length,
		});
		expect(new Set([...firstFindFiles, ...(secondFindPage.details?.files ?? [])]).size).toBe(20);

		for (const result of [firstSearchPage, secondSearchPage, firstFindPage, secondFindPage]) {
			expect(textOf(result)).not.toMatch(/Use :\d+ to continue/);
		}
	});
});
