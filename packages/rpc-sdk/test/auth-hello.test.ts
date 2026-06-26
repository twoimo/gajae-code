import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHelloFrame, buildHelloPayload, performHello } from "../src/auth/hello";
import { ensureGrantDirectory, isGrantUsable, loadGrant, type GrantRecord } from "../src/auth/grants";
import type { GjcFrame } from "../src/protocol";
import type { UdsTransport } from "../src/transport/uds";

class FakeTransport extends EventEmitter {
	written: GjcFrame<unknown>[] = [];
	constructor(private readonly response: GjcFrame<unknown>) { super(); }
	async write(frame: GjcFrame<unknown>): Promise<void> {
		this.written.push(frame);
		queueMicrotask(() => this.emit("frame", this.response));
	}
}

describe("grants and hello", () => {
	test("loads 0600 grant records under rpc-sdk grant state", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-grants-"));
		const dir = await ensureGrantDirectory(root);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const grant: GrantRecord = { version: 1, grantId: "g1", principalBinding: { kind: "bearer", bearer_hash: "hash1" }, issuedAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", renewableUntil: "2099-01-02T00:00:00Z", issuer: "test", purpose: "unit", sessions: ["s1"], scopes: ["subscribe", "control"], redactionPolicy: "redacted" };
		const path = join(dir, "g1.json");
		await writeFile(path, JSON.stringify(grant));
		await chmod(path, 0o600);
		expect(await loadGrant("g1", root)).toEqual(grant);
		expect(isGrantUsable(grant)).toBe(true);
	});

	test("rejects insecure pre-existing grant directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-grants-insecure-"));
		const dir = join(root, "rpc-sdk", "grants");
		await mkdir(dir, { recursive: true, mode: 0o755 });
		await expect(ensureGrantDirectory(root)).rejects.toThrow("must not be group/world accessible");
	});

	test("builds daemon-server compatible camelCase hello frame", () => {
		expect(buildHelloPayload({ sessions: ["s1"], redaction: "full", grantId: "g1" })).toEqual({ protocolVersion: 1, requested: [{ session: "s1", redaction: "full" }], grantId: "g1" });
		expect(buildHelloFrame({ sessions: ["s1"] })).toMatchObject({ kind: "hello", direction: "client_to_server", payload: { protocolVersion: 1 } });
	});

	test("preserves optional grantId through hello payload JSON round-trip", () => {
		const payload = buildHelloPayload({ sessions: ["s1"], redaction: "redacted", grantId: "g1" });
		expect(JSON.parse(JSON.stringify(payload))).toEqual({ protocolVersion: 1, requested: [{ session: "s1", redaction: "redacted" }], grantId: "g1" });
		expect(JSON.parse(JSON.stringify(buildHelloFrame({ sessions: ["s1"], grantId: "g1" }).payload))).toEqual(payload);
	});

	test("performHello accepts only ready hello_accepted for protocol v1", async () => {
		const ok: GjcFrame = { protocolVersion: 1, frameId: "hello_ok", sessionId: "", seq: 0, direction: "server_to_client", kind: "ready", type: "hello_accepted", replay: false, payload: { sessions: 1 } };
		await expect(performHello(new FakeTransport(ok) as unknown as UdsTransport, { sessions: ["s1"] })).resolves.toMatchObject(ok);
		const bad: GjcFrame = { ...ok, kind: "response", type: "anything" };
		await expect(performHello(new FakeTransport(bad) as unknown as UdsTransport, { sessions: ["s1"] })).rejects.toThrow("invalid hello response");
	});
});
