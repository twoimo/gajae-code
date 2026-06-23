import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { getBundledModel } from "../src/models";
import { buildAnthropicClientOptions, buildAnthropicHeaders } from "../src/providers/anthropic";
import { isOAuthToken } from "../src/utils/anthropic-auth";
import { getOAuthProviders, refreshOAuthToken } from "../src/utils/oauth";
import {
	GLM_ZCODE_OAUTH_AUTHORIZE_URL,
	GLM_ZCODE_OAUTH_BROKER_TOKEN_URL,
	GLM_ZCODE_OAUTH_CLIENT_ID,
	GLM_ZCODE_OAUTH_REDIRECT_URI,
	GLM_ZCODE_PLAN_ANTHROPIC_BASE_URL,
	GlmZcodeOAuthFlow,
	isGlmZcodeOAuthConfigured,
	refreshGlmZcodeToken,
} from "../src/utils/oauth/glm-zcode";
import { withEnv } from "./helpers";

const originalFetch = global.fetch;
const USERINFO_URL = "https://chat.z.ai/api/oauth/userinfo";
const SUPPRESS_ENV = {
	GLM_ZCODE_API_KEY: undefined,
	ZAI_API_KEY: undefined,
	ZCODE_OAUTH_CLIENT_ID: undefined,
} as const;

// The ZCode JWT (broker data.token) is the GLM coding-plan model credential.
const ZCODE_JWT = jwt({ sub: "zcode-sub-id", email: "ZJwt@Example.com" });
const UPSTREAM_ZAI_TOKEN = "upstream-zai-access-token-value-1234567890";

function jwt(payload: Record<string, unknown>): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

interface MockOptions {
	expiresIn?: number;
	zcodeToken?: string;
	userinfo?: { email?: string; id?: string } | null;
	captureBroker?: (body: string) => void;
	brokerPayloadOverride?: unknown;
	brokerStatus?: number;
}

