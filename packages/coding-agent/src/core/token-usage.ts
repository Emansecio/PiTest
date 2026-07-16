import type { SubagentUsage } from "./coordinator/types.ts";

/** Provider usage fields used by Pit's consumed-token accounting. */
export interface TokenUsageComponents {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

const ZERO_SUBAGENT_USAGE: Readonly<SubagentUsage> = {
	inputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
	costUsd: 0,
};

function nonnegativeFinite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function addTokens(total: number, value: unknown): number {
	const component = nonnegativeFinite(value);
	if (total >= Number.MAX_SAFE_INTEGER || component >= Number.MAX_SAFE_INTEGER - total) {
		return Number.MAX_SAFE_INTEGER;
	}
	return total + component;
}

/** Inclusive provider consumption. Native totalTokens is intentionally ignored. */
export function consumedTokens(usage: TokenUsageComponents | null | undefined): number {
	if (!usage) return 0;
	let total = 0;
	total = addTokens(total, usage.input);
	total = addTokens(total, usage.output);
	total = addTokens(total, usage.cacheRead);
	return addTokens(total, usage.cacheWrite);
}

/** Aggregate assistant messages into the coordinator's token/cost usage shape. */
export function aggregateAssistantUsage(messages: readonly unknown[]): SubagentUsage {
	const aggregate = { ...ZERO_SUBAGENT_USAGE };
	for (const message of messages) {
		if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") continue;
		const usage = (message as { usage?: TokenUsageComponents }).usage;
		if (!usage) continue;
		aggregate.inputTokens = addTokens(aggregate.inputTokens, usage.input);
		aggregate.outputTokens = addTokens(aggregate.outputTokens, usage.output);
		aggregate.totalTokens = addTokens(aggregate.totalTokens, consumedTokens(usage));
		aggregate.costUsd += nonnegativeFinite(usage.cost?.total);
	}
	return aggregate;
}

/** Combine subagent usage values without mutating any input. */
export function mergeSubagentUsage(...usages: Array<SubagentUsage | null | undefined>): SubagentUsage {
	const aggregate = { ...ZERO_SUBAGENT_USAGE };
	for (const usage of usages) {
		if (!usage) continue;
		aggregate.inputTokens = addTokens(aggregate.inputTokens, usage.inputTokens);
		aggregate.outputTokens = addTokens(aggregate.outputTokens, usage.outputTokens);
		aggregate.totalTokens = addTokens(aggregate.totalTokens, usage.totalTokens);
		aggregate.costUsd += nonnegativeFinite(usage.costUsd);
	}
	return aggregate;
}
