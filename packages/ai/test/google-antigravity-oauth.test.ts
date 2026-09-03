import { afterEach, describe, expect, test } from "bun:test";
import { getOAuthApiKey, getOAuthProviders, refreshOAuthToken } from "../src/utils/oauth";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("google-antigravity OAuth wiring", () => {
	test("stays in the built-in OAuth provider list", () => {
		const provider = getOAuthProviders().find(item => item.id === "google-antigravity");
		expect(provider).toEqual({
			id: "google-antigravity",
			name: "Antigravity (Gemini 3, Claude, GPT-OSS)",
			available: true,
		});
	});

	test("getOAuthApiKey returns structured JSON including projectId", async () => {
		const expiresAt = Date.now() + 60 * 60 * 1000;
		const result = await getOAuthApiKey("google-antigravity", {
			"google-antigravity": {
				access: "access-token",
				refresh: "refresh-token",
				expires: expiresAt,
				projectId: "capable-flux-2jm35",
				email: "dev@example.com",
				accountId: "acct-1",
			},
		});

		expect(result).not.toBeNull();
		const payload = JSON.parse(result!.apiKey) as {
			token?: string;
			projectId?: string;
			refreshToken?: string;
			expiresAt?: number;
			email?: string;
			accountId?: string;
		};
		expect(payload.token).toBe("access-token");
		expect(payload.projectId).toBe("capable-flux-2jm35");
		expect(payload.refreshToken).toBe("refresh-token");
		expect(payload.expiresAt).toBe(expiresAt);
		expect(payload.email).toBe("dev@example.com");
		expect(payload.accountId).toBe("acct-1");
	});

	test("refreshOAuthToken rejects credentials missing projectId", async () => {
		await expect(
			refreshOAuthToken("google-antigravity", {
				access: "stale",
				refresh: "refresh-token",
				expires: Date.now() - 1,
			}),
		).rejects.toThrow("Antigravity credentials missing projectId");
	});

	test("refreshOAuthToken hits the Antigravity refresh path and keeps projectId", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ access_token: "fresh-access", expires_in: 3600 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as typeof fetch;

		const credentials = await refreshOAuthToken("google-antigravity", {
			access: "stale",
			refresh: "refresh-token",
			expires: Date.now() - 1,
			projectId: "capable-flux-2jm35",
			email: "dev@example.com",
		});

		expect(credentials.access).toBe("fresh-access");
		expect(credentials.refresh).toBe("refresh-token");
		expect(credentials.projectId).toBe("capable-flux-2jm35");
		expect(credentials.expires).toBeGreaterThan(Date.now());
	});
});
