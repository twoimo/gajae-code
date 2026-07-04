#!/usr/bin/env bun

import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SCHEMA_PATH = path.join(ROOT, "schemas/app-server.schema.json");
const OUTPUT_PATH = path.join(import.meta.dir, "../src/generated/protocol.ts");

type Schema = boolean | SchemaObject;
type SchemaObject = {
	$ref?: string;
	title?: string;
	description?: string;
	type?: string | string[];
	enum?: unknown[];
	const?: unknown;
	anyOf?: Schema[];
	oneOf?: Schema[];
	allOf?: Schema[];
	properties?: Record<string, Schema>;
	required?: string[];
	additionalProperties?: Schema;
	items?: Schema;
};

type RootSchema = { definitions: Record<string, SchemaObject> };

const NAME_OVERRIDES: Record<string, string> = {
	"gjc/hostTools/call": "HostToolsCall",
	"gjc/hostTools/cancel": "HostToolsCancel",
	"gjc/event": "GjcEvent",
	"item/agentMessage/delta": "ItemAgentMessageDelta",
	"item/completed": "ItemCompleted",
	"item/started": "ItemStarted",
	"turn/completed": "TurnCompleted",
	"turn/started": "TurnStarted",
};

function refName(ref: string): string {
	const prefix = "#/definitions/";
	if (!ref.startsWith(prefix)) throw new Error(`Unsupported ref ${ref}`);
	return ref.slice(prefix.length);
}

function literal(value: unknown): string {
	return JSON.stringify(value);
}

function doc(description: unknown): string {
	if (typeof description !== "string" || description.length === 0) return "";
	const body = description
		.replaceAll("*/", "* /")
		.split("\n")
		.map(line => ` * ${line}`)
		.join("\n");
	return `/**\n${body}\n */\n`;
}

function typeFor(schema: Schema | undefined, currentName: string): string {
	if (schema === undefined || schema === true) return "JsonValue";
	if (schema === false) return "never";
	if (schema.$ref) return refName(schema.$ref);
	if (schema.const !== undefined) return literal(schema.const);
	if (schema.enum) return schema.enum.map(literal).join(" | ") || "never";
	if (schema.anyOf) return union(schema.anyOf.map(s => typeFor(s, currentName)));
	if (schema.oneOf) return union(schema.oneOf.map(s => typeFor(s, currentName)));
	if (schema.allOf) return schema.allOf.map(s => typeFor(s, currentName)).join(" & ");
	const schemaType = schema.type;
	if (Array.isArray(schemaType)) return union(schemaType.map(type => typeFor({ ...schema, type }, currentName)));
	if (schemaType === "null") return "null";
	if (schemaType === "string") return "string";
	if (schemaType === "integer" || schemaType === "number") return "number";
	if (schemaType === "boolean") return "boolean";
	if (schemaType === "array") return `${typeFor(schema.items, currentName)}[]`;
	if (schemaType === "object" || schema.properties) return objectType(schema, currentName);
	return "JsonValue";
}

function union(types: string[]): string {
	return [...new Set(types)].join(" | ");
}

function objectType(schema: SchemaObject, currentName: string): string {
	const properties = schema.properties ?? {};
	const required = new Set(schema.required ?? []);
	const lines = Object.entries(properties).map(([key, value]) => {
		const optional = required.has(key) ? "" : "?";
		return `\t${JSON.stringify(key)}${optional}: ${typeFor(value, currentName)};`;
	});
	if (schema.additionalProperties === true) lines.push("\t[key: string]: JsonValue | undefined;");
	else if (schema.additionalProperties) {
		lines.push(`\t[key: string]: ${typeFor(schema.additionalProperties, currentName)} | undefined;`);
	}
	if (lines.length === 0) return "Record<string, never>";
	return `{\n${lines.join("\n")}\n}`;
}

function envelopeName(method: string): string {
	return (
		NAME_OVERRIDES[method] ??
		method
			.split("/")
			.map(part =>
				part
					.replace(/[^a-zA-Z0-9]+/g, " ")
					.split(" ")
					.filter(Boolean)
					.map(word => word[0]!.toUpperCase() + word.slice(1))
					.join(""),
			)
			.join("")
	);
}

function serverNotificationTypes(schema: SchemaObject): string {
	const variants = schema.oneOf ?? [];
	const entries = variants.map(variant => {
		if (variant === false || variant === true || !variant.properties)
			throw new Error("Unsupported notification variant");
		const methodSchema = variant.properties.method;
		if (methodSchema === false || methodSchema === true || !methodSchema?.enum?.[0])
			throw new Error("Missing notification method enum");
		const method = String(methodSchema.enum[0]);
		const params = typeFor(variant.properties.params, "ServerNotificationEnvelope");
		return { method, params, name: envelopeName(method) };
	});
	const envelope = entries
		.map(({ method, params }) => `\t| { method: ${literal(method)}; params: ${params} }`)
		.join("\n");
	const map = entries.map(({ method, params }) => `\t${JSON.stringify(method)}: ${params};`).join("\n");
	const methodUnion = entries.map(({ method }) => literal(method)).join(" | ");
	return [
		"export type ServerNotificationEnvelope =",
		`${envelope};`,
		"",
		"export interface ServerNotificationMap {",
		map,
		"}",
		"",
		`export type ServerNotificationMethod = ${methodUnion};`,
	].join("\n");
}

export async function generateProtocolTypes(): Promise<string> {
	const root = (await Bun.file(SCHEMA_PATH).json()) as RootSchema;
	const chunks = [
		"// Generated by packages/gjc-app-server-client/scripts/generate.ts from schemas/app-server.schema.json.",
		"// Do not edit by hand.",
		"",
		"export type JsonPrimitive = string | number | boolean | null;",
		"export type JsonValue = JsonPrimitive | { [key: string]: JsonValue } | JsonValue[];",
		"",
	];

	for (const [name, schema] of Object.entries(root.definitions)) {
		if (name === "ServerNotificationEnvelope") {
			chunks.push(doc(schema.description) + serverNotificationTypes(schema), "");
			continue;
		}
		chunks.push(`${doc(schema.description)}export type ${name} = ${typeFor(schema, name)};`, "");
	}
	return `${chunks.join("\n").trimEnd()}\n`;
}

async function main(): Promise<void> {
	const check = process.argv.includes("--check");
	const content = await generateProtocolTypes();
	if (check) {
		const existing = await Bun.file(OUTPUT_PATH)
			.text()
			.catch(() => null);
		if (existing !== content) {
			console.error("Generated app-server client protocol types are out of date.");
			console.error("Run `bun --cwd=packages/gjc-app-server-client run generate` and commit the updated file.");
			process.exit(1);
		}
		return;
	}
	await Bun.write(OUTPUT_PATH, content);
	console.log(`Wrote ${path.relative(ROOT, OUTPUT_PATH)}`);
}

if (import.meta.main) await main();
