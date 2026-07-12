import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { checkReleaseManifest, publishOrder, releasePlatforms } from "./release-manifest";

const repoRoot = path.join(import.meta.dir, "..");
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))));

async function fixtureRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-manifest-")); roots.push(root);
	for (const relative of ["packages/natives/package.json", "packages/natives/native/loader-state.js", ".github/workflows/ci.yml"]) {
		await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
		await Bun.write(path.join(root, relative), await Bun.file(path.join(repoRoot, relative)).text());
	}
	return root;
}

async function mutate(root: string, relative: string, from: string, to: string): Promise<string[]> {
	const file = path.join(root, relative);
	const source = await Bun.file(file).text();
	expect(source).toContain(from);
	await Bun.write(file, source.replace(from, to));
	return checkReleaseManifest(root);
}

describe("release manifest", () => {
	test("checked-in generated surfaces are current", async () => expect(await checkReleaseManifest()).toEqual([]));
	test("platform packages precede the stable native package", () => {
		const stable = publishOrder.indexOf("packages/natives");
		for (const target of releasePlatforms) expect(publishOrder.indexOf(`packages/natives-${target.id}`)).toBeLessThan(stable);
	});
	test("check mode fails closed on stale generated output", async () => {
		const root = await fixtureRoot();
		await Bun.write(path.join(root, "packages/natives/native/loader-state.js"), "");
		expect((await checkReleaseManifest(root)).length).toBeGreaterThan(0);
	});

	for (const [field, from, to] of [
		["workflowRunner", "os: ubuntu-24.04-arm", "os: ubuntu-24.04"],
		["platform", "platform: darwin,", "platform: freebsd,"],
		["arch", "arch: arm64,", "arch: x64,"],
		["variant", "variant: baseline }", "variant: modern }"],
		["rustTarget", "target: aarch64-unknown-linux-gnu", "target: x86_64-unknown-linux-gnu"],
		["binaryPath", "binary_path: packages/coding-agent/binaries/gjc-linux-arm64", "binary_path: packages/coding-agent/binaries/stale"],
		["coreBinaryPath", "core_binary_path: packages/coding-agent/binaries/gjc-core-linux-arm64", "core_binary_path: packages/coding-agent/binaries/stale-core"],
		["id", "target_id: linux-arm64", "target_id: linux-extra"],
	] as const) {
		test(`rejects a stale ci.yml ${field}`, async () => {
			const root = await fixtureRoot();
			expect((await mutate(root, ".github/workflows/ci.yml", from, to)).join(" ")).toContain("ci.yml");
		});
	}

	test("rejects a stale loader package id", async () => {
		const root = await fixtureRoot();
		expect((await mutate(root, "packages/natives/native/loader-state.js", '"linux-arm64": "@gajae-code/natives-linux-arm64"', '"linux-extra": "@gajae-code/natives-linux-arm64"')).join(" ")).toContain("loader-state.js platform packages is stale");
	});
	test("rejects a stale loader native package", async () => {
		const root = await fixtureRoot();
		expect((await mutate(root, "packages/natives/native/loader-state.js", '"linux-arm64": "@gajae-code/natives-linux-arm64"', '"linux-arm64": "@gajae-code/natives-stale"')).join(" ")).toContain("loader-state.js platform packages is stale");
	});
	test("rejects added and removed workflow platforms", async () => {
		const removed = await fixtureRoot();
		const removedWorkflow = await Bun.file(path.join(removed, ".github/workflows/ci.yml")).text();
		await Bun.write(path.join(removed, ".github/workflows/ci.yml"), removedWorkflow.replace(/\n\s*- \{\n\s*os: windows-latest,[\s\S]*?core_binary_path: packages\/coding-agent\/binaries\/gjc-core-windows-x64\.exe,\n\s*\}/, ""));
		expect((await checkReleaseManifest(removed)).join(" ")).toContain("ci.yml release platform projection is stale");
		const added = await fixtureRoot();
		const loaderPath = path.join(added, "packages/natives/native/loader-state.js");
		const loader = await Bun.file(loaderPath).text();
		await Bun.write(loaderPath, loader.replace('"win32-x64": "@gajae-code/natives-win32-x64",', '"win32-x64": "@gajae-code/natives-win32-x64",\n\t"freebsd-x64": "@gajae-code/natives-freebsd-x64",'));
		expect((await checkReleaseManifest(added)).join(" ")).toContain("loader-state.js platform packages is stale");
	});
});
