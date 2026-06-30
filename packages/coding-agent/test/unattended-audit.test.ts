import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	AUDIT_CATEGORY,
	AUDIT_SCHEMA_VERSION,
	answerHash,
	UnattendedAuditLog,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/unattended-audit";

function tmpFile(name = "audit.jsonl"): string {
	return path.join(mkdtempSync(path.join(tmpdir(), "audit-")), name);
}

describe("UnattendedAuditLog", () => {
	it("writes a normalized record with required fields", () => {
		const log = new UnattendedAuditLog(tmpFile(), { now: () => 0, nextId: () => "id-1" });
		const rec = log.record({
			run_id: "run-1",
			session_id: "sess-1",
			actor: "hermes",
			event: "gate_response_accepted",
			outcome: "accepted",
			dedupe_key: "run-1:g1:accepted",
			gate_id: "g1",
			stage: "ralplan",
			kind: "approval",
			answer: "approve",
			answer_hash: answerHash("approve"),
		});
		expect(rec).not.toBeNull();
		expect(rec).toMatchObject({
			event_id: "id-1",
			schema_version: AUDIT_SCHEMA_VERSION,
			category: AUDIT_CATEGORY,
			run_id: "run-1",
			actor: "hermes",
			outcome: "accepted",
			gate_id: "g1",
			answer: "approve",
		});
		expect(rec?.timestamp).toBe(new Date(0).toISOString());
	});

	it("dedupes exactly-once by dedupe_key", () => {
		const file = tmpFile();
		const log = new UnattendedAuditLog(file);
		const a = log.record({ run_id: "r", event: "budget_exceeded", outcome: "exceeded", dedupe_key: "k1" });
		const b = log.record({ run_id: "r", event: "budget_exceeded", outcome: "exceeded", dedupe_key: "k1" });
		expect(a).not.toBeNull();
		expect(b).toBeNull();
		expect(log.readAll()).toHaveLength(1);
		// Dedupe survives a fresh instance over the same file.
		const log2 = new UnattendedAuditLog(file);
		expect(log2.record({ run_id: "r", event: "budget_exceeded", outcome: "exceeded", dedupe_key: "k1" })).toBeNull();
		expect(log2.readAll()).toHaveLength(1);
	});

	it("captures gate, budget, and scope/action events in the same trail", () => {
		const log = new UnattendedAuditLog(tmpFile());
		log.record({ run_id: "r", event: "gate_response_accepted", outcome: "accepted", dedupe_key: "g", gate_id: "g1" });
		log.record({ run_id: "r", event: "budget_exceeded", outcome: "exceeded", dedupe_key: "b", scope: undefined });
		log.record({ run_id: "r", event: "scope_denied", outcome: "denied", dedupe_key: "s", scope: "bash" });
		log.record({ run_id: "r", event: "action_denied", outcome: "denied", dedupe_key: "a", action: "git.force_push" });
		const all = log.readAll();
		expect(all.map(r => r.event).sort()).toEqual([
			"action_denied",
			"budget_exceeded",
			"gate_response_accepted",
			"scope_denied",
		]);
	});

	it("filters by since_seq (monotonic 1-based log sequence)", () => {
		const log = new UnattendedAuditLog(tmpFile());
		log.record({ run_id: "r", event: "e1", outcome: "info", dedupe_key: "k1" });
		log.record({ run_id: "r", event: "e2", outcome: "info", dedupe_key: "k2" });
		log.record({ run_id: "r", event: "e3", outcome: "info", dedupe_key: "k3" });
		// since_seq:1 drops the first record; since_seq:0 keeps all.
		expect(log.query({ since_seq: 1 }).map(r => r.event)).toEqual(["e2", "e3"]);
		expect(log.query({ since_seq: 0 }).map(r => r.event)).toEqual(["e1", "e2", "e3"]);
		expect(log.query({ since_seq: 3 })).toEqual([]);
		// Composes with other filters.
		expect(log.export({ since_seq: 1, event: "e3" }).map(r => r.event)).toEqual(["e3"]);
	});

	it("redacts answers when configured but keeps the hash", () => {
		const log = new UnattendedAuditLog(tmpFile(), { redactAnswers: true });
		const rec = log.record({
			run_id: "r",
			event: "gate_response_accepted",
			outcome: "accepted",
			dedupe_key: "g",
			answer: { secret: "value" },
			answer_hash: answerHash({ secret: "value" }),
		});
		expect(rec?.answer).toBeUndefined();
		expect(rec?.answer_hash).toBe(answerHash({ secret: "value" }));
	});

	it("fails closed on a corrupt audit line", () => {
		const file = tmpFile();
		const log = new UnattendedAuditLog(file);
		log.record({ run_id: "r", event: "x", outcome: "info", dedupe_key: "k" });
		appendFileSync(file, "{ not json\n");
		expect(() => log.readAll()).toThrow(/corrupt audit record/);
	});
});
