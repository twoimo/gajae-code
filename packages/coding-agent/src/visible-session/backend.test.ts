import { describe, expect, it } from "bun:test";
import {
	readVisibleSessionBackendId,
	VISIBLE_SESSION_BACKEND_IDS,
	type VisibleSessionBackendId,
} from "./backend";

describe("visible session backend IDs", () => {
	it("reads every canonical durable backend ID", () => {
		for (const backend of VISIBLE_SESSION_BACKEND_IDS) {
			expect(readVisibleSessionBackendId(backend)).toEqual({ kind: "supported", backend, source: "canonical" });
		}
	});

	it("normalizes the legacy native backend and marks its source", () => {
		expect(readVisibleSessionBackendId("native")).toEqual({
			kind: "supported",
			backend: "conpty",
			source: "legacy",
		});
	});

	it("preserves unknown nonempty backend IDs for recovery", () => {
		expect(readVisibleSessionBackendId("future-backend")).toEqual({ kind: "unsupported", rawId: "future-backend" });
	});

	it("fails closed for invalid backend IDs", () => {
		for (const value of [undefined, null, "", 0, {}] as const) {
			expect(readVisibleSessionBackendId(value)).toEqual({ kind: "invalid" });
		}
	});

	it("does not permit native as a canonical writable backend", () => {
		const writableBackendIds: readonly VisibleSessionBackendId[] = VISIBLE_SESSION_BACKEND_IDS;
		expect(writableBackendIds).toEqual(["conpty", "tmux", "wsl-tmux"]);
		expect(writableBackendIds).not.toContain("native");
	});
});
