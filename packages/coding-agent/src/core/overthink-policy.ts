/**
 * Resolve the live overthink guard for the current model and settings.
 *
 * The overthink guard (stream interrupt on long reasoning / self-reversal
 * rumination) is permanently disabled for every model. Historical display
 * helpers and the tracker implementation remain in @pit/agent-core for
 * transcript restore and unit tests; the product path never arms the guard.
 */

import type { OverthinkGuardConfig, ThinkingLevel } from "@pit/agent-core";
import {
	DEFAULT_OVERTHINK_MAX_RETRIES_PER_TURN,
	DEFAULT_OVERTHINK_STRONG_TOKEN_THRESHOLD,
	DEFAULT_OVERTHINK_WEAK_TOKEN_THRESHOLD,
} from "@pit/agent-core";
import type { Model } from "@pit/ai";
import type { ResolvedOverthinkGuardSettings } from "./settings-manager.ts";

/** Disabled config returned for every model — overthink limiting is removed. */
const DISABLED_OVERTHINK_GUARD: OverthinkGuardConfig = {
	enabled: false,
	tokenThreshold: 0,
	maxRetriesPerTurn: 0,
};

/**
 * Always returns a disabled guard. The former per-provider thresholds,
 * thinking-level scaling, and modelOverrides no longer limit any model.
 */
export function resolveOverthinkGuardForModel(
	_model: Model<"openai-responses">,
	_thinkingLevel: ThinkingLevel | undefined,
	_settings: ResolvedOverthinkGuardSettings,
): OverthinkGuardConfig {
	return DISABLED_OVERTHINK_GUARD;
}

export function defaultOverthinkGuardSettings(): ResolvedOverthinkGuardSettings {
	return {
		enabled: false,
		weakTokenThreshold: DEFAULT_OVERTHINK_WEAK_TOKEN_THRESHOLD,
		strongTokenThreshold: DEFAULT_OVERTHINK_STRONG_TOKEN_THRESHOLD,
		maxRetriesPerTurn: DEFAULT_OVERTHINK_MAX_RETRIES_PER_TURN,
	};
}
