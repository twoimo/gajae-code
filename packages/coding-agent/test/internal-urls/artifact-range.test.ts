import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { InternalUrlRouter } from "../../src/internal-urls";
import { ArtifactManager } from "../../src/session/artifacts";
import { OutputSink } from "../../src/session/streaming-output";
import type { ToolSession } from "../../src/tools";
import {
	formatFullOutputReference,
	formatOutputNotice,
	formatStyledTruncationWarning,
	outputMeta,
} from "../../src/tools/output-meta";
import { ReadTool } from "../../src/tools/read";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-range-"));
	tempDirs.push(dir);
	return dir;
}

function session(cwd: string, artifactsDir: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getArtifactsDir: () => artifactsDir,
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

afterEach(async () => {
	InternalUrlRouter.resetForTests();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("artifact ranges", () => {
	it("streams a UTF-8 range beyond 16 MiB after authorization", async () => {
		const cwd = await tempDir();
		const artifactsDir = path.join(cwd, "artifacts");
		await fs.mkdir(artifactsDir);
		const prefix = `${"x".repeat(1023)}\n`.repeat(16_384);
		await Bun.write(path.join(artifactsDir, "7.bash.log"), `${prefix}é-tail\nlast`);

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("artifact://7", { getArtifactsDir: () => artifactsDir });
		expect(resource.deferredContent).toBe(true);
		expect(resource.content).toBe("");

		const tool = new ReadTool(session(cwd, artifactsDir));
		const selected = await tool.execute("read-1", { path: "artifact://7:16385+1:raw" });
		expect(textOf(selected)).toBe("é-tail");

		const eof = await tool.execute("read-2", { path: "artifact://7:16386+1:raw" });
		expect(textOf(eof)).toBe("last");
		const invalid = await tool.execute("read-3", { path: "artifact://7:16387+1:raw" });
		expect(textOf(invalid)).toContain("beyond end of file (16386 lines total)");
	});

	it("labels complete and capped artifacts truthfully", async () => {
		const artifactsDir = await tempDir();
		const manager = new ArtifactManager(artifactsDir);
		await manager.save("complete", "read", { maxBytes: 32 });
		await manager.save("é".repeat(32), "read", { maxBytes: 10 });

		expect(formatFullOutputReference("0", { artifactComplete: true })).toContain("full output");
		expect(
			formatFullOutputReference("1", {
				artifactComplete: false,
				artifactOmittedBytes: 54,
				artifactOmittedBytesExact: true,
			}),
		).toBe("Read artifact://1 for retained output (omitted 54B)");
		expect(
			formatFullOutputReference("1", {
				artifactComplete: false,
				artifactOmittedBytes: 54,
				artifactOmittedBytesExact: false,
			}),
		).toContain("omitted at least");
	});

	it("carries capped streaming metadata through model and TUI notices", async () => {
		const dir = await tempDir();
		const sink = new OutputSink({
			artifactPath: path.join(dir, "8.bash.log"),
			artifactId: "8",
			spillThreshold: 4,
			artifactMaxBytes: 16,
		});
		sink.push("a".repeat(40));
		const summary = await sink.dump();
		const meta = outputMeta().truncationFromSummary(summary, { direction: "tail" }).get();
		const modelNotice = formatOutputNotice(meta);
		expect(meta?.truncation).toMatchObject({
			artifactComplete: false,
			artifactRetainedBytes: 16,
			artifactOriginalBytes: 40,
			artifactOmittedBytes: 24,
		});
		expect(modelNotice).toContain("retained output (omitted 24B)");
		expect(
			formatStyledTruncationWarning(meta, {
				fg: (_color: string, text: string) => text,
				format: { bracketLeft: "[", bracketRight: "]" },
			} as never),
		).toContain("retained output");
	});
});
