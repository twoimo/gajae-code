import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { completeSimple, Model } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { ReadTool } from "@gajae-code/coding-agent/tools/read";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const visionModel: Model<"openai-responses"> = {
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
	contextWindow: 128000,
	maxTokens: 4096,
};

const textOnlyModel: Model<"openai-responses"> = {
	...visionModel,
	id: "gpt-4.1",
	input: ["text"],
};

interface CreateSessionOptions {
	availableModels?: Model<"openai-responses">[];
	activeModel?: Model<"openai-responses">;
	configureVisionRole?: boolean;
}

interface CompleteSimpleStub {
	calls: unknown[][];
	fn: typeof completeSimple;
}

function createSession(
	cwd: string,
	model: Model<"openai-responses">,
	apiKey: string | undefined = "test-key",
	settings = Settings.isolated(),
	options: CreateSessionOptions = {},
): ToolSession {
	const availableModels = options.availableModels ?? [model];
	const activeModel = options.activeModel ?? model;
	if (options.configureVisionRole !== false) {
		settings.setModelRole("vision", `${model.provider}/${model.id}`);
	}

	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getModelString: () => `${activeModel.provider}/${activeModel.id}`,
		getActiveModelString: () => `${activeModel.provider}/${activeModel.id}`,
		settings,
		modelRegistry: {
			getAvailable: () => availableModels,
			getApiKey: async () => apiKey,
		} as unknown as NonNullable<ToolSession["modelRegistry"]>,
	} as unknown as ToolSession;
}

function createCompleteSimpleSuccessStub(text: string): CompleteSimpleStub {
	const calls: unknown[][] = [];
	const fn = (async (...args: unknown[]) => {
		calls.push(args);
		return {
			role: "assistant",
			api: visionModel.api,
			provider: visionModel.provider,
			model: visionModel.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			content: [{ type: "text", text }],
		};
	}) as typeof completeSimple;

	return { calls, fn };
}

function createCompleteSimpleForbiddenStub(): CompleteSimpleStub {
	const calls: unknown[][] = [];
	const fn = (async (...args: unknown[]) => {
		calls.push(args);
		throw new Error("completeSimple should not be called");
	}) as typeof completeSimple;

	return { calls, fn };
}

