/**
 * Grounding for the DEFAULT `in-turn` verification mode.
 *
 * In `in-turn` mode the harness runs nothing after the reply: the model is told
 * via the system prompt to run the project's check BEFORE its final answer. That
 * is cheap and Claude-Code-like, but it is 100% honour-based — a model that edits
 * files and never runs the check is indistinguishable from one that did.
 *
 * This closes the loop WITHOUT the post-turn machinery: at the end of a cycle
 * that touched files and ran no verification-class command, the session records a
 * `quality.in-turn-check` diagnostic and injects ONE corrective turn asking for
 * the check. It never blocks `goal_complete` and never runs the check itself —
 * the point is to make the honour-gap observable and self-correcting, not to
 * rebuild the post-turn gate.
 *
 * Bounded like the todo-cadence reminder: after {@link IN_TURN_CHECK_MAX_IGNORED}
 * unheeded corrections it stops for the rest of the session (recording
 * `in-turn-check-gave-up`) rather than paying context on every turn of a model
 * that will not comply.
 */

import { isTruthyEnvFlag } from "../../utils/env-flags.ts";

/** Consecutive unheeded corrections after which the steer stops for the session. */
export const IN_TURN_CHECK_MAX_IGNORED = 2;

/** Kill-switch: `PIT_NO_INTURN_CHECK_STEER=1` restores the pure honour-based mode. */
export function isInTurnCheckSteerDisabled(): boolean {
	return isTruthyEnvFlag(process.env.PIT_NO_INTURN_CHECK_STEER);
}

export interface InTurnCheckState {
	/** The cycle armed the gate: a successful write/edit/mutating bash. */
	touchedFiles: boolean;
	/** A verification-class command (test/typecheck/lint) ran during the cycle. */
	ranCheck: boolean;
	/** Detected or configured project check command; null when none exists. */
	checkCommand: string | null;
	/** How many corrections have already gone unheeded this session. */
	ignoredStreak: number;
	/** Turn was interrupted/aborted — never correct on a half-finished cycle. */
	aborted: boolean;
}

export type InTurnCheckDecision = { action: "none" } | { action: "give-up" } | { action: "steer"; prompt: string };

/**
 * Decide what the end of an `in-turn` cycle deserves. Pure: the session supplies
 * the state, this owns the policy.
 */
export function decideInTurnCheckSteer(state: InTurnCheckState): InTurnCheckDecision {
	// Nothing was modified, or the model already verified — the honour path worked.
	if (!state.touchedFiles || state.ranCheck) return { action: "none" };
	// An aborted/interrupted turn is not evidence of skipping the check.
	if (state.aborted) return { action: "none" };
	// No check command to ask for: the guideline itself is inert in this project.
	if (!state.checkCommand) return { action: "none" };
	if (state.ignoredStreak >= IN_TURN_CHECK_MAX_IGNORED) return { action: "give-up" };
	return { action: "steer", prompt: buildInTurnCheckPrompt(state.checkCommand) };
}

/**
 * The corrective turn. Deliberately phrased as the missing STEP, not as a verdict
 * on the work: the model may well have finished correctly, it just cannot claim so
 * on an unrun check.
 */
export function buildInTurnCheckPrompt(checkCommand: string): string {
	return [
		`You modified files this turn but never ran the project's check (\`${checkCommand}\`).`,
		"Run it now and fix what it surfaces before reporting this task as done.",
		"If the check is genuinely not applicable to this change, say so explicitly in one line instead of running it.",
	].join(" ");
}
