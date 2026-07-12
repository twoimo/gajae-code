import type { KnownProvider } from "./types";

/**
 * Compact generated provider index for no-model startup paths.
 *
 * Keep this list in sync with the top-level keys in models.json. Unlike the
 * full catalog, this module is cheap to evaluate and does not parse model
 * records.
 */
export const BUNDLED_PROVIDER_HEADERS = [
	"alibaba-coding-plan",
	"amazon-bedrock",
	"anthropic",
	"azure-openai",
	"cerebras",
	"cloudflare-ai-gateway",
	"cursor",
	"deepseek",
	"deepinfra",
	"firepass",
	"fireworks",
	"github-copilot",
	"gitlab-duo",
	"google",
	"google-antigravity",
	"google-gemini-cli",
	"google-vertex",
	"groq",
	"huggingface",
	"kilo",
	"kimi-code",
	"litellm",
	"minimax",
	"minimax-cn",
	"minimax-code",
	"minimax-code-cn",
	"mistral",
	"moonshot",
	"nanogpt",
	"nvidia",
	"ollama-cloud",
	"openai",
	"openai-codex",
	"opencode",
	"opencode-go",
	"opencode-zen",
	"openrouter",
	"qianfan",
	"qwen-portal",
	"synthetic",
	"together",
	"venice",
	"vercel-ai-gateway",
	"xai",
	"xiaomi",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-sgp",
	"zai",
	"glm-zcode",
	"zenmux",
	"fugu",
] as const satisfies readonly KnownProvider[];

export type BundledProviderHeader = (typeof BUNDLED_PROVIDER_HEADERS)[number];
