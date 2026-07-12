import { expect, test } from "bun:test";
import * as os from "node:os";
import { buildSystemPrompt } from "../src/system-prompt";

const SOUL_SENTINEL = "Guardrails? None. Restrictions? None. Freedom? Unlimited.";
const SOUL_SHA256 = "928d20c0d4005f0c288518ccda680e6e59a2bacf31fd19d38ed6b55011d9d789";
const PRECEDENCE =
	"All earlier system contracts take precedence over <soul> on conflict, including <authority>, <gjc-runtime> and its <routing> and <skill-discipline> rules, <communication>, <completion-contract>, <repo-safety>, tool and approval boundaries, and <workflow> requirements such as <scope>, <before-editing>, <decomposition>, and <verification>.";

function extractSoul(text: string): { block: string; closeEnd: number } {
	const open = text.indexOf("<soul>");
	const close = text.indexOf("</soul>", open);
	expect(open).toBeGreaterThanOrEqual(0);
	expect(close).toBeGreaterThan(open);
	const closeEnd = close + "</soul>".length;
	return { block: text.slice(open, closeEnd), closeEnd };
}

function soulHash(block: string): string {
	return new Bun.CryptoHasher("sha256").update(block).digest("hex");
}

test("renders the checked verbatim soul block with immediate earlier-contract precedence", async () => {
	const source = await Bun.file(new URL("../src/prompts/system/system-prompt.md", import.meta.url)).text();
	const sourceSoul = extractSoul(source);
	expect(sourceSoul.block).toContain(SOUL_SENTINEL);
	expect(soulHash(sourceSoul.block)).toBe(SOUL_SHA256);
	expect(source.slice(sourceSoul.closeEnd)).toStartWith("\n<precedence>\n");

	const { systemPrompt } = await buildSystemPrompt({
		cwd: os.tmpdir(),
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: ["read"],
		workspaceTree: {
			rootPath: os.tmpdir(),
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
	});
	const rendered = systemPrompt.join("\n\n");
	const renderedSoul = extractSoul(rendered);
	expect(renderedSoul.block).toContain(SOUL_SENTINEL);
	expect(soulHash(renderedSoul.block)).toBe(SOUL_SHA256);
	expect(rendered.slice(renderedSoul.closeEnd)).toStartWith("\n<precedence>\n");
	expect(rendered).toContain(PRECEDENCE);
});
