/**
 * Non-UI policy helpers pulled out of the `InteractiveMode` class.
 *
 * These are pure decisions about session/tool state — the gearbox (which model
 * role should drive the next step) and a transcript predicate. They never touch
 * the widget tree, so they belong next to the mode, not inside it.
 */

/** The `plan` tool stamps `details.op` on every result; read it defensively for the gearbox. */
export function gearboxPlanOp(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const details = (result as { details?: { op?: unknown } }).details;
	return typeof details?.op === "string" ? details.op : undefined;
}

/** Flatten a tool result's text content so the gearbox can scan it for the retry-budget marker. */
export function gearboxResultText(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
			text += (block as { text: string }).text;
		}
	}
	return text;
}

/** Why the gearbox is being forced back up to the full-size role. */
export type GearboxUpshiftReason = "recovery" | "retry-exhausted" | "verify-failed";

/** What `tool_execution_end` should do to the gearbox. */
export type GearboxToolEndDecision =
	/** Anomaly: leave the smol role for this step. */
	| { action: "upshift"; reason: GearboxUpshiftReason }
	/** A brand-new plan clears prior poison (ids may be reused for fresh intents). */
	| { action: "clear-poison"; thenReevaluate: true }
	/** A plan op that only changes the step ladder. */
	| { action: "reevaluate" }
	| { action: "none" };

export interface GearboxToolEndInput {
	/** True while the gearbox holds the session in the smol role. */
	gearboxActive: boolean;
	/** Session recovery level; anything above "lean" means a doom-loop escalation. */
	recoveryLevel: string;
	toolName: string;
	result: unknown;
	isError: boolean;
}

/**
 * Observe a finished tool call for the gearbox: drive downshift/upshift off
 * `plan` ops and fire the anomaly upshift for retry-budget exhaustion or a
 * doom-loop recovery escalation.
 */
export function decideGearboxToolEnd(input: GearboxToolEndInput): GearboxToolEndDecision {
	// Doom-loop recovery: `_noteRecoverySignal` raises the session recovery level
	// off "lean" — the one public surface for those tiers (the footer reads it too).
	if (input.gearboxActive && input.recoveryLevel !== "lean") {
		return { action: "upshift", reason: "recovery" };
	}
	// Retry budget exhausted: surfaced only as the Tier-4 hint line appended to
	// the failing result (tool-retry-budget.ts). Match its stable exhaustion phrase.
	if (input.gearboxActive && input.isError && gearboxResultText(input.result).includes("retry budget exhausted")) {
		return { action: "upshift", reason: "retry-exhausted" };
	}
	if (input.toolName !== "plan") return { action: "none" };
	const op = gearboxPlanOp(input.result);
	if (input.isError) {
		// A failed `step_done` is a verify failure (or a rejected completion): the
		// step is not done — upshift for it immediately.
		if (op === "step_done") return { action: "upshift", reason: "verify-failed" };
		return { action: "none" };
	}
	if (op === "propose") return { action: "clear-poison", thenReevaluate: true };
	return { action: "reevaluate" };
}

/**
 * True when any assistant message has thinking content but no text — toggling
 * hide-thinking in grouped mode changes whether that message gets a bubble.
 */
export function sessionHasThinkingOnlyAssistant(messages: ReadonlyArray<unknown>): boolean {
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const message = raw as { role?: string; content?: unknown };
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		let hasText = false;
		let hasThinking = false;
		for (const block of message.content) {
			if (!block || typeof block !== "object") continue;
			const c = block as { type?: string; text?: string; thinking?: string };
			if (c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0) {
				hasText = true;
			}
			if (c.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim().length > 0) {
				hasThinking = true;
			}
		}
		if (hasThinking && !hasText) return true;
	}
	return false;
}
