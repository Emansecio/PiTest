/**
 * Structured feedback prompts for tool-call failures and doom-loops.
 *
 * Pure builders. Callers (extensions, the interactive shell, automation) decide
 * when to inject the returned markdown — usually via
 * `sessionManager.appendCustomMessageEntry(...)` or as a system-level reminder.
 *
 * The wording forces the model to articulate (a) what was wrong, (b) why, and
 * (c) the corrected invocation, rather than blindly retrying with the same
 * arguments. Inspired by the prompt patterns used in tailcallhq/forgecode.
 *
 * ## Steer format (prunability)
 *
 * Every steer here is emitted as a single self-contained
 * `<system-reminder>[kind] … </system-reminder>` block, exactly like the
 * overthink / TTSR steers in `@pit/agent-core`. That shape is what the N8
 * "consumed steering-reminder collapse" in `compaction/prune.ts` recognizes: it
 * matches a CONFIRMED opening marker and requires the sole `</system-reminder>`
 * terminator to close the block. A steer is course correction, so it stays FULL
 * text while it sits inside the prune protection window; once it scrolls out it
 * collapses to one line instead of riding every request forever.
 *
 * Two consequences for anyone editing these builders:
 *  - the marker must be the FIRST thing in the string and `</system-reminder>`
 *    the LAST — appending an escalation paragraph after the close tag silently
 *    makes the steer unprunable (that is why the doom-loop tiers render their
 *    extra line INSIDE the block, via `tier`);
 *  - every marker must also be registered in `STEERING_REMINDER_MATCHERS`
 *    (`compaction/prune.ts`), which imports these constants as the single
 *    source of truth.
 */

import { sliceSafe } from "../utils/surrogate.ts";

const MAX_ARGS_PREVIEW_CHARS = 400;
const MAX_ERROR_PREVIEW_CHARS = 600;

/** Terminator every steer block ends with (see the module note above). */
export const STEER_REMINDER_CLOSE = "</system-reminder>";

/**
 * Opening markers of the steers built here. Registered in `prune.ts`'s
 * `STEERING_REMINDER_MATCHERS` so the N8 collapse recognizes them.
 */
export const DOOM_LOOP_STEER_MARKER = "<system-reminder>[doom-loop]";
export const FAILURE_BUDGET_STEER_MARKER = "<system-reminder>[failure-budget]";
export const TOOL_ERROR_REFLECTION_STEER_MARKER = "<system-reminder>[tool-error]";

/**
 * The one piece of advice the whole loop/flailing family shares — doom-loop,
 * per-turn failure budget, repeated-error (cross-error) and stagnation all used
 * to spell out their own three-bullet variant of it, ~1.8k chars of near
 * duplicate text per bad turn. Each reminder now carries ONE specific line (which
 * tool, which error, how many turns) plus this body.
 */
export const LOOP_STEER_ADVICE =
	"You are repeating an approach that is not working. Stop, say in one line what is blocking you, then change strategy or ask the user.";

export interface ToolErrorReflectionInput {
	toolName: string;
	/** Raw arguments from the failing call. Serialized for the prompt. */
	args?: unknown;
	/** Plain-text error returned by the tool, if any. */
	errorMessage?: string;
	/**
	 * Optional remaining retry budget. When provided, the reminder surfaces it
	 * so the model can decide between retry, alternative tool, or escalation.
	 */
	attemptsLeft?: number;
}

/**
 * Doom-loop escalation tiers. The ladder itself (thresholds, latches, the
 * Tier-3 abort) lives in `turn-steering-engine.ts` — this only picks which extra
 * line the block carries, so each tier reads differently without re-explaining
 * the whole situation.
 */
export type DoomLoopTier = "reminder" | "pause" | "recovery";

export interface DoomLoopReminderInput {
	toolName: string;
	/** How many consecutive identical invocations have been observed. */
	consecutiveCount: number;
	/** Escalation tier; defaults to the Tier-1 soft `reminder`. */
	tier?: DoomLoopTier;
	/** Identical calls left before the Tier-3 abort. Rendered by the `pause` tier only. */
	remaining?: number;
}

export interface FailureBudgetReminderInput {
	toolName: string;
	/** Total failures of this tool (by name) so far in the current turn. */
	failureCount: number;
	/** The configured per-turn budget for a single tool. */
	maxPerTurn: number;
}

/**
 * Build a structured reflection prompt for the most recent failing tool call.
 *
 * The output is plain markdown intended to be injected into the conversation
 * as a hidden custom message (so it influences the next LLM turn without
 * cluttering the user-facing transcript).
 */
export function buildToolErrorReflection(input: ToolErrorReflectionInput): string {
	const argsPreview = previewArgs(input.args);
	const errorPreview = previewError(input.errorMessage);
	const lines: string[] = [];

	lines.push(`${TOOL_ERROR_REFLECTION_STEER_MARKER} The previous call to \`${input.toolName}\` failed.`);
	if (argsPreview) {
		lines.push("");
		lines.push("Arguments:");
		lines.push("```json");
		lines.push(argsPreview);
		lines.push("```");
	}
	if (errorPreview) {
		lines.push("");
		lines.push("Error:");
		lines.push("```");
		lines.push(errorPreview);
		lines.push("```");
	}
	if (typeof input.attemptsLeft === "number") {
		lines.push("");
		lines.push(`Retries remaining for this tool: ${Math.max(0, input.attemptsLeft)}.`);
	}
	lines.push("");
	lines.push("Before retrying, briefly answer:");
	lines.push("1. **What was wrong** with the call?");
	lines.push("2. **Why** did it fail (root cause, not symptom)?");
	lines.push(
		"3. **What is the corrected approach** — either fixed arguments, a different tool, or asking the user for input?",
	);
	lines.push("");
	lines.push("If the same call would fail again, do not repeat it.");
	lines.push(STEER_REMINDER_CLOSE);

	return lines.join("\n");
}

