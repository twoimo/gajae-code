import { describe, expect, it } from "bun:test";
import { SessionStoreCoordinator } from "../../../src/session/coordinators/session-store-coordinator";

describe("SessionStoreCoordinator", () => {
	it("prepares before switching and rolls back the captured durable state", async () => {
		const calls: string[] = [];
		const snapshot = { sessionId: "before" };
		const lease = { lease: { close() {} } };
		const manager = {
			prepareSessionLease: () => lease,
			validateSessionFile: () => calls.push("validate"),
			captureState: () => snapshot,
			setSessionFile: async () => calls.push("switch"),
			restoreState: (value: { sessionId: string }) => calls.push(`rollback:${value.sessionId}`),
			discardState: (value: { sessionId: string }) => calls.push(`commit:${value.sessionId}`),
			flush: async () => calls.push("flush"),
			newSession: async () => calls.push("new"),
			fork: async () => undefined,
		} as never;
		const coordinator = new SessionStoreCoordinator(manager);
		const prepared = coordinator.prepare("target.jsonl");
		const captured = coordinator.capture();
		await coordinator.switch("target.jsonl", prepared.lease);
		coordinator.rollback(captured);
		expect(calls).toEqual(["switch", "rollback:before"]);
	});
});
