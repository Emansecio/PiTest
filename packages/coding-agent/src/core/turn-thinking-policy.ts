/**
 * Adaptive per-turn thinking downshift.
 *
 * Inside a multi-turn agentic run, a turn that merely digests a *successful*
 * tool result rarely needs the user's full thinking budget. This policy
 * downshifts such turns to `"low"`, and restores the user's configured depth
 * the moment the environment signals difficulty (any tool error) — because the
 * model then needs to reason about the failure.
 *
 * The user's configured level is a CEILING: we never exceed it and never mutate
 * it. When the user already sits at or below the `"low"` floor
 * (`"off" | "minimal" | "low"`), there is nothing to downshift and this policy
 * stays out of the way entirely (returns undefined).
 *
 * The caller (the agent loop) treats a returned `thinkingLevel` as sticky: once
 * applied it PERSISTS into subsequent turns until overridden. So on every
 * invocation where we want a defined state we return an EXPLICIT level — both
 * the downshifted `"low"` and, when restoring, the user's own level — rather
 * than relying on `undefined` (which would leave a previously-set override in
 * place). We only return `undefined` when this policy should never engage.
 */
import type { ThinkingLevel } from "@pit/agent-core";
import type { ToolResultMessage } from "@pit/ai";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";

/** Levels at or below the downshift floor — nothing to gain from an override. */
const AT_OR_BELOW_FLOOR: ReadonlySet<ThinkingLevel> = new Set<ThinkingLevel>(["off", "minimal", "low"]);

/**
 * Decide the thinking level for the next turn of a run given the user's
 * configured (ceiling) level and the tool results the finished turn produced.
 *
 * Semantics:
 * - userLevel is "off" | "minimal" | "low"  → undefined (already at/below floor; never override).
 * - ≥1 tool result and NONE errored          → "low"     (downshift the follow-up turn).
 * - ANY tool result errored                  → userLevel (restore full depth for the failure).
 * - no tool results                          → userLevel (explicit restore; the override is sticky).
 */
export function resolveNextTurnThinkingLevel(
	userLevel: ThinkingLevel,
	toolResults: readonly ToolResultMessage[] | undefined,
): ThinkingLevel | undefined {
	// Kill-switch: never touch the thinking level when disabled.
	if (isTruthyEnvFlag(process.env.PIT_NO_ADAPTIVE_THINKING)) return undefined;

	// Already at or below the floor — no downshift is possible, so stay inert.
	if (AT_OR_BELOW_FLOOR.has(userLevel)) return undefined;

	const results = toolResults ?? [];

	// No tool results this turn: explicitly restore the user's level. Cheap
	// safety because any prior downshift override is sticky.
	if (results.length === 0) return userLevel;

	// Any error → the model must think about the failure: restore full depth.
	const anyError = results.some((r) => r.isError);
	if (anyError) return userLevel;

	// A clean batch of successful tool results → downshift the follow-up turn.
	return "low";
}