/**
 * Build a reminder that the model appears stuck in a repetitive tool-call loop.
 *
 * P3.9: the repeated arguments are NOT echoed. A doom-loop is by definition the
 * same args over and over, so the JSON block duplicated a payload that sits a few
 * lines above in the transcript — the tool name is the only part the steer has to
 * carry.
 *
 * The escalation lives in `tier`: `pause` adds the countdown to the abort,
 * `recovery` adds the decompose-and-switch instruction. Both render INSIDE the
 * `<system-reminder>` block so the steer stays collapsible (see the module note).
 */
export function buildDoomLoopReminder(input: DoomLoopReminderInput): string {
	const count = Math.max(0, Math.floor(input.consecutiveCount));
	const lines: string[] = [];

	lines.push(`${DOOM_LOOP_STEER_MARKER} You have made ${count} consecutive identical calls to \`${input.toolName}\`.`);
	lines.push(LOOP_STEER_ADVICE);
	if (input.tier === "pause") {
		const remaining = Math.max(0, Math.floor(input.remaining ?? 0));
		lines.push(`Do NOT repeat it — ${remaining} more identical call${remaining === 1 ? "" : "s"} aborts the turn.`);
	} else if (input.tier === "recovery") {
		lines.push(
			"STOP. Restate the goal in one sentence, list the sub-steps, then run ONLY sub-step 1 with a " +
				"different approach. Another repeat aborts the turn.",
		);
	}
	lines.push(STEER_REMINDER_CLOSE);

	return lines.join("\n");
}

/**
 * Build a forceful reminder fired when a single tool (by NAME) has exhausted its
 * per-turn failure budget. Unlike the doom-loop (identical repeats) and the
 * cross-error reminder (same error across approaches), this fires purely on the
 * COUNT of failures for one tool in the current turn — regardless of args or
 * error text. It tells an autonomous agent to stop burning the turn on one tool
 * and either change approach or explain the blocker.
 */
export function buildFailureBudgetReminder(input: FailureBudgetReminderInput): string {
	const count = Math.max(0, Math.floor(input.failureCount));
	const lines: string[] = [];

	lines.push(
		`${FAILURE_BUDGET_STEER_MARKER} \`${input.toolName}\` failed ${count} time${count === 1 ? "" : "s"} in ` +
			"this turn — per-turn budget exhausted.",
	);
	lines.push(LOOP_STEER_ADVICE);
	lines.push(STEER_REMINDER_CLOSE);

	return lines.join("\n");
}

function previewArgs(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	let serialized: string;
	try {
		serialized = JSON.stringify(value, null, 2);
	} catch {
		serialized = String(value);
	}
	if (!serialized) return undefined;
	return truncate(serialized, MAX_ARGS_PREVIEW_CHARS);
}

function previewError(message: string | undefined): string | undefined {
	if (!message) return undefined;
	const collapsed = message.replace(/\s+$/g, "");
	if (!collapsed) return undefined;
	return truncate(collapsed, MAX_ERROR_PREVIEW_CHARS);
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${sliceSafe(text, 0, max)}\n… [truncated ${text.length - max} chars]`;
}

// ============================================================================
// Decision helpers
//
// These pure functions decide *whether* a feedback message should be injected,
// based on settings and current state. The actual injection (via
// `sendCustomMessage`) is handled by the caller. Keeping the decision separate
// makes it cheap to unit-test the policy and lets non-agent contexts reuse it.
// ============================================================================

export interface DoomLoopDecisionInput {
	enabled: boolean;
	threshold: number;
	cooldownMs: number;
	consecutiveCount: number;
	lastFiredAt: number;
	now: number;
}

export interface DoomLoopDecisionOutput {
	fire: boolean;
	/** New value for `lastFiredAt`. Equal to `now` when firing, unchanged otherwise. */
	nextLastFiredAt: number;
}

/**
 * Decide whether a doom-loop reminder should fire given the current sequence,
 * configuration, and cooldown timestamp. Pure — does not mutate state.
 *
 * Fires iff: enabled AND `consecutiveCount >= threshold` AND
 *           `(now - lastFiredAt) >= cooldownMs`.
 */
export function decideDoomLoopReminder(input: DoomLoopDecisionInput): DoomLoopDecisionOutput {
	if (!input.enabled) return { fire: false, nextLastFiredAt: input.lastFiredAt };
	if (input.consecutiveCount < input.threshold) return { fire: false, nextLastFiredAt: input.lastFiredAt };
	if (input.now - input.lastFiredAt < input.cooldownMs) return { fire: false, nextLastFiredAt: input.lastFiredAt };
	return { fire: true, nextLastFiredAt: input.now };
}

export interface ErrorReflectionDecisionInput {
	enabled: boolean;
	isError: boolean;
}

/**
 * Decide whether an error reflection prompt should fire. Pure.
 *
 * Fires iff: enabled AND the tool result is an error.
 */
export function decideErrorReflection(input: ErrorReflectionDecisionInput): boolean {
	return input.enabled && input.isError;
}
