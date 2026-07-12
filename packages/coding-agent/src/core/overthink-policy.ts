/**
 * Resolve the live overthink guard for the current model and settings.
 *
 * Weak/open providers (GLM, Qwen, DeepSeek via OpenAI-compat) get a lower
 * threshold; native frontier models get a higher ceiling so deliberate
 * reasoning is not cut prematurely.
 */

import type { OverthinkGuardConfig, ThinkingLevel } from "@pit/agent-core";
import {
	DEFAULT_OVERTHINK_MAX_RETRIES_PER_TURN,
	DEFAULT_OVERTHINK_STRONG_TOKEN_THRESHOLD,
	DEFAULT_OVERTHINK_WEAK_TOKEN_THRESHOLD,
} from "@pit/agent-core";
import type { Model } from "@pit/ai";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import type { ResolvedOverthinkGuardSettings } from "./settings-manager.ts";

/** Native frontier providers — higher threshold, not disabled. */
const STRONG_NATIVE_PROVIDERS = new Set(["anthropic", "openai-codex"]);

/**
 * Multiplier applied to the provider-class base threshold, keyed by thinking
 * level. Only used when the user has not set an explicit `tokenThreshold`
 * override. Monotonic and never zero, so the guard is never disabled purely
 * by scaling — `medium` reproduces today's defaults exactly.
 */
const THINKING_LEVEL_THRESHOLD_SCALE: Record<ThinkingLevel, number> = {
	off: 1,
	minimal: 0.5,
	low: 0.75,
	medium: 1,
	high: 1.5,
	xhigh: 2,
	max: 2,
	ultra: 2,
};

export function resolveOverthinkGuardForModel(
	model: Model<"openai-responses">,
	thinkingLevel: ThinkingLevel | undefined,
	settings: ResolvedOverthinkGuardSettings,
): OverthinkGuardConfig {
	if (isTruthyEnvFlag(process.env.PIT_NO_OVERTHINK_GUARD)) {
		return { enabled: false, tokenThreshold: 0, maxRetriesPerTurn: 0 };
	}
	if (!settings.enabled) {
		return { enabled: false, tokenThreshold: 0, maxRetriesPerTurn: 0 };
	}
	const isStrong = STRONG_NATIVE_PROVIDERS.has(model.provider);
	const maxRetriesPerTurn = settings.maxRetriesPerTurn;
	let tokenThreshold = settings.tokenThreshold;
	if (tokenThreshold === undefined) {
		const baseThreshold = isStrong ? settings.strongTokenThreshold : settings.weakTokenThreshold;
		const scale = thinkingLevel ? THINKING_LEVEL_THRESHOLD_SCALE[thinkingLevel] : 1;
		tokenThreshold = Math.round(baseThreshold * scale);
	}
	// Models without reasoning metadata still stream thinking on many OpenAI-compat
	// endpoints; only skip when the user explicitly turned thinking off AND the
	// model is a known frontier provider (they truly emit no thinking blocks).
	if (thinkingLevel === "off" && isStrong && !model.reasoning) {
		return { enabled: false, tokenThreshold: 0, maxRetriesPerTurn: 0 };
	}
	const watchTextDelta = settings.watchTextDelta ?? !isStrong;
	return {
		enabled: true,
		tokenThreshold,
		maxRetriesPerTurn,
		watchTextDelta,
	};
}

export function defaultOverthinkGuardSettings(): ResolvedOverthinkGuardSettings {
	return {
		enabled: true,
		weakTokenThreshold: DEFAULT_OVERTHINK_WEAK_TOKEN_THRESHOLD,
		strongTokenThreshold: DEFAULT_OVERTHINK_STRONG_TOKEN_THRESHOLD,
		maxRetriesPerTurn: DEFAULT_OVERTHINK_MAX_RETRIES_PER_TURN,
	};
}
