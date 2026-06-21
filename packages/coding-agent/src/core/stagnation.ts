/**
 * Stagnation detection: catches the agent spinning on read-only work.
 *
 * Complements the doom-loop detector (which fires on *identical* repeated
 * calls). Stagnation fires when the agent runs many consecutive turns that
 * issue tool calls but never produce a file mutation (write/edit/edit_v2/
 * ast_edit) — burning context and tokens reading, searching, and shelling out
 * without making a change. Pure builders + decision fn + a one-integer tracker,
 * mirroring `tool-call-feedback.ts` so the agent-session wiring stays thin.
 */

import type { AgentMessage } from "@pit/agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@pit/ai";

/**
 * Tool names that produce a file mutation. A turn that successfully calls any
 * of these is "productive" and resets the stagnation streak.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(["write", "edit", "edit_v2", "ast_edit"]);

/**
 * Matches the command of a `bash` call that is verification/build work rather
 * than aimless shelling out. Running the project's tests, type-checker, linter,
 * or build IS the verify half of an edit→verify loop — so a turn whose only
 * activity is a passing/failing check is NOT stagnation. Word-boundary anchored
 * to avoid substring hits (`checkout` does not match `check`, `makefile` does
 * not match `make`). Inclusive on purpose: a false match merely declines to nag.
 */
export const VERIFICATION_CMD_RE =
	/\b(tests?|specs?|vitest|jest|mocha|pytest|rspec|phpunit|tsc|tsgo|typecheck|type-check|lint|biome|eslint|ruff|clippy|gofmt|build|check|make|gradle|mvn|cargo|pre-commit)\b/i;

/** True when a tool call is a `bash` running a verification/build/test/lint command. */
function isVerificationBash(call: ToolCall): boolean {
	if (call.name !== "bash") return false;
	const command = call.arguments?.command;
	return typeof command === "string" && VERIFICATION_CMD_RE.test(command);
}

export type TurnClass = "productive" | "neutral" | "nonproductive" | "text-only";

/**
 * Classify one finished turn for stagnation tracking.
 *
 * - `text-only`    — the assistant produced no tool calls (answering/finishing).
 * - `productive`   — at least one mutating tool call (or a delegated `task`)
 *                    did not error. Resets the streak.
 * - `neutral`      — the only forward activity was a successful verification
 *                    `bash` (tests/build/lint/typecheck). Leaves the streak
 *                    unchanged: verifying after an edit is not spinning, but it
 *                    is not itself the change either.
 * - `nonproductive`— had tool calls, none of which was a successful mutation,
 *                    delegation, or verification (pure read/grep/ls spinning).
 */
export function classifyTurn(message: AgentMessage, toolResults: ToolResultMessage[]): TurnClass {
	const toolCalls: ToolCall[] = [];
	if (message.role === "assistant") {
		for (const block of (message as AssistantMessage).content) {
			if (block.type === "toolCall") toolCalls.push(block);
		}
	}
	if (toolCalls.length === 0) return "text-only";

	const errorIds = new Set<string>();
	for (const result of toolResults) {
		if (result.isError) errorIds.add(result.toolCallId);
	}

	// A call with no error result (or no result at all) counts as success — lean
	// toward NOT firing so legitimate progress is never mistaken for stagnation.
	let sawVerification = false;
	for (const call of toolCalls) {
		if (errorIds.has(call.id)) continue;
		if (MUTATING_TOOL_NAMES.has(call.name)) return "productive";
		// Delegating real work to a subagent (`task`) is forward progress, not
		// spinning — the edits happen inside the child, invisible to this tracker.
		if (call.name === "task") return "productive";
		if (isVerificationBash(call)) sawVerification = true;
	}
	if (sawVerification) return "neutral";
	return "nonproductive";
}

/**
 * Counts the trailing run of non-productive turns. A productive or text-only
 * turn resets the streak to zero. State only — the decision to fire lives in
 * `decideStagnationReminder`.
 */
export class StagnationTracker {
	private count = 0;

	/** Fold one classified turn into the streak; returns the new streak length. */
	observe(turnClass: TurnClass): number {
		if (turnClass === "nonproductive") this.count += 1;
		else if (turnClass !== "neutral") this.count = 0;
		// `neutral` (a verification run) leaves the streak untouched: it neither
		// counts as spinning nor resets a real prior streak.
		return this.count;
	}

