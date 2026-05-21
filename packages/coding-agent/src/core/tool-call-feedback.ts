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
 */

const MAX_ARGS_PREVIEW_CHARS = 400;
const MAX_ERROR_PREVIEW_CHARS = 600;

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

export interface DoomLoopReminderInput {
	toolName: string;
	/** Args of the repeated call (will be serialized for the prompt). */
	args?: unknown;
	/** How many consecutive identical invocations have been observed. */
	consecutiveCount: number;
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

	lines.push("<tool-error-reflection>");
	lines.push(`The previous call to \`${input.toolName}\` failed.`);
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
	lines.push("</tool-error-reflection>");

	return lines.join("\n");
}

/**
 * Build a reminder that the model appears stuck in a repetitive tool-call loop.
 * Suggests reassessment, alternative strategies, or asking for clarification.
 */
export function buildDoomLoopReminder(input: DoomLoopReminderInput): string {
	const argsPreview = previewArgs(input.args);
	const count = Math.max(0, Math.floor(input.consecutiveCount));
	const lines: string[] = [];

	lines.push("<doom-loop-reminder>");
	lines.push(
		`You have made ${count} consecutive identical calls to \`${input.toolName}\`. This indicates you are not making progress.`,
	);
	if (argsPreview) {
		lines.push("");
		lines.push("Repeated arguments:");
		lines.push("```json");
		lines.push(argsPreview);
		lines.push("```");
	}
	lines.push("");
	lines.push("Reassess before calling this tool again:");
	lines.push("- Has the previous result changed? If not, repeating will not help.");
	lines.push(
		"- Is there a **different tool**, a **different argument**, or a **different file/path** that would move the task forward?",
	);
	lines.push("- Do you need to **ask the user** for missing information?");
	lines.push("");
	lines.push("Do not repeat the same call with the same arguments. Pick a different action.");
	lines.push("</doom-loop-reminder>");

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
	return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
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
