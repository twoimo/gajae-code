import { describe, expect, it } from "bun:test";

import * as path from "node:path";

import {
	buildCoreDevCompileArgs,
	buildCoreReleaseCompileArgs,
	buildDevCompileArgs,
	buildReleaseCompileArgs,
	coreReleaseEntrypoints,
	releaseEntrypoints,
} from "../scripts/compile-args";

const releaseArgs = buildReleaseCompileArgs("bun-darwin-arm64", "packages/coding-agent/binaries/gjc-darwin-arm64");
const coreReleaseArgs = buildCoreReleaseCompileArgs(
	"bun-darwin-arm64",
	"packages/coding-agent/binaries/gjc-core-darwin-arm64",
);

function valuesAfter(args: string[], flag: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length - 1; index += 1) {
		if (args[index] === flag) {
			values.push(args[index + 1]);
		}
	}
	return values;
}

describe("release build compile args", () => {
	it("keeps minify and names flags in the release config", () => {
		expect(releaseArgs).toContain("--minify");
		expect(releaseArgs).toContain("--keep-names");
	});

	it("minifies both dev and release builds", () => {
		expect(buildDevCompileArgs()).toContain("--minify");
		expect(releaseArgs).toContain("--minify");
		expect(buildCoreDevCompileArgs()).toContain("--minify");
		expect(coreReleaseArgs).toContain("--minify");
	});

	it("does not ship handlebars as a bunfs extra entrypoint (#1939)", () => {
		// --minify silently dropped the handlebars extra entrypoint from the
		// bunfs bundle, crashing v0.9.3–v0.9.6 compiled releases at startup.
		// handlebars is bundled via a statically-traceable require instead.
		expect(releaseEntrypoints).not.toContain("./node_modules/handlebars/lib/index.js");
		expect(releaseArgs).not.toContain("./node_modules/handlebars/lib/index.js");
		expect(coreReleaseEntrypoints).not.toContain("./node_modules/handlebars/lib/index.js");
		expect(coreReleaseArgs).not.toContain("./node_modules/handlebars/lib/index.js");
		expect(buildDevCompileArgs()).not.toContain("../../node_modules/handlebars/lib/index.js");
		expect(buildCoreDevCompileArgs()).not.toContain("../../node_modules/handlebars/lib/index.js");
	});

	it("marks release binaries with release build metadata", () => {
		expect(valuesAfter(releaseArgs, "--define")).toContain('process.env.PI_COMPILED="true"');
		expect(valuesAfter(releaseArgs, "--define")).toContain('process.env.GJC_BUILD_CHANNEL="release"');
		expect(valuesAfter(releaseArgs, "--define")).not.toContain('process.env.GJC_BUILD_CHANNEL="dev"');
	});

	it("marks dev-compiled binaries as dev builds explicitly", () => {
		const devDefines = valuesAfter(buildDevCompileArgs(), "--define");
		expect(devDefines).toContain('process.env.PI_COMPILED="true"');
		expect(devDefines).toContain('process.env.GJC_BUILD_CHANNEL="dev"');
	});

	it("embeds an explicit SKU marker in full and core builds", () => {
		expect(valuesAfter(releaseArgs, "--define")).toContain('process.env.GJC_BUILD_SKU="full"');
		expect(valuesAfter(coreReleaseArgs, "--define")).toContain('process.env.GJC_BUILD_SKU="core"');
		expect(valuesAfter(buildDevCompileArgs(), "--define")).toContain('process.env.GJC_BUILD_SKU="full"');
		expect(valuesAfter(buildCoreDevCompileArgs(), "--define")).toContain('process.env.GJC_BUILD_SKU="core"');
	});

	it("includes worker and lazy CommonJS entrypoints in release args", () => {
		expect(releaseEntrypoints).toContain("./packages/stats/src/sync-worker.ts");
		expect(releaseEntrypoints).toContain("./packages/coding-agent/src/tools/browser/tab-worker-entry.ts");
		expect(releaseEntrypoints).toContain("./packages/coding-agent/src/eval/js/worker-entry.ts");
		expect(releaseArgs).toContain("./packages/stats/src/sync-worker.ts");
		expect(releaseArgs).toContain("./packages/coding-agent/src/tools/browser/tab-worker-entry.ts");
		expect(releaseArgs).toContain("./packages/coding-agent/src/eval/js/worker-entry.ts");
	});

	it("does not list models.json as an extra compile entrypoint", () => {
		// Bun does not emit `.json` extra entrypoints into the compiled bunfs.
		// The bundled model catalog is embedded via the `with { type: "file" }`
		// import in @gajae-code/ai instead, so re-adding these args would regress
		// release binary startup.
		expect(releaseEntrypoints).not.toContain("./packages/ai/src/models.json");
		expect(releaseArgs).not.toContain("./packages/ai/src/models.json");
		expect(buildDevCompileArgs()).not.toContain("../ai/src/models.json");
	});

	it("keeps the core SKU entrypoint set minimal", () => {
		expect(coreReleaseEntrypoints).toEqual([
			"./packages/coding-agent/src/cli.ts",
			"./packages/natives/native/index.js",
		]);
		expect(coreReleaseArgs).not.toContain("./packages/stats/src/sync-worker.ts");
		expect(coreReleaseArgs).not.toContain("./packages/coding-agent/src/tools/browser/tab-worker-entry.ts");
		expect(coreReleaseArgs).not.toContain("./packages/coding-agent/src/eval/js/worker-entry.ts");
		expect(coreReleaseArgs).not.toContain("./packages/coding-agent/src/notifications/telegram-daemon-cli.ts");
	});

	it("does not add lazy CommonJS modules as dev compile entrypoints", () => {
		expect(buildDevCompileArgs()).not.toContain("../../node_modules/handlebars/lib/index.js");
	});
	it("has exactly one target and outfile", () => {
		expect(valuesAfter(releaseArgs, "--target")).toEqual(["bun-darwin-arm64"]);
		expect(valuesAfter(releaseArgs, "--outfile")).toEqual(["packages/coding-agent/binaries/gjc-darwin-arm64"]);
	});

	it("release script dry-run executes the builder output unmodified", () => {
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const result = Bun.spawnSync({
			cmd: [process.execPath, "scripts/ci-release-build-binaries.ts", "--dry-run"],
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = result.stdout.toString();
		expect(result.exitCode, result.stderr.toString() || stdout).toBe(0);

		const buildLines = stdout.split("\n").filter(line => line.includes("bun build --compile"));
		expect(buildLines.length).toBeGreaterThan(0);
		for (const line of buildLines) {
			const argv = line.replace(/^DRY RUN /, "").split(" ");
			const target = valuesAfter(argv, "--target")[0];
			const outfile = valuesAfter(argv, "--outfile")[0];
			expect(target).toBeDefined();
			expect(outfile).toBeDefined();
			const expected = outfile?.includes("gjc-core-")
				? buildCoreReleaseCompileArgs(target as string, outfile)
				: buildReleaseCompileArgs(target as string, outfile as string);
			expect(line).toBe(`DRY RUN ${expected.join(" ")}`);
		}
	});
});