function routingFetch(options: MockOptions = {}) {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === GLM_ZCODE_OAUTH_BROKER_TOKEN_URL) {
			options.captureBroker?.(String(init?.body ?? ""));
			if (options.brokerStatus && options.brokerStatus >= 400) {
				return new Response("rejected", { status: options.brokerStatus });
			}
			return new Response(
				JSON.stringify(
					options.brokerPayloadOverride ?? {
						code: 0,
						data: {
							token: options.zcodeToken ?? ZCODE_JWT,
							zai: { access_token: UPSTREAM_ZAI_TOKEN },
							expires_in: options.expiresIn ?? 3600,
						},
					},
				),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url === USERINFO_URL) {
			if (options.userinfo === null) return new Response("no", { status: 404 });
			const data = options.userinfo ?? { email: "Member@Example.com", id: "account-xyz" };
			return new Response(JSON.stringify({ data }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		throw new Error(`Unexpected fetch: ${url}`);
	});
}

describe("GLM ZCode OAuth login provider", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-glm-zcode-oauth-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("registers glm-zcode as an available, opt-in-labeled login provider", () => {
		const provider = getOAuthProviders().find(p => p.id === "glm-zcode");
		expect(provider).toEqual({
			id: "glm-zcode",
			name: "GLM ZCode OAuth (unofficial, opt-in)",
			available: true,
		});
		expect(isGlmZcodeOAuthConfigured()).toBe(true);
	});

	it("uses the exact ZCode client id and custom-protocol redirect by default", () => {
		expect(GLM_ZCODE_OAUTH_CLIENT_ID).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
		expect(GLM_ZCODE_OAUTH_REDIRECT_URI).toBe("zcode://oauth/callback");
	});

	it("defaults the model base to the ZCode coding-plan gateway, not api.z.ai", () => {
		expect(GLM_ZCODE_PLAN_ANTHROPIC_BASE_URL).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic");
		const model = getBundledModel("glm-zcode", "glm-5.2");
		expect(model.baseUrl).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic");
		// ZCode source headers must accompany coding-plan requests.
		expect(model.headers?.["X-ZCode-Agent"]).toBe("glm");
		expect(model.headers?.["User-Agent"]).toMatch(/^ZCode\//);
	});

	it("builds the authorize URL with client id, custom redirect, response_type, and state", async () => {
		const flow = new GlmZcodeOAuthFlow(
			{ onAuth: () => {}, onPrompt: async () => "" },
			{ fetch: routingFetch() as unknown as typeof fetch },
		);
		const { url, instructions } = await flow.generateAuthUrl("state-123", GLM_ZCODE_OAUTH_REDIRECT_URI);
		const authUrl = new URL(url);
		expect(authUrl.origin + authUrl.pathname).toBe(GLM_ZCODE_OAUTH_AUTHORIZE_URL);
		expect(authUrl.searchParams.get("client_id")).toBe(GLM_ZCODE_OAUTH_CLIENT_ID);
		expect(authUrl.searchParams.get("redirect_uri")).toBe(GLM_ZCODE_OAUTH_REDIRECT_URI);
		expect(authUrl.searchParams.get("response_type")).toBe("code");
		expect(authUrl.searchParams.get("state")).toBe("state-123");
		expect(instructions ?? "").toMatch(/unofficial/i);
	});

	it("exchanges the code via the broker and maps the ZCode JWT to access", async () => {
		let brokerBody = "";
		const fetchMock = routingFetch({ captureBroker: body => (brokerBody = body) });
		const flow = new GlmZcodeOAuthFlow(
			{ onAuth: () => {}, onPrompt: async () => "" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		const credentials = await flow.exchangeToken("auth-code", "state-123", GLM_ZCODE_OAUTH_REDIRECT_URI);

		expect(JSON.parse(brokerBody)).toEqual({
			provider: "zai",
			code: "auth-code",
			redirect_uri: GLM_ZCODE_OAUTH_REDIRECT_URI,
			state: "state-123",
		});
		// The model credential is the ZCode JWT (data.token), NOT a z/login business token.
		expect(credentials.access).toBe(ZCODE_JWT);
		expect(credentials.refresh).toBe(UPSTREAM_ZAI_TOKEN);
		expect(credentials.email).toBe("member@example.com");
		expect(credentials.accountId).toBe("account-xyz");
		expect(credentials.expires).toBeGreaterThan(Date.now());
		expect(credentials.expires).toBeLessThanOrEqual(Date.now() + 3600 * 1000 - 60_000);
		// No direct call to api.z.ai/z-login is made during login.
		const calledUrls = fetchMock.mock.calls.map(c => String(c[0]));
		expect(calledUrls.some(u => u.includes("/api/auth/z/login"))).toBe(false);
	});

	it("accepts a pasted full zcode:// redirect URL as the code", async () => {
		const fetchMock = routingFetch();
		const flow = new GlmZcodeOAuthFlow(
			{ onAuth: () => {}, onPrompt: async () => "" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		const credentials = await flow.exchangeToken(
			"zcode://oauth/callback?code=pasted-code&state=state-123",
			"state-123",
			GLM_ZCODE_OAUTH_REDIRECT_URI,
		);
		expect(credentials.access).toBe(ZCODE_JWT);
		const brokerCall = fetchMock.mock.calls.find(c => String(c[0]) === GLM_ZCODE_OAUTH_BROKER_TOKEN_URL);
		expect(JSON.parse(String((brokerCall?.[1] as RequestInit).body)).code).toBe("pasted-code");
	});

	it("falls back to JWT identity decode when userinfo fails", async () => {
		const fetchMock = routingFetch({ userinfo: null });
		const flow = new GlmZcodeOAuthFlow(
			{ onAuth: () => {}, onPrompt: async () => "" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		const credentials = await flow.exchangeToken("auth-code", "state-123", GLM_ZCODE_OAUTH_REDIRECT_URI);
		expect(credentials.email).toBe("zjwt@example.com");
		expect(credentials.accountId).toBe("zcode-sub-id");
	});

	it("rejects a malformed broker payload missing the ZCode JWT", async () => {
		const fetchMock = routingFetch({ brokerPayloadOverride: { code: 0, data: { zai: { access_token: "x" } } } });
		const flow = new GlmZcodeOAuthFlow(
			{ onAuth: () => {}, onPrompt: async () => "" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		await expect(flow.exchangeToken("auth-code", "state-123", GLM_ZCODE_OAUTH_REDIRECT_URI)).rejects.toThrow(
			/broker response missing/i,
		);
	});

	it("redacts token-like strings echoed in a broker error body", async () => {
		const leaked = "leaked-secret-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const fetchMock = vi.fn(async () => new Response(`upstream said: ${leaked}`, { status: 500 }));
		const flow = new GlmZcodeOAuthFlow(
			{ onAuth: () => {}, onPrompt: async () => "" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		let caught: unknown;
		try {
			await flow.exchangeToken("auth-code", "state-123", GLM_ZCODE_OAUTH_REDIRECT_URI);
		} catch (error) {
			caught = error;
		}
		expect(String(caught)).not.toContain(leaked);
		expect(String(caught)).toContain("[redacted]");
	});

	it("refresh requires re-login (ZCode JWT has no documented refresh grant)", async () => {
		await expect(
			refreshGlmZcodeToken({ access: ZCODE_JWT, refresh: UPSTREAM_ZAI_TOKEN, expires: Date.now() - 1 }),
		).rejects.toThrow(/re-login required/i);
		// Same via the registry dispatcher.
		await expect(
			refreshOAuthToken("glm-zcode", { access: ZCODE_JWT, refresh: UPSTREAM_ZAI_TOKEN, expires: Date.now() - 1 }),
		).rejects.toThrow(/re-login required/i);
	});

	it("stores glm-zcode login as OAuth and getApiKey returns the ZCode JWT", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		const fetchMock = routingFetch();
		global.fetch = fetchMock as unknown as typeof fetch;

		let capturedState: string | undefined;
		await authStorage.login("glm-zcode", {
			onAuth: info => {
				capturedState = new URL(info.url).searchParams.get("state") ?? undefined;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => `zcode://oauth/callback?code=login-code&state=${capturedState ?? ""}`,
		});

		const credentials = store.listAuthCredentials("glm-zcode");
		expect(credentials).toHaveLength(1);
		expect(credentials[0]?.credential).toMatchObject({
			type: "oauth",
			access: ZCODE_JWT,
			refresh: UPSTREAM_ZAI_TOKEN,
		});
		await withEnv(SUPPRESS_ENV, async () => {
			expect(await authStorage?.getApiKey("glm-zcode", "session-glm-zcode")).toBe(ZCODE_JWT);
		});
	});

	it("coexists with the legacy zai API-key provider without cross-contamination", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		const fetchMock = routingFetch();
		global.fetch = fetchMock as unknown as typeof fetch;

		await authStorage.set("zai", { type: "api_key", key: "legacy-zai-key" });

		let capturedState: string | undefined;
		await authStorage.login("glm-zcode", {
			onAuth: info => {
				capturedState = new URL(info.url).searchParams.get("state") ?? undefined;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => `zcode://oauth/callback?code=login-code&state=${capturedState ?? ""}`,
		});

		const zaiCreds = store.listAuthCredentials("zai");
		expect(zaiCreds).toHaveLength(1);
		expect(zaiCreds[0]?.credential).toMatchObject({ type: "api_key" });
		const glmCreds = store.listAuthCredentials("glm-zcode");
		expect(glmCreds).toHaveLength(1);
		expect(glmCreds[0]?.credential).toMatchObject({ type: "oauth" });

		await withEnv(SUPPRESS_ENV, async () => {
			expect(await authStorage?.getApiKey("zai", "session-zai")).toBe("legacy-zai-key");
			expect(await authStorage?.getApiKey("glm-zcode", "session-glm")).toBe(ZCODE_JWT);
		});
	});

	it("exposes a statically bundled glm-zcode/glm-5.2 model selectable without live credentials", () => {
		const model = getBundledModel("glm-zcode", "glm-5.2");
		expect(model).toBeDefined();
		expect(model.provider).toBe("glm-zcode");
		expect(model.api).toBe("anthropic-messages");
	});

	it("sends Authorization: Bearer (no x-api-key, no claude-cli UA, no isOAuth) for the ZCode JWT", () => {
		// The gateway base is not api.anthropic.com → the non-Anthropic-base branch
		// emits a plain bearer. isOAuth must NOT be set; the ZCode JWT is not a
		// Claude OAuth token, so no Claude-Code header/tool-prefix behavior applies.
		expect(isOAuthToken(ZCODE_JWT)).toBe(false);
		const headers = buildAnthropicHeaders({
			apiKey: ZCODE_JWT,
			baseUrl: GLM_ZCODE_PLAN_ANTHROPIC_BASE_URL,
			modelHeaders: { "User-Agent": "ZCode/1.0.0", "X-ZCode-Agent": "glm" },
		});
		expect(headers.Authorization).toBe(`Bearer ${ZCODE_JWT}`);
		expect(headers["X-Api-Key"]).toBeUndefined();
		expect(headers["X-ZCode-Agent"]).toBe("glm");
		expect((headers["User-Agent"] ?? "").toLowerCase().startsWith("claude-cli")).toBe(false);
	});

	it("pins the request base to the ZCode gateway even if model.baseUrl was polluted to api.z.ai", () => {
		// Dynamic discovery / stale bundled catalogs / model cache can overwrite
		// model.baseUrl with api.z.ai (which rejects the ZCode JWT with 401). The
		// request-time resolver must force the coding-plan gateway regardless.
		const model = {
			id: "glm-5.2",
			name: "GLM-5.2 (ZCode)",
			api: "anthropic-messages",
			provider: "glm-zcode",
			baseUrl: "https://api.z.ai/api/anthropic",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 131072,
		} as unknown as Parameters<typeof buildAnthropicClientOptions>[0]["model"];
		const resolved = buildAnthropicClientOptions({ model, apiKey: ZCODE_JWT });
		expect(resolved.baseURL).toBe(GLM_ZCODE_PLAN_ANTHROPIC_BASE_URL);
		expect(resolved.isOAuthToken).toBe(false);
	});
});
