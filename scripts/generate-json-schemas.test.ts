import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { JSON_SCHEMA_OUTPUTS, stableJson } from "./generate-json-schemas";

function acceptsJsonSchemaFixture(schema: unknown, value: unknown): boolean {
	if (schema === true) return true;
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
	const definition = schema as {
		type?: string;
		properties?: Record<string, unknown>;
		additionalProperties?: boolean | unknown;
	};
	if (definition.type === "string") return typeof value === "string";
	if (definition.type === "boolean") return typeof value === "boolean";
	if (definition.type === "number") return typeof value === "number";
	if (definition.type !== "object" || !value || typeof value !== "object" || Array.isArray(value)) return false;
	for (const [key, nestedValue] of Object.entries(value)) {
		const nestedSchema = definition.properties?.[key];
		if (nestedSchema === undefined) {
			if (definition.additionalProperties === false) return false;
			if (definition.additionalProperties !== true && !acceptsJsonSchemaFixture(definition.additionalProperties, nestedValue)) return false;
		} else if (!acceptsJsonSchemaFixture(nestedSchema, nestedValue)) return false;
	}
	return true;
}

function configSchema(): unknown {
	return JSON_SCHEMA_OUTPUTS.find(output => output.path === "schemas/config.schema.json")?.schema;
}

describe("generated JSON Schemas", () => {
	it("matches checked-in schema artifacts", async () => {
		for (const output of JSON_SCHEMA_OUTPUTS) {
			const target = path.join(import.meta.dir, "..", output.path);
			const existing = await Bun.file(target).text();
			expect(existing).toBe(stableJson(output.schema));
		}
	});

	it("accepts documented Discord and Slack config while rejecting unknown chat properties", () => {
		const schema = configSchema();
		const completeConfig = {
			notifications: {
				enabled: true,
				discord: {
					botToken: "discord-bot-token",
					applicationId: "discord-application-id",
					guildId: "discord-guild-id",
					parentChannelId: "discord-parent-channel-id",
				},
				slack: {
					botToken: "slack-bot-token",
					appToken: "slack-app-token",
					workspaceId: "slack-workspace-id",
					channelId: "slack-channel-id",
				},
			},
		};

		expect(acceptsJsonSchemaFixture(schema, completeConfig)).toBe(true);
		expect(acceptsJsonSchemaFixture(schema, {
			...completeConfig,
			notifications: { ...completeConfig.notifications, discord: { ...completeConfig.notifications.discord, unknown: "value" } },
		})).toBe(false);
		expect(acceptsJsonSchemaFixture(schema, {
			...completeConfig,
			notifications: { ...completeConfig.notifications, slack: { ...completeConfig.notifications.slack, unknown: "value" } },
		})).toBe(false);
	});

	it("emits web search fallback item enum and provider webSearch enum", () => {
		const configSchema = JSON_SCHEMA_OUTPUTS.find(output => output.path === "schemas/config.schema.json")?.schema as any;
		const fallbackItems = configSchema.properties.web_search.properties.fallback.items;
		expect(fallbackItems.enum).toContain("exa");
		expect(fallbackItems.enum).not.toContain("openai-compatible");

		const modelsSchema = JSON_SCHEMA_OUTPUTS.find(output => output.path === "schemas/models.schema.json")?.schema as any;
		const providerSchema = modelsSchema.properties.providers.additionalProperties;
		expect(providerSchema.properties.webSearch.enum).toEqual(["on", "off", "auto"]);
	});
});
