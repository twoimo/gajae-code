import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateEnumExports } from "../scripts/gen-enums";

const MARKER_START = "// --- generated native exports (do not edit) ---";
const MARKER_END = "// --- end generated native exports ---";

function generatedBlock(source: string): string {
	const start = source.indexOf(MARKER_START);
	const end = source.indexOf(MARKER_END, start);
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThanOrEqual(start);
	return source.slice(start, end + MARKER_END.length);
}

describe("native export generator", () => {
	it("regenerates the checked-in lazy export block idempotently", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-native-gen-enums-"));
		const sourceDts = path.join(import.meta.dir, "../native/index.d.ts");
		const sourceJs = path.join(import.meta.dir, "../native/index.js");
		const tempDts = path.join(directory, "index.d.ts");
		const tempJs = path.join(directory, "index.js");
		try {
			await Promise.all([fs.copyFile(sourceDts, tempDts), fs.copyFile(sourceJs, tempJs)]);
			await generateEnumExports({ dtsPath: tempDts, jsPath: tempJs });

			const [checkedIn, regenerated] = await Promise.all([
				fs.readFile(sourceJs, "utf8"),
				fs.readFile(tempJs, "utf8"),
			]);
			const regeneratedBlock = generatedBlock(regenerated);
			expect(regeneratedBlock).not.toMatch(/export const \w+ = nativeBindings\.\w+;/);
			expect(regeneratedBlock).toBe(generatedBlock(checkedIn));
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
