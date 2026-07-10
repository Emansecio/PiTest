import type {
	Api,
	CacheRetention,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ThinkingLevel,
} from "../types.ts";

export function resolveCacheRetention(
	cacheRetention: CacheRetention | undefined,
	defaultValue: CacheRetention = "short",
): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined") {
		const env = process.env.PIT_CACHE_RETENTION;
		if (env === "short" || env === "none" || env === "long") {
			return env;
		}
	}
	return defaultValue;
}

export function buildBaseOptions(_model: Model<Api>, options?: SimpleStreamOptions, apiKey?: string): StreamOptions {
	return {
		temperature: options?.temperature,
		maxTokens: options?.maxTokens,
		signal: options?.signal,
		apiKey: apiKey || options?.apiKey,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		headers: options?.headers,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		timeoutMs: options?.timeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		idleTimeoutMs: options?.idleTimeoutMs,
		metadata: options?.metadata,
	};
}

/** Budget keys only support the classic 4 levels; map opt-in extremes to high. */
type BudgetThinkingLevel = "minimal" | "low" | "medium" | "high";

function clampReasoning(effort: ThinkingLevel | undefined): BudgetThinkingLevel | undefined {
	if (!effort) return undefined;
	if (effort === "xhigh" || effort === "max" || effort === "ultra") return "high";
	return effort;
}

export function adjustMaxTokensForThinking(
	// Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	const defaultBudgets: ThinkingBudgets = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
	};
	const budgets = { ...defaultBudgets, ...customBudgets };

	const minOutputTokens = 1024;
	const level = clampReasoning(reasoningLevel)!;
	let thinkingBudget = budgets[level]!;
	const maxTokens =
		baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
	}

	return { maxTokens, thinkingBudget };
}