	get nonProductiveTurns(): number {
		return this.count;
	}

	reset(): void {
		this.count = 0;
	}
}

export type StagnationAction = "none" | "remind" | "pause";

export interface StagnationDecisionInput {
	enabled: boolean;
	softThreshold: number;
	hardThreshold: number;
	count: number;
	lastFiredAt: number;
	now: number;
	cooldownMs: number;
	/**
	 * Streak length at which the soft reminder last fired (0 = never). A second
	 * soft reminder additionally requires the streak to have GROWN by at least
	 * `step` turns since then — so an unchanging streak between soft and hard does
	 * not re-inject the identical reminder every cooldown window. Defaults to 0
	 * (treated as "never fired"), preserving the legacy cooldown-only behaviour
	 * for callers that do not track it.
	 */
	lastFiredCount?: number;
}

export interface StagnationDecisionOutput {
	action: StagnationAction;
	/** New value for `lastFiredAt`. Equals `now` when a message fires. */
	nextLastFiredAt: number;
	/** New value for `lastFiredCount`. Equals `count` when a soft reminder fires. */
	nextLastFiredCount: number;
}

/**
 * Decide whether to nudge (soft) or pause (hard) given the current streak.
 * Pure — does not mutate state.
 *
 * - `pause`  iff enabled AND `count >= hardThreshold` (ignores cooldown: the
 *            hard ceiling always escalates).
 * - `remind` iff enabled AND `count >= softThreshold` AND (never fired before
 *            OR cooldown elapsed) AND the streak has grown by at least `step`
 *            since the last fire. `lastFiredAt === 0` means "never fired", so
 *            the first reminder is never throttled — the cooldown only spaces
 *            out repeats and never depends on the magnitude of the clock. `step`
 *            = `ceil((hardThreshold - softThreshold) / 2)`: it caps the soft tier
 *            at ~2 reminders before the hard ceiling, so the same ~500-char text
 *            is not re-injected every cooldown window while the streak is flat.
 * - `none`   otherwise.
 */
export function decideStagnationReminder(input: StagnationDecisionInput): StagnationDecisionOutput {
	const lastFiredCount = input.lastFiredCount ?? 0;
	if (!input.enabled) {
		return { action: "none", nextLastFiredAt: input.lastFiredAt, nextLastFiredCount: lastFiredCount };
	}
	if (input.count >= input.hardThreshold) {
		return { action: "pause", nextLastFiredAt: input.now, nextLastFiredCount: lastFiredCount };
	}
	if (input.count >= input.softThreshold) {
		const neverFired = input.lastFiredAt === 0;
		const cooldownElapsed = input.now - input.lastFiredAt >= input.cooldownMs;
		const step = Math.max(1, Math.ceil((input.hardThreshold - input.softThreshold) / 2));
		const grewEnough = input.count - lastFiredCount >= step;
		if ((neverFired || cooldownElapsed) && grewEnough) {
			return { action: "remind", nextLastFiredAt: input.now, nextLastFiredCount: input.count };
		}
	}
	return { action: "none", nextLastFiredAt: input.lastFiredAt, nextLastFiredCount: lastFiredCount };
}

export interface StagnationReminderInput {
	/** Length of the non-productive streak being reported. */
	count: number;
	/** When true, render the stronger "execution paused" variant. */
	paused: boolean;
}

/** Build the markdown reminder injected when stagnation is detected. */
export function buildStagnationReminder(input: StagnationReminderInput): string {
	const count = Math.max(0, Math.floor(input.count));
	const lines: string[] = [];
	lines.push("<stagnation-reminder>");
	lines.push(
		`You have run ${count} consecutive turns that called tools but never edited a file ` +
			"(no write/edit). Reading, searching, and running commands without producing a change " +
			"burns context without progress.",
	);
	lines.push("");
	lines.push("Reassess before continuing:");
	lines.push("- Do you already have enough information to make the change? If so, **make the edit now**.");
	lines.push("- Are you re-reading or re-searching things you have already seen?");
	lines.push("- If the task is genuinely blocked, **ask the user** instead of investigating further.");
	if (input.paused) {
		lines.push("");
		lines.push(
			`**The harness has paused execution** after ${count} non-productive turns. ` +
				'Explain what is blocking the edit, or the user can type "continue" to resume.',
		);
	}
	lines.push("</stagnation-reminder>");
	return lines.join("\n");
}
