// Context-usage SSOT dogfood harness (G002): drive a real provider turn through
// the source-checkout SDK and verify AgentSession.getContextUsage() returns a
// provider-anchored snapshot (the v0.10.1 SSOT surface) with sane tokens/%.
import { createAgentSession } from "@gajae-code/coding-agent/sdk";

const { session } = await createAgentSession({
	noSession: true,
	toolNames: [],
});

const before = session.getContextUsage();
await session.prompt("Reply with exactly: SSOT-OK");
const after = session.getContextUsage();
const text = session.messages
	.filter(m => m.role === "assistant")
	.flatMap(m => (Array.isArray(m.content) ? m.content : []))
	.filter(b => b.type === "text")
	.map(b => b.text)
	.join("");

console.log(
	JSON.stringify(
		{
			replyContainsMarker: text.includes("SSOT-OK"),
			before: before ? { source: before.source, tokens: before.tokens } : null,
			after: after
				? { source: after.source, tokens: after.tokens, contextWindow: after.contextWindow, percent: after.percent }
				: null,
			anchored: after?.source === "provider_anchor",
			tokensPositive: (after?.tokens ?? 0) > 0,
			percentSane: after !== null && after.percent !== null && after.percent > 0 && after.percent < 100,
		},
		null,
		2,
	),
);
await session.dispose();
process.exit(0);
