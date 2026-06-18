import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import computerUseDescription from "../prompts/tools/computer-use.md" with { type: "text" };
import type { ToolSession } from "./index";

const computerUseActionSchema = z.record(z.string(), z.unknown());

const computerUseSchema = z
	.object({
		action: z
			.enum(["health", "observe", "act", "act_and_observe", "accessibility_tree"] as const)
			.describe("LCU operation to run against the configured HTTP target."),
		baseUrl: z
			.string()
			.url()
			.optional()
			.describe("LCU HTTP API base URL. Defaults to computerUse.baseUrl or http://127.0.0.1:8765."),
		token: z
			.string()
			.optional()
			.describe(
				"Optional API token for LCU_API_TOKEN-protected targets. Prefer environment/config over inline tokens.",
			),
		actions: z
			.array(computerUseActionSchema)
			.optional()
			.describe("Provider-neutral LCU actions for act and act_and_observe."),
		includeScreenshot: z
			.boolean()
			.optional()
			.describe("Include observation screenshots as image output when present. Defaults to true."),
		maxNodes: z.number().int().positive().optional().describe("Accessibility tree max_nodes."),
		maxDepth: z.number().int().positive().optional().describe("Accessibility tree max_depth."),
	})
	.strict();

type ComputerUseParams = z.infer<typeof computerUseSchema>;

export interface ComputerUseToolDetails {
	action: ComputerUseParams["action"];
	baseUrl: string;
	status: number;
	backend?: string;
	width?: number;
	height?: number;
	hasScreenshot?: boolean;
}

interface LcuObservation {
	screenshot_base64?: string;
	mime_type?: string;
	width?: number;
	height?: number;
	backend?: string;
	display?: string;
	active_window?: string | null;
	warnings?: string[];
}

interface LcuActionResult {
	ok?: boolean;
	message?: string;
	error?: string | null;
}

interface LcuActAndObserveResponse {
	results?: LcuActionResult[];
	observation?: LcuObservation;
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function readObservation(value: unknown): LcuObservation | undefined {
	if (!value || typeof value !== "object") return undefined;
	return value as LcuObservation;
}

function summarizeJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function summarizeObservation(observation: LcuObservation): string {
	const lines = ["LCU observation:"];
	if (observation.backend) lines.push(`backend: ${observation.backend}`);
	if (observation.width !== undefined && observation.height !== undefined) {
		lines.push(`size: ${observation.width}x${observation.height}`);
	}
	if (observation.display) lines.push(`display: ${observation.display}`);
	if (observation.active_window) lines.push(`active_window: ${observation.active_window}`);
	if (observation.warnings && observation.warnings.length > 0) {
		lines.push(`warnings: ${observation.warnings.join(", ")}`);
	}
	return lines.join("\n");
}

function buildHeaders(token: string | undefined): Headers {
	const headers = new Headers({ "content-type": "application/json" });
	if (token) headers.set("X-LCU-Token", token);
	return headers;
}

function resolveToken(params: ComputerUseParams, configuredBaseUrl: string, baseUrl: string): string | undefined {
	if (params.token !== undefined) return params.token;
	if (baseUrl === trimTrailingSlash(configuredBaseUrl)) return Bun.env.LCU_API_TOKEN;
	return undefined;
}

async function readJsonResponse(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return { text };
	}
}

export class ComputerUseTool implements AgentTool<typeof computerUseSchema, ComputerUseToolDetails> {
	readonly name = "computer_use";
	readonly label = "ComputerUse";
	readonly summary = "Control a Computer Use Bridge HTTP target";
	readonly description: string;
	readonly parameters = computerUseSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = prompt.render(computerUseDescription);
	}

	async execute(
		_toolCallId: string,
		params: ComputerUseParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ComputerUseToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ComputerUseToolDetails>> {
		const configuredBaseUrl = this.#session.settings.get("computerUse.baseUrl") ?? "http://127.0.0.1:8765";
		const baseUrl = trimTrailingSlash(params.baseUrl ?? configuredBaseUrl);
		const token = resolveToken(params, configuredBaseUrl, baseUrl);
		const headers = buildHeaders(token);
		const includeScreenshot = params.includeScreenshot ?? true;

		const path = this.#pathFor(params.action);
		const init = this.#requestInit(params, headers, signal);
		const response = await fetch(`${baseUrl}${path}`, init);
		const body = await readJsonResponse(response);
		if (!response.ok) {
			return {
				content: [
					{ type: "text", text: `LCU ${params.action} failed (${response.status}):\n${summarizeJson(body)}` },
				],
				isError: true,
				details: { action: params.action, baseUrl, status: response.status },
			};
		}

		const observation = this.#extractObservation(params.action, body);
		const content: AgentToolResult<ComputerUseToolDetails>["content"] = [];
		if (observation) {
			content.push({ type: "text", text: summarizeObservation(observation) });
			if (includeScreenshot && observation.screenshot_base64) {
				content.push({
					type: "image",
					data: observation.screenshot_base64,
					mimeType: observation.mime_type ?? "image/png",
				});
			}
		} else {
			content.push({ type: "text", text: `LCU ${params.action} response:\n${summarizeJson(body)}` });
		}

		return {
			content,
			details: {
				action: params.action,
				baseUrl,
				status: response.status,
				backend: observation?.backend,
				width: observation?.width,
				height: observation?.height,
				hasScreenshot: observation?.screenshot_base64 !== undefined,
			},
		};
	}

	#pathFor(action: ComputerUseParams["action"]): string {
		switch (action) {
			case "health":
				return "/health";
			case "observe":
				return "/observe";
			case "act":
				return "/act";
			case "act_and_observe":
				return "/act-and-observe";
			case "accessibility_tree":
				return "/accessibility/tree";
		}
	}

	#requestInit(params: ComputerUseParams, headers: Headers, signal: AbortSignal | undefined): RequestInit {
		if (params.action === "health" || params.action === "observe") {
			return { method: "GET", headers, signal };
		}
		const body = this.#requestBody(params);
		return { method: "POST", headers, body: JSON.stringify(body), signal };
	}

	#requestBody(params: ComputerUseParams): Record<string, unknown> {
		switch (params.action) {
			case "act":
				return { actions: params.actions ?? [] };
			case "act_and_observe":
				return { actions: params.actions ?? [], observe: true };
			case "accessibility_tree":
				return { max_nodes: params.maxNodes, max_depth: params.maxDepth };
			case "health":
			case "observe":
				return {};
		}
	}

	#extractObservation(action: ComputerUseParams["action"], body: unknown): LcuObservation | undefined {
		if (action === "observe") return readObservation(body);
		if (action !== "act_and_observe" || !body || typeof body !== "object") return undefined;
		return (body as LcuActAndObserveResponse).observation;
	}
}
