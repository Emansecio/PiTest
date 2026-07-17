/**
 * Per-tool, per-target retry budget surfaced INTO the error payload.
 *
 * Pit already has Tier-4 error hints and repair notes (corrective content), plus
 * a per-turn per-tool-NAME failure budget that fires a separate steer at
 * exhaustion. What it lacked is an explicit remaining-budget COUNTER shown inline
 * on each failing tool result, so the model can see "attempts on edit for this
 * target: 2/3" the moment it fails and decide between one more try, a different
 * approach, or surfacing the blocker. Design ported from forgecode's `orch.rs`
 * error_tracker (which force-completes on exhaustion; Pit softens that to strong
 * steering — Pit's permission layers own blocking, and a hard block here would
 * fight the existing guard tiers).
 *
 * The counter is keyed by (toolName, primary-target): the path-like argument when
 * present, else a stable hash of the whole argument set. It counts CONSECUTIVE
 * failures for that key, resets on a success for that key or on a new user turn.
 *
 * Surfaced via the Tier-4 {@link ToolErrorHintRegistry}: {@link createRetryBudgetHintRule}
 * returns a rule that appends one `[hint]` line to the failing result's text —
 * the same additive channel every other error hint uses, so it never changes the
 * error status or the original error text.
 *
 * Kill-switch `PIT_NO_TOOL_RETRY_BUDGET=1`; budget size `PIT_TOOL_RETRY_BUDGET`
 * (default 3).
 */

import type { ToolErrorHintRule } from "@pit/agent-core";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import { fingerprintToolArgsExact } from "./tool-call-stats.ts";

/** Default consecutive-failure budget before the appended line escalates. */
export const DEFAULT_TOOL_RETRY_BUDGET = 3;

/** Argument keys that name a primary file target, in priority order. */
const TARGET_PATH_KEYS = ["path", "file_path", "file"] as const;

/** True when the retry-budget feature is disabled via `PIT_NO_TOOL_RETRY_BUDGET`. */
export function isToolRetryBudgetDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_NO_TOOL_RETRY_BUDGET);
}

/**
 * Resolve the per-target failure budget from `PIT_TOOL_RETRY_BUDGET`. A positive
 * integer wins; anything invalid (NaN, <= 0, non-integer) falls back to the
 * default (fail-open, never zero — a zero budget would be a permanent block).
 */
export function resolveToolRetryBudgetMax(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PIT_TOOL_RETRY_BUDGET;
	if (raw === undefined || raw.trim() === "") return DEFAULT_TOOL_RETRY_BUDGET;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_TOOL_RETRY_BUDGET;
	return Math.floor(parsed);
}

/** Extract the primary path-like argument, if any, for target keying. */
function primaryTarget(args: unknown): string {
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		for (const key of TARGET_PATH_KEYS) {
			const value = record[key];
			if (typeof value === "string" && value.length > 0) return value;
		}
	}
	// No path-like target — fall back to a stable hash of the whole arg set so a
	// tool like bash still gets a per-invocation-shape budget rather than lumping
	// every bash failure onto one key.
	return `#${fingerprintToolArgsExact(args)}`;
}

/**
 * Stable key for a (toolName, target) pair. NUL-separated so a tool name that
 * contains the target text cannot collide with a different pair.
 */
export function retryBudgetTargetKey(toolName: string, args: unknown): string {
	return `${toolName}\u0000${primaryTarget(args)}`;
}

/** Result of folding one failure into the budget. */
export interface RetryBudgetObservation {
	/** Consecutive failure count for this (tool, target) key, including this one. */
	count: number;
	/** The configured budget. */
	max: number;
	/** True once `count >= max` — the appended line escalates to a hard instruction. */
	exhausted: boolean;
}

/**
 * Tracks consecutive failures per (tool, target) key within a turn/task window.
 * Also memoises per tool-call-id so a double-applied hint pass counts a failure
 * only once. Reset per new user turn ({@link reset}); a success for a key clears
 * just that key ({@link observeSuccess}).
 */
export class ToolRetryBudgetTracker {
	private readonly failures = new Map<string, number>();
	private readonly perCall = new Map<string, RetryBudgetObservation>();

	/**
	 * Fold one failing tool call into the budget. Idempotent per `callId`: a second
	 * call with the same id (a re-applied hint pass) returns the first observation
	 * without double-counting.
	 */
	observeFailure(callId: string, key: string, max: number): RetryBudgetObservation {
		const memo = this.perCall.get(callId);
		if (memo) return memo;
		const count = (this.failures.get(key) ?? 0) + 1;
		this.failures.set(key, count);
		const observation: RetryBudgetObservation = { count, max, exhausted: count >= max };
		this.perCall.set(callId, observation);
		return observation;
	}

	/** A success for this (tool, target) key resets its consecutive-failure streak. */
	observeSuccess(key: string): void {
		this.failures.delete(key);
	}

	/** Drop the per-call memo once the call has fully finished (bounds memory). */
	forgetCall(callId: string): void {
		this.perCall.delete(callId);
	}

	/** Reset every counter — called on a new user turn. */
	reset(): void {
		this.failures.clear();
		this.perCall.clear();
	}
}

/**
 * Build the single line appended to a failing tool result. Below the budget it is
 * an informational counter; at/after exhaustion it escalates to an explicit
 * instruction to change approach (never a block — Pit's permission layers own
 * blocking).
 */
export function buildRetryBudgetLine(toolName: string, observation: RetryBudgetObservation): string {
	const { count, max, exhausted } = observation;
	if (exhausted) {
		return (
			`attempts on \`${toolName}\` for this target: ${count}/${max} — retry budget exhausted. ` +
			"Repeating the same attempt will keep failing; switch to a different tool or approach, " +
			"or explain the blocker to the user."
		);
	}
	return `attempts on \`${toolName}\` for this target: ${count}/${max} — after the limit, change approach or explain the blocker.`;
}

/**
 * Build the Tier-4 hint rule that appends the retry-budget line to any failing
 * tool result. The rule runs inside the hint registry's `apply` (post-hoc, error
 * results only), which is the point where the LIVE failure count is known, so the
 * counter shown is always current. `appliesTo: "*"` — every tool participates.
 *
 * Environment is read at fire time so a mid-session flag flip (tests, tuning)
 * takes effect immediately: `PIT_NO_TOOL_RETRY_BUDGET` disables it, and
 * `PIT_TOOL_RETRY_BUDGET` sets the budget.
 */
export function createRetryBudgetHintRule(
	tracker: ToolRetryBudgetTracker,
	env: NodeJS.ProcessEnv = process.env,
): ToolErrorHintRule {
	return {
		id: "tool-retry-budget",
		appliesTo: "*",
		matcher: ({ call, result }) => {
			if (isToolRetryBudgetDisabled(env)) return false;
			// The registry only applies on errors, but guard defensively: never count a
			// result explicitly marked non-error.
			if (result.isError === false) return false;
			const max = resolveToolRetryBudgetMax(env);
			const key = retryBudgetTargetKey(call.name, call.arguments);
			tracker.observeFailure(call.id, key, max);
			return true;
		},
		hint: ({ call }) => {
			// Recompute nothing — reuse the memoised observation stamped by the matcher
			// for this call id (idempotent), so matcher and hint never disagree.
			const max = resolveToolRetryBudgetMax(env);
			const key = retryBudgetTargetKey(call.name, call.arguments);
			const observation = tracker.observeFailure(call.id, key, max);
			return buildRetryBudgetLine(call.name, observation);
		},
	};
}
