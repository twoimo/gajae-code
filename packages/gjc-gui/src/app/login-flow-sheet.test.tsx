import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type LoginFlowClient, LoginFlowSheet } from "./login-flow-sheet";

let mountedRoot: Root | undefined;

afterEach(() => {
	if (mountedRoot) {
		act(() => mountedRoot?.unmount());
		mountedRoot = undefined;
	}
});

describe("LoginFlowSheet", () => {
	test("redirect completion is a masked one-shot secret and clears after submit", async () => {
		const { document, Event } = parseHTML('<main id="root"></main>');
		globalThis.document = document;
		globalThis.window = document.defaultView ?? globalThis.window;
		globalThis.Event = Event;
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

		const completed: Array<{ flowId: string; redirectUrl: string }> = [];
		const client: LoginFlowClient = {
			start: async () => ({ flowId: "flow-1", state: "needs-input" }),
			poll: async () => ({ state: "needs-input" }),
			complete: async (flowId, redirectUrl) => {
				completed.push({ flowId, redirectUrl });
				return { state: "authenticated" };
			},
			cancel: async () => ({ state: "cancelled" }),
		};
		const container = document.getElementById("root");
		if (!container) throw new Error("Missing test root");
		mountedRoot = createRoot(container);

		await act(async () => {
			mountedRoot?.render(<LoginFlowSheet providerId="openai" client={client} onClose={() => undefined} />);
		});

		const input = container.querySelector("input");
		if (!(input instanceof window.HTMLInputElement)) throw new Error("Missing redirect input");
		expect(input.type).toBe("password");
		expect(container.textContent).toContain("One-time redirect secret");
		expect(input.placeholder).toContain("not stored or displayed");

		await act(async () => {
			input.value = " https://localhost/callback?code=secret-code ";
			input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
		});
		expect(container.textContent).not.toContain("secret-code");

		const form = container.querySelector("form");
		if (!form) throw new Error("Missing completion form");
		await act(async () => {
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});

		expect(completed).toEqual([{ flowId: "flow-1", redirectUrl: "https://localhost/callback?code=secret-code" }]);
		expect(input.value).toBe("");
		expect(container.textContent).not.toContain("secret-code");
	});

	test("surfaces completion failures", async () => {
		const { document, Event } = parseHTML('<main id="root"></main>');
		globalThis.document = document;
		globalThis.window = document.defaultView ?? globalThis.window;
		globalThis.Event = Event;
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		const client: LoginFlowClient = {
			start: async () => ({ flowId: "flow-1", state: "needs-input" }),
			poll: async () => ({ state: "needs-input" }),
			complete: async () => {
				throw new Error("redirect rejected");
			},
			cancel: async () => ({ state: "cancelled" }),
		};
		const container = document.getElementById("root");
		if (!container) throw new Error("Missing test root");
		mountedRoot = createRoot(container);
		await act(async () => {
			mountedRoot?.render(<LoginFlowSheet providerId="openai" client={client} onClose={() => undefined} />);
		});
		const input = container.querySelector("input");
		if (!(input instanceof window.HTMLInputElement)) throw new Error("Missing redirect input");
		await act(async () => {
			input.value = "https://localhost/callback";
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		expect(container.textContent).toContain("redirect rejected");
	});
});

test("cancels a flow that starts after the sheet unmounts", async () => {
	const { document, Event } = parseHTML('<main id="root"></main>');
	globalThis.document = document;
	globalThis.window = document.defaultView ?? globalThis.window;
	globalThis.Event = Event;
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	let resolveStart: ((result: { flowId: string; state: "pending-browser" }) => void) | undefined;
	const cancelled: string[] = [];
	const client: LoginFlowClient = {
		start: () =>
			new Promise(resolve => {
				resolveStart = resolve;
			}),
		poll: async () => ({ state: "pending-browser" }),
		complete: async () => ({ state: "authenticated" }),
		cancel: async flowId => {
			cancelled.push(flowId);
			return { state: "cancelled" };
		},
	};
	const container = document.getElementById("root");
	if (!container) throw new Error("Missing test root");
	mountedRoot = createRoot(container);
	await act(async () => {
		mountedRoot?.render(<LoginFlowSheet providerId="openai" client={client} onClose={() => undefined} />);
	});
	act(() => mountedRoot?.unmount());
	mountedRoot = undefined;
	await act(async () => resolveStart?.({ flowId: "late-flow", state: "pending-browser" }));
	expect(cancelled).toEqual(["late-flow"]);
});
