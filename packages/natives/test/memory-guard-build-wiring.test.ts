import { describe, expect, it } from "bun:test";
import * as path from "node:path";

describe("memory-guard native build wiring", () => {
	it("pins the probe export in build-time binding validation and embed-time addon validation", async () => {
		const buildNativeSource = await Bun.file(path.join(import.meta.dir, "../scripts/build-native.ts")).text();
		expect(buildNativeSource).toMatch(/requiredGeneratedBindingSymbols[\s\S]*"probeWindowsJobMemory"/);
		const embedNativeSource = await Bun.file(path.join(import.meta.dir, "../scripts/embed-native.ts")).text();
		expect(embedNativeSource).toMatch(/requiredAddonExports = \["nativeBuildInfo", "probeWindowsJobMemory"\]/);
	});
});
