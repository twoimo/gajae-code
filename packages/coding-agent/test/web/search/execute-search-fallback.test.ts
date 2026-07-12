import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "../../../src/session/auth-storage";
import { ToolAbortError, ToolError } from "../../../src/tools/tool-errors";
import { runSearchQuery } from "../../../src/web/search";
import * as provider from "../../../src/web/search/provider";
import type { SearchParams } from "../../../src/web/search/providers/base";
import { SearchProviderError, type SearchProviderId, type SearchResponse } from "../../../src/web/search/types";

function fakeProvider(
	id: SearchProviderId,
	search: (params: SearchParams) => Promise<SearchResponse>,
): provider.SearchProvider {
	return { id, label: id, isAvailable: () => true, search };
}

const authStorage = {} as AuthStorage;

afterEach(() => vi.restoreAllMocks());

describe("executeSearch fallback", () => {
	it("passes explicit years through unchanged", async () => {
		const search = vi.fn(async () => ({ provider: "exa" as const, sources: [] }));
		vi.spyOn(provider, "resolveProviderChain").mockResolvedValue([fakeProvider("exa", search)]);

		await runSearchQuery({ query: "compare releases from 2020 and 2029" }, { authStorage });

		expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: "compare releases from 2020 and 2029" }));
	});

	it("falls through after a no-citation generic failure and preserves ordering", async () => {
		const calls: string[] = [];
		vi.spyOn(provider, "resolveProviderChain").mockResolvedValue([
			fakeProvider("openai-compatible", async () => {
				calls.push("generic");
				throw new SearchProviderError("openai-compatible", "no citations", 424);
			}),
			fakeProvider("exa", async () => {
				calls.push("exa");
				return { provider: "exa", sources: [{ title: "Exa", url: "https://exa.example" }] };
			}),
		]);
		const result = await runSearchQuery({ query: "anything" }, { authStorage });
		expect(calls).toEqual(["generic", "exa"]);
		expect(result.content[0]?.text).toContain("https://exa.example");
	});

	it("rethrows caller abort instead of falling through", async () => {
		const second = vi.fn();
		vi.spyOn(provider, "resolveProviderChain").mockResolvedValue([
			fakeProvider("openai-compatible", async () => {
				throw new DOMException("aborted", "AbortError");
			}),
			fakeProvider("exa", second),
		]);
		const ac = new AbortController();
		ac.abort();
		await expect(runSearchQuery({ query: "anything" }, { authStorage, signal: ac.signal })).rejects.toBeInstanceOf(
			ToolAbortError,
		);
		expect(second).not.toHaveBeenCalled();
	});

	it("throws a ToolError with diagnostics when all providers fail", async () => {
		vi.spyOn(provider, "resolveProviderChain").mockResolvedValue([
			fakeProvider("openai-compatible", async () => {
				throw new SearchProviderError("openai-compatible", "no citations", 424);
			}),
			fakeProvider("exa", async () => {
				throw new Error("network unavailable");
			}),
		]);

		const search = runSearchQuery({ query: "anything" }, { authStorage });
		await expect(search).rejects.toBeInstanceOf(ToolError);
		await expect(search).rejects.toThrow("All web search providers failed: no citations; exa: network unavailable");
	});
});
