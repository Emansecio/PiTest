/**
 * Cross-error loop detection: catches the agent "flailing" — hitting the SAME
 * error over and over while varying the call.
 *
 * Complements the doom-loop detector, which only fires on *identical* repeated
 * calls (same tool, same args, same result). A model that reacts to a failure by
 * switching tool or tweaking arguments — yet keeps producing the same underlying
 * error — slips past the doom-loop (each call's args fingerprint differs) and
 * burns turns going nowhere. This tracker keys on the NORMALISED error
 * fingerprint instead of the call, and only fires when the streak spans at least
 * two distinct approaches, so it never double-reports a case the doom-loop
 * already owns.
 *
 * Pure tracker + decision fn + builder, mirroring `stagnation.ts` so the
 * agent-session wiring stays thin.
 */

import { sliceSafe } from "../utils/surrogate.ts";

/**
 * Counts the trailing run of tool errors sharing one normalised fingerprint, and
 * how many distinct call shapes (args fingerprints) appeared in that run. A
 * successful tool call, or an error with a different fingerprint, resets the run.
 * State only — the decision to fire lives in {@link decideCrossErrorReminder}.
 */
export class CrossErrorTracker {
	private fingerprint: string | undefined;
	private count = 0;
	private readonly approaches = new Set<string>();

	/**
	 * Fold one tool error into the run. `errorFingerprint` is the normalised error
	 * text; `argsFingerprint` identifies the call shape (any stable hash). Returns
	 * the current run length and the number of distinct approaches seen in it.
	 */
	observeError(errorFingerprint: string, argsFingerprint: string): { count: number; distinctApproaches: number } {
		if (errorFingerprint !== this.fingerprint) {
			this.fingerprint = errorFingerprint;
			this.count = 1;
			this.approaches.clear();
			this.approaches.add(argsFingerprint);
		} else {
			this.count += 1;
			this.approaches.add(argsFingerprint);
		}
		return { count: this.count, distinctApproaches: this.approaches.size };
	}

	/** A productive (non-error) tool result breaks the run. */
	observeSuccess(): void {
		this.reset();
	}

	get runLength(): number {
		return this.count;
	}

	reset(): void {
		this.fingerprint = undefined;
		this.count = 0;
		this.approaches.clear();
	}
}

export interface CrossErrorDecisionInput {
	enabled: boolean;
	/** Run length at which the reminder may fire. */
	threshold: number;
	/** Current run length (same normalised error in a row). */
	count: number;
	/** Distinct call shapes seen in the current run. */
	distinctApproaches: number;
	lastFiredAt: number;
	now: number;
	cooldownMs: number;
}

export interface CrossErrorDecisionOutput {
	fire: boolean;
	/** New value for `lastFiredAt`. Equals `now` when firing, unchanged otherwise. */
	nextLastFiredAt: number;
}

/**
 * Decide whether a cross-error reminder should fire. Pure — does not mutate state.
 *
 * Fires iff: enabled AND `count >= threshold` AND `distinctApproaches >= 2`
 *           (so a pure repeat owned by the doom-loop never triggers here) AND
 *           `(now - lastFiredAt) >= cooldownMs`. `lastFiredAt === 0` means "never
 *           fired", so the first reminder is never throttled.
 */
export function decideCrossErrorReminder(input: CrossErrorDecisionInput): CrossErrorDecisionOutput {
	if (!input.enabled) return { fire: false, nextLastFiredAt: input.lastFiredAt };
	if (input.count < input.threshold) return { fire: false, nextLastFiredAt: input.lastFiredAt };
	if (input.distinctApproaches < 2) return { fire: false, nextLastFiredAt: input.lastFiredAt };
	const neverFired = input.lastFiredAt === 0;
	const cooldownElapsed = input.now - input.lastFiredAt >= input.cooldownMs;
	if (!neverFired && !cooldownElapsed) return { fire: false, nextLastFiredAt: input.lastFiredAt };
	return { fire: true, nextLastFiredAt: input.now };
}

export interface CrossErrorReminderInput {
	/** Run length being reported. */
	count: number;
	/** Distinct approaches that all hit the same error. */
	distinctApproaches: number;
	/** A representative sample of the recurring error text. */
	sampleError?: string;
}

const MAX_SAMPLE_CHARS = 400;

/** Build the markdown reminder injected when the agent keeps hitting one error. */
export function buildCrossErrorReminder(input: CrossErrorReminderInput): string {
	const count = Math.max(0, Math.floor(input.count));
	const approaches = Math.max(0, Math.floor(input.distinctApproaches));
	const lines: string[] = [];
	lines.push("<repeated-error-reminder>");
	lines.push(
		`The last ${count} tool calls failed with the SAME underlying error across ${approaches} different ` +
			"approaches. Changing the tool or tweaking arguments is not addressing the root cause — the blocker " +
			"is the same each time.",
	);
	if (input.sampleError) {
		const sample =
			input.sampleError.length > MAX_SAMPLE_CHARS
				? `${sliceSafe(input.sampleError, 0, MAX_SAMPLE_CHARS)}…`
				: input.sampleError;
		lines.push("");
		lines.push("Recurring error:");
		lines.push("```");
		lines.push(sample);
		lines.push("```");
	}
	lines.push("");
	lines.push("Stop varying the call and fix the cause:");
	lines.push("- **Read the actual file/state** the error refers to instead of guessing at arguments.");
	lines.push("- If a path, permission, or precondition is wrong, correct THAT — not the surface call.");
	lines.push("- If you cannot resolve it, **ask the user** rather than trying more variations.");
	lines.push("</repeated-error-reminder>");
	return lines.join("\n");
}
