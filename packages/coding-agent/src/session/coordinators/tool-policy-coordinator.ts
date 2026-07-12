import type { AgentTool } from "@gajae-code/agent-core";

/** Owns policy-wrapper identity so tool-set resets cannot retain stale policy state. */
export class ToolPolicyCoordinator {
	#cache = new WeakMap<AgentTool, Map<string, AgentTool>>();
	#version = 0;
	readonly #cacheKey: () => string;
	readonly #compose: <T extends AgentTool>(tool: T) => T;

	constructor(cacheKey: () => string, compose: <T extends AgentTool>(tool: T) => T) {
		this.#cacheKey = cacheKey;
		this.#compose = compose;
	}

	prepareTool<T extends AgentTool>(tool: T): T {
		const key = `${this.#cacheKey()}|version=${this.#version}`;
		let versions = this.#cache.get(tool);
		const cached = versions?.get(key);
		if (cached) return cached as T;
		const prepared = this.#compose(tool);
		if (!versions) {
			versions = new Map();
			this.#cache.set(tool, versions);
		}
		versions.set(key, prepared);
		return prepared;
	}

	prepareTools(tools: readonly AgentTool[]): AgentTool[] {
		return tools.map(tool => this.prepareTool(tool));
	}

	invalidate(): void {
		this.#version++;
	}
}
