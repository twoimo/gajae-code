#!/usr/bin/env bun
/**
 * Loopback OpenAI-compatible gateway over GJC's local Cursor OAuth.
 * Aside talks openai-completions; GJC streamSimple translates to cursor-agent.
 */
import { startAuthGateway } from "@gajae-code/ai/auth-gateway/server";
import {
	AuthStorage,
	type Api,
	getBundledModels,
	type Model,
} from "@gajae-code/ai/core";
import { getAgentDbPath, getAgentDir } from "@gajae-code/utils";

const BIND = process.env.GJC_CURSOR_GATEWAY_BIND || "127.0.0.1:18794";

function buildCursorCatalog(): Map<string, Model<Api>> {
	const modelById = new Map<string, Model<Api>>();
	for (const model of getBundledModels("cursor")) {
		if (!modelById.has(model.id)) modelById.set(model.id, model);
		const prefixed = `cursor/${model.id}`;
		if (!modelById.has(prefixed)) modelById.set(prefixed, model);
	}
	return modelById;
}

const dbPath = getAgentDbPath(getAgentDir());
const storage = await AuthStorage.create(dbPath, {
	sourceLabel: `local ${dbPath}`,
});
const snapshot = storage.exportSnapshot();
const hasCursor = snapshot.credentials.some((c) => c.provider === "cursor");
if (!hasCursor) {
	storage.close();
	throw new Error("no stored Cursor credential in GJC agent.db");
}

const modelById = buildCursorCatalog();
const handle = startAuthGateway({
	storage,
	bind: BIND,
	bearerTokens: [],
	version: "gjc-cursor-gateway",
	resolveModel: (id: string) => {
		const raw = (id || "").trim();
		return modelById.get(raw) || modelById.get(raw.replace(/^cursor\//, ""));
	},
	listModels: () => {
		const seen = new Set<string>();
		const out: Model<Api>[] = [];
		for (const model of modelById.values()) {
			if (seen.has(model.id)) continue;
			seen.add(model.id);
			out.push(model);
		}
		return out;
	},
});

process.stdout.write(`gjc-cursor-gateway listening on ${handle.url}\n`);
process.stdout.write(`auth: disabled (loopback) cursor models=${modelById.size}\n`);

const stop = async (signal: string) => {
	process.stdout.write(`\n${signal}, shutting down\n`);
	try {
		await handle.close();
	} finally {
		storage.close();
	}
	process.exit(0);
};
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

await new Promise(() => {});
