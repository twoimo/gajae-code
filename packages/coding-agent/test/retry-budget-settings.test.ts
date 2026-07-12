import { describe, expect, it } from "bun:test";

describe("retry budget settings schema", () => {
	it("registers one global retry ledger with bounded defaults", async () => {
		const schema = await Bun.file(new URL("../src/config/settings-schema.ts", import.meta.url)).text();

		for (const key of [
			"retry.requestMaxRetries",
			"retry.streamMaxRetries",
			"retry.maxTotalAttempts",
			"retry.maxElapsedMs",
			"retry.maxCostUsd",
			"retry.unbounded",
			"retry.allowUnboundedUnattended",
		]) {
			expect(schema).toContain(`"${key}"`);
		}
		expect(schema).toContain("default: 14");
		expect(schema).toContain("default: 900_000");
		expect(schema).toContain("unbounded: boolean;");
	});
});
