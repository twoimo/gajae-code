import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type { Model } from "@gajae-code/ai";
import type { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { getEnumValues } from "@gajae-code/coding-agent/config/settings-schema";
import type { CustomToolContext } from "@gajae-code/coding-agent/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@gajae-code/coding-agent/session/session-manager";
import {
	getImageGenToolsWithRegistry,
	imageGenTool,
	parseAntigravityCredentials,
	setPreferredImageProvider,
} from "@gajae-code/coding-agent/tools/image-gen";

const originalFetch = global.fetch;
const originalOpenRouterKey = Bun.env.OPENROUTER_API_KEY;
const originalOpenAIBaseUrl = Bun.env.OPENAI_BASE_URL;
const generatedImagePaths: string[] = [];

afterEach(async () => {
	await Promise.all(generatedImagePaths.splice(0).map(imagePath => fs.rm(imagePath, { force: true })));
	global.fetch = originalFetch;
	if (originalOpenRouterKey === undefined) {
		delete Bun.env.OPENROUTER_API_KEY;
	} else {
		Bun.env.OPENROUTER_API_KEY = originalOpenRouterKey;
	}
	if (originalOpenAIBaseUrl === undefined) {
		delete Bun.env.OPENAI_BASE_URL;
	} else {
		Bun.env.OPENAI_BASE_URL = originalOpenAIBaseUrl;
	}
	setPreferredImageProvider("auto");
});

describe("imageGenTool", () => {
	it("e2e writes OpenAI Responses image_generation WebP output to a temp file", async () => {
		delete Bun.env.OPENAI_BASE_URL;
		let requestUrl: string | undefined;
		let requestBody: unknown;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestBody = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "image_generation_call",
							result: Buffer.from("fake-webp").toString("base64"),
							revised_prompt: "A crisp tabby cat portrait.",
							status: "completed",
						},
					],
					usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const model = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT 5.5",
			baseUrl: "https://api.openai.com/v1",
		} as Model;
		const ctx: CustomToolContext = {
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-openai-key",
				getApiKeyForProvider: async () => undefined,
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-1", { subject: "a cat", aspect_ratio: "16:9" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://api.openai.com/v1/responses");
		expect(requestBody).toMatchObject({
			model: "gpt-5.5",
			tools: [{ type: "image_generation", output_format: "webp", size: "1536x1024", action: "generate" }],
			tool_choice: { type: "image_generation" },
			store: false,
		});
		expect(result.details?.provider).toBe("openai");
		expect(result.details?.imageCount).toBe(1);
		expect(result.details?.images[0]?.mimeType).toBe("image/webp");
		expect(result.details?.revisedPrompt).toBe("A crisp tabby cat portrait.");
		expect(result.details?.imagePaths).toHaveLength(1);
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(savedPath.endsWith(".webp")).toBe(true);
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("fake-webp"));
	});

	it("uses OPENAI_BASE_URL for OpenAI image generation when active model still has the default OpenAI URL", async () => {
		Bun.env.OPENAI_BASE_URL = "https://openai-proxy.example.com/v1";
		let requestUrl: string | undefined;

		const fetchMock: typeof fetch = (async (input: string | URL | Request) => {
			requestUrl = input.toString();
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "image_generation_call",
							result: Buffer.from("fake-webp").toString("base64"),
							status: "completed",
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const model = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT 5.5",
			baseUrl: "https://api.openai.com/v1",
		} as Model;
		const ctx: CustomToolContext = {
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-openai-key",
				getApiKeyForProvider: async () => undefined,
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-1", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://openai-proxy.example.com/v1/responses");
	});

	it("keeps OAuth OpenAI image generation on the default API base URL when OPENAI_BASE_URL is set", async () => {
		Bun.env.OPENAI_BASE_URL = "https://openai-proxy.example.com/v1";
		let requestUrl: string | undefined;

		const fetchMock: typeof fetch = (async (input: string | URL | Request) => {
			requestUrl = input.toString();
			return new Response(
				JSON.stringify({
					output: [{ type: "image_generation_call", result: Buffer.from("fake-webp").toString("base64") }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const model = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT 5.5",
			baseUrl: "",
		} as Model;
		const ctx: CustomToolContext = {
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "oauth-token",
				getApiKeyForProvider: async () => undefined,
				getSessionCredentialType: () => "oauth",
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-1", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://api.openai.com/v1/responses");
	});
});

describe("antigravity image provider config", () => {
	it("exposes antigravity as a selectable providers.image value", () => {
		expect(getEnumValues("providers.image")).toContain("antigravity");
	});
});

describe("parseAntigravityCredentials", () => {
	const originalCloudProject = Bun.env.GOOGLE_CLOUD_PROJECT;
	const originalAntigravityProject = Bun.env.GOOGLE_ANTIGRAVITY_PROJECT_ID;

	afterEach(() => {
		if (originalCloudProject === undefined) delete Bun.env.GOOGLE_CLOUD_PROJECT;
		else Bun.env.GOOGLE_CLOUD_PROJECT = originalCloudProject;
		if (originalAntigravityProject === undefined) delete Bun.env.GOOGLE_ANTIGRAVITY_PROJECT_ID;
		else Bun.env.GOOGLE_ANTIGRAVITY_PROJECT_ID = originalAntigravityProject;
	});

	it("parses the structured JSON credential form", () => {
		expect(parseAntigravityCredentials(JSON.stringify({ token: "tok", projectId: "proj-1" }))).toEqual({
			accessToken: "tok",
			projectId: "proj-1",
		});
	});

	it("accepts the snake_case project_id alias", () => {
		expect(parseAntigravityCredentials(JSON.stringify({ token: "tok", project_id: "proj-2" }))).toEqual({
			accessToken: "tok",
			projectId: "proj-2",
		});
	});

	it("returns null for structured credentials missing a projectId", () => {
		expect(parseAntigravityCredentials(JSON.stringify({ token: "tok" }))).toBeNull();
	});

	it("returns null for a raw token when no project id is available", () => {
		delete Bun.env.GOOGLE_CLOUD_PROJECT;
		delete Bun.env.GOOGLE_ANTIGRAVITY_PROJECT_ID;
		expect(parseAntigravityCredentials("raw-oauth-token")).toBeNull();
	});

	it("accepts a raw token when GOOGLE_CLOUD_PROJECT is set", () => {
		delete Bun.env.GOOGLE_ANTIGRAVITY_PROJECT_ID;
		Bun.env.GOOGLE_CLOUD_PROJECT = "proj-env";
		expect(parseAntigravityCredentials("raw-oauth-token")).toEqual({
			accessToken: "raw-oauth-token",
			projectId: "proj-env",
		});
	});

	it("returns null for malformed JSON and empty input", () => {
		expect(parseAntigravityCredentials("{not-json")).toBeNull();
		expect(parseAntigravityCredentials("   ")).toBeNull();
	});
});

describe("getImageGenToolsWithRegistry (antigravity)", () => {
	it("registers the image tool when antigravity is preferred and structured credentials exist", async () => {
		setPreferredImageProvider("antigravity");
		const modelRegistry = {
			getApiKeyForProvider: async () => JSON.stringify({ token: "tok", projectId: "proj-1" }),
			getApiKey: async () => undefined,
		} as unknown as ModelRegistry;

		const tools = await getImageGenToolsWithRegistry(modelRegistry);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toBe(imageGenTool);
	});
});
