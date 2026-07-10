import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToString } from "react-dom/server";

globalThis.window = {
	location: { search: "" },
	setTimeout: globalThis.setTimeout,
	clearTimeout: globalThis.clearTimeout,
	requestAnimationFrame: (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	},
	addEventListener: () => undefined,
	removeEventListener: () => undefined,
} as unknown as Window & typeof globalThis;
globalThis.navigator = {} as Navigator;
globalThis.WebSocket = { OPEN: 1 } as typeof WebSocket;

describe("product harness", () => {
	test("renders the real app through harness dependencies", async () => {
		const { HarnessApp } = await import("./main");
		const html = renderToString(React.createElement(HarnessApp));
		expect(html).toContain("Desktop chat");
		expect(html).toContain("/projects/demo-app");
	});
});
