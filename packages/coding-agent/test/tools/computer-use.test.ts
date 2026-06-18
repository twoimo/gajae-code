import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { ComputerUseTool } from "../../src/tools/computer-use";

const originalFetch = globalThis.fetch;
const originalLcuApiToken = Bun.env.LCU_API_TOKEN;

function makeSession(baseUrl = "http://lcu.local:8765"): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "computerUse.baseUrl": baseUrl }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	} as unknown as ToolSession;
}

describe("ComputerUseTool", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
		Bun.env.LCU_API_TOKEN = originalLcuApiToken;
	});

	it("returns observation metadata and an inline screenshot image", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			return Response.json({
				backend: "x11",
				width: 1280,
				height: 720,
				display: ":99",
				mime_type: "image/png",
				screenshot_base64: Buffer.from("png").toString("base64"),
			});
		}) as typeof fetch;

		const tool = new ComputerUseTool(makeSession());
		const result = await tool.execute("call", { action: "observe" });

		expect(calls).toEqual([
			{
				url: "http://lcu.local:8765/observe",
				init: { method: "GET", headers: expect.any(Headers), signal: undefined },
			},
		]);
		expect(result.details).toMatchObject({ action: "observe", backend: "x11", width: 1280, height: 720 });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("backend: x11") });
		expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
	});

	it("posts actions to act-and-observe and summarizes action observations", async () => {
		let postedBody: unknown;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			postedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
			return Response.json({
				results: [{ ok: true, message: "ok" }],
				observation: { backend: "x11", width: 800, height: 600 },
			});
		}) as typeof fetch;

		const tool = new ComputerUseTool(makeSession());
		const result = await tool.execute("call", {
			action: "act_and_observe",
			actions: [{ type: "wait", ms: 100 }],
		});

		expect(postedBody).toEqual({ actions: [{ type: "wait", ms: 100 }], observe: true });
		expect(result.details).toMatchObject({ action: "act_and_observe", width: 800, height: 600 });
		expect(result.content).toHaveLength(1);
	});

	it("uses the environment token only for the configured base URL", async () => {
		const calls: Array<{ url: string; token: string | null }> = [];
		Bun.env.LCU_API_TOKEN = "env-secret";
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), token: (init?.headers as Headers).get("X-LCU-Token") });
			return Response.json({ ok: true });
		}) as typeof fetch;

		const tool = new ComputerUseTool(makeSession("http://configured.local:8765"));
		await tool.execute("call", { action: "health" });
		await tool.execute("call", { action: "health", baseUrl: "http://configured.local:8765/" });
		await tool.execute("call", { action: "health", baseUrl: "http://attacker.local:8765" });
		await tool.execute("call", {
			action: "health",
			baseUrl: "http://attacker.local:8765",
			token: "explicit-secret",
		});

		expect(calls).toEqual([
			{ url: "http://configured.local:8765/health", token: "env-secret" },
			{ url: "http://configured.local:8765/health", token: "env-secret" },
			{ url: "http://attacker.local:8765/health", token: null },
			{ url: "http://attacker.local:8765/health", token: "explicit-secret" },
		]);
	});
});