describe("read image analysis (question param)", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-read-image-"));
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("sends image and question to the vision model and returns text-only result", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const stub = createCompleteSimpleSuccessStub("Detected text: Settings");
		const tool = new ReadTool(createSession(testDir, visionModel), stub.fn);
		const result = await tool.execute("call-1", {
			path: imagePath,
			question: "Extract visible UI labels.",
		});

		expect(result.content).toEqual([{ type: "text", text: "Detected text: Settings" }]);
		expect((result.content as Array<{ type: string }>).some(c => c.type === "image")).toBe(false);
		expect(stub.calls).toHaveLength(1);

		const request = stub.calls[0]?.[1] as { messages?: Array<{ content?: unknown }> } | undefined;
		const content = request?.messages?.[0]?.content;
		expect(Array.isArray(content)).toBe(true);
		const contentParts = (Array.isArray(content) ? content : []) as Array<{ type: string; text?: string }>;
		expect(contentParts[0]?.type).toBe("image");
		expect(contentParts[1]).toEqual({ type: "text", text: "Extract visible UI labels." });
	});

	it("embeds the image when no question is provided", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const stub = createCompleteSimpleForbiddenStub();
		const tool = new ReadTool(createSession(testDir, visionModel), stub.fn);
		const result = await tool.execute("call-embed", { path: imagePath });

		expect((result.content as Array<{ type: string }>).some(c => c.type === "image")).toBe(true);
		expect(stub.calls).toHaveLength(0);
	});

	// Strict-mode providers send required-but-nullable optionals, so a plain image read
	// arrives as `question: null` (or ""). These must embed the image, not delegate.
	it("embeds the image when question is null or empty (strict-provider nullable optional)", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const stub = createCompleteSimpleForbiddenStub();
		const tool = new ReadTool(createSession(testDir, visionModel), stub.fn);

		for (const question of [null, ""] as Array<string | null>) {
			const result = await tool.execute("call-embed-nullable", {
				path: imagePath,
				question: question as unknown as string | undefined,
			});
			expect((result.content as Array<{ type: string }>).some(c => c.type === "image")).toBe(true);
		}
		expect(stub.calls).toHaveLength(0);
	});

	it("records the resolved vision model in details", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const stub = createCompleteSimpleSuccessStub("ok");
		const tool = new ReadTool(createSession(testDir, visionModel), stub.fn);
		const result = await tool.execute("call-details", { path: imagePath, question: "What is visible?" });

		expect(result.details?.visionModel).toBe("openai/gpt-4o");
	});

	it("fails when images.blockImages is enabled", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const stub = createCompleteSimpleForbiddenStub();
		const settings = Settings.isolated({ "images.blockImages": true });
		const tool = new ReadTool(createSession(testDir, visionModel, "test-key", settings), stub.fn);

		await expect(tool.execute("call-blocked", { path: imagePath, question: "What is visible?" })).rejects.toThrow(
			/Image submission is disabled/i,
		);
		expect(stub.calls).toHaveLength(0);
	});

	it("uses pi/default when vision role is unset and default supports images", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const settings = Settings.isolated();
		settings.setModelRole("default", `${visionModel.provider}/${visionModel.id}`);

		const stub = createCompleteSimpleSuccessStub("Fallback default model used");
		const tool = new ReadTool(
			createSession(testDir, textOnlyModel, "test-key", settings, {
				configureVisionRole: false,
				availableModels: [textOnlyModel, visionModel],
				activeModel: textOnlyModel,
			}),
			stub.fn,
		);

		const result = await tool.execute("call-default", { path: imagePath, question: "What text is visible?" });
		expect(result.details?.visionModel).toBe("openai/gpt-4o");
		expect(stub.calls).toHaveLength(1);
		const selectedModel = stub.calls[0]?.[0] as { id?: string } | undefined;
		expect(selectedModel?.id).toBe("gpt-4o");
	});

	it("does not fall back to an arbitrary vision model when vision role is unset", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const settings = Settings.isolated();
		settings.setModelRole("default", `${textOnlyModel.provider}/${textOnlyModel.id}`);

		const stub = createCompleteSimpleForbiddenStub();
		const tool = new ReadTool(
			createSession(testDir, textOnlyModel, "test-key", settings, {
				configureVisionRole: false,
				availableModels: [textOnlyModel, visionModel],
				activeModel: textOnlyModel,
			}),
			stub.fn,
		);

		await expect(
			tool.execute("call-no-roulette", { path: imagePath, question: "What text is visible?" }),
		).rejects.toThrow(/modelRoles\.vision/);
		expect(stub.calls).toHaveLength(0);
	});

	it("fails when configured vision role does not resolve", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const settings = Settings.isolated();
		settings.setModelRole("vision", "openai/missing-vision-model");

		const stub = createCompleteSimpleForbiddenStub();
		const tool = new ReadTool(
			createSession(testDir, visionModel, "test-key", settings, {
				configureVisionRole: false,
				availableModels: [visionModel],
				activeModel: visionModel,
			}),
			stub.fn,
		);

		await expect(
			tool.execute("call-missing-vision-role", { path: imagePath, question: "What text is visible?" }),
		).rejects.toThrow(/Configured modelRoles\.vision .* did not resolve/);
		expect(stub.calls).toHaveLength(0);
	});

	it("does not use registry-order fallback when no configured or selected model resolves", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const settings = Settings.isolated();
		const stub = createCompleteSimpleForbiddenStub();
		const tool = new ReadTool(
			createSession(testDir, visionModel, "test-key", settings, {
				configureVisionRole: false,
				availableModels: [visionModel],
				activeModel: textOnlyModel,
			}),
			stub.fn,
		);

		await expect(
			tool.execute("call-no-registry-order-fallback", { path: imagePath, question: "What text is visible?" }),
		).rejects.toThrow(/Unable to resolve a model for image analysis/);
		expect(stub.calls).toHaveLength(0);
	});

	it("uses configured vision role when active model is text-only", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const settings = Settings.isolated();
		settings.setModelRole("default", `${textOnlyModel.provider}/${textOnlyModel.id}`);
		settings.setModelRole("vision", `${visionModel.provider}/${visionModel.id}`);

		const stub = createCompleteSimpleSuccessStub("Configured vision fallback used");
		const tool = new ReadTool(
			createSession(testDir, visionModel, "test-key", settings, {
				configureVisionRole: false,
				availableModels: [textOnlyModel, visionModel],
				activeModel: textOnlyModel,
			}),
			stub.fn,
		);

		const result = await tool.execute("call-vision-role", { path: imagePath, question: "What text is visible?" });
		expect(result.content).toEqual([{ type: "text", text: "Configured vision fallback used" }]);
		expect(result.details?.visionModel).toBe("openai/gpt-4o");
		expect(stub.calls).toHaveLength(1);
		const selectedModel = stub.calls[0]?.[0] as { id?: string } | undefined;
		expect(selectedModel?.id).toBe("gpt-4o");
	});

	it("fails with actionable error when resolved model does not support image input", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const stub = createCompleteSimpleForbiddenStub();
		const tool = new ReadTool(createSession(testDir, textOnlyModel), stub.fn);

		await expect(tool.execute("call-2", { path: imagePath, question: "What is visible?" })).rejects.toThrow(
			/does not support image input/i,
		);
		expect(stub.calls).toHaveLength(0);
	});

	it("fails with actionable error when API key is missing", async () => {
		const imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const stub = createCompleteSimpleForbiddenStub();
		const tool = new ReadTool(createSession(testDir, visionModel, ""), stub.fn);

		await expect(tool.execute("call-3", { path: imagePath, question: "What is visible?" })).rejects.toThrow(
			/No API key available/i,
		);
		expect(stub.calls).toHaveLength(0);
	});
});
