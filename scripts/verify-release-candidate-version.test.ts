import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { verifyReleaseCandidateVersion } from "./verify-release-candidate-version";

describe("release candidate version binding", () => {
	test("accepts the candidate canonical package version", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-version-"));
		try {
			await Bun.write(path.join(root, "package.json"), JSON.stringify({ workspaces: { catalog: { "@gajae-code/coding-agent": "1.2.3" } } }));
			expect(await verifyReleaseCandidateVersion("1.2.3", root)).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rejects a requested version that differs from the checked-out candidate", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-version-"));
		try {
			await Bun.write(path.join(root, "package.json"), JSON.stringify({ workspaces: { catalog: { "@gajae-code/coding-agent": "1.2.3" } } }));
			expect((await verifyReleaseCandidateVersion("1.2.4", root)).join(" ")).toContain("does not match candidate canonical version 1.2.3");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
