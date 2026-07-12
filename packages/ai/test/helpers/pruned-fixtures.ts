/**
 * Synthetic model fixtures replacing built-in catalog entries for providers that
 * were pruned from the build (google, openai, openrouter, minimax, kimi-coding,
 * xiaomi). The API adapters they exercised (openai-completions / openai-responses)
 * are still shipped, so these tests keep validating adapter behavior with fixtures
 * whose fields mirror what scripts/generate-models.ts produced for the old catalog.
 */

import type { Model } from "../../src/types.js";

/** gpt-5.x ids that map thinking "off" to the explicit "none" reasoning effort. */
const OPENAI_RESPONSES_NONE_REASONING = new Set([
	"gpt-5.1",
	"gpt-5.2",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.5",
]);

/** Mirrors supportsOpenAiXhigh() in scripts/generate-models.ts. */
function supportsOpenAiXhigh(id: string): boolean {
	return (
		id.includes("gpt-5.2") ||
		id.includes("gpt-5.3") ||
		id.includes("gpt-5.4") ||
		id.includes("gpt-5.5") ||
		id.includes("gpt-5.6")
	);
}

/**
 * Synthetic OpenAI Responses model (formerly provider "openai"). The
 * thinkingLevelMap reproduces applyThinkingLevelMetadata()'s output so the
 * openai-responses adapter maps reasoning identically to the old catalog entry.
 */
export function openaiResponsesModel(id: string): Model<"openai-responses"> {
	const thinkingLevelMap: Model<"openai-responses">["thinkingLevelMap"] = {
		off: OPENAI_RESPONSES_NONE_REASONING.has(id) ? "none" : null,
		...(supportsOpenAiXhigh(id) ? { xhigh: "xhigh" as const } : {}),
	};
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		thinkingLevelMap,
		input: ["text", "image"],
		cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	};
}

/** Generic OpenAI-completions model (formerly provider "openai", e.g. gpt-4o-mini). */
export function openaiCompletionsModel(id = "gpt-4o-mini"): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

/** Synthetic Xiaomi MiMo model (formerly provider "xiaomi"). */
export function xiaomiModel(id = "mimo-v2.5-pro"): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "xiaomi",
		baseUrl: "https://api.xiaomimimo.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		compat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
	};
}

/** Synthetic OpenRouter model (formerly provider "openrouter"). */
export function openrouterModel(
	id: string,
	overrides?: Partial<Model<"openai-completions">>,
): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		...overrides,
	};
}
