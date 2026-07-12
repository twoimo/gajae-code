import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	FileSessionRecovery,
	SegmentStore,
	sha256Hex,
	V1RecoveryError,
	V1SessionReader,
	V2SessionWriter,
} from "../src/session/storage/index";

const tempDirs: string[] = [];
function legacy(contents: string | Buffer): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-recovery-"));
	tempDirs.push(dir);
	const file = path.join(dir, "legacy.jsonl");
	fs.writeFileSync(file, contents);
	return file;
}
afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("strict v1 recovery", () => {
	it("quarantines only an unterminated partial final record after a valid envelope", () => {
		const file = legacy(`${JSON.stringify({ type: "session" })}\n{"type":`);
		const result = new V1SessionReader(file).readAll();
		expect(result.entries).toEqual([{ type: "session" }]);
		expect(result.quarantinedTail).toBe('{"type":');
	});

	it("fails on malformed complete records without a proven checkpoint", () => {
		const file = legacy(`${JSON.stringify({ type: "session" })}\nnot-json\n{"type":`);
		expect(() => new V1SessionReader(file).readAll()).toThrow(V1RecoveryError);
	});

	it("recovers from earlier corruption only when a fully validated checkpoint proves a non-empty prefix", () => {
		const first = JSON.stringify({ type: "session", id: "s" });
		const hash = sha256Hex(`\n${first}`);
		const checkpoint = JSON.stringify({ type: "checkpoint", entryCount: 1, hash });
		const file = legacy(`${first}\n${checkpoint}\nnot-json\n{"type":`);
		const result = new V1SessionReader(file).readAll();
		expect(result.entries).toEqual([{ type: "session", id: "s" }]);
		expect(result.recoveredAtCheckpoint).toEqual({ entryCount: 1, hash });
	});

	it("rejects empty, arbitrary, and wrong-header v1 envelopes", () => {
		expect(() => new V1SessionReader(legacy("")).readAll()).toThrow("missing a session header");
		expect(() => new V1SessionReader(legacy("{}\n")).readAll()).toThrow(
			"First JSONL record must be a session header",
		);
		expect(() => new V1SessionReader(legacy("42\n")).metadata()).toThrow(
			"First JSONL record must be a session header",
		);
	});

	it("rejects invalid UTF-8 rather than replacement-decoding it", () => {
		const file = legacy(Buffer.concat([Buffer.from('{"type":"session"}\n'), Buffer.from([0xc3, 0x28, 0x0a])]));
		expect(() => new V1SessionReader(file).readAll()).toThrow("Invalid UTF-8");
	});
});

describe("v2 prefix recovery", () => {
	it("retains only complete hash-verified checkpoint segments when a later segment corrupts", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-v2-prefix-"));
		tempDirs.push(dir);
		const segments = new SegmentStore(path.join(dir, "segments"));
		const manifestPath = path.join(dir, "manifest.json");
		const manifest = new V2SessionWriter(manifestPath, segments).write(
			[
				{ type: "session", id: "s" },
				{ type: "message", text: "retained" },
				{ type: "message", text: "corrupt" },
			],
			{ entrySchemaVersion: 3, rootId: "root-s", generation: 0, maxEntriesPerSegment: 1 },
		);
		fs.writeFileSync(path.join(segments.dir, manifest.segments[2].hash), "corrupt\n");
		const result = new FileSessionRecovery([manifestPath], segments).recoverPrefix(manifestPath);
		expect(result.entries).toEqual([
			{ type: "session", id: "s" },
			{ type: "message", text: "retained" },
		]);
		expect(result.recoveredAtCheckpoint?.entryCount).toBe(2);
	});
});
