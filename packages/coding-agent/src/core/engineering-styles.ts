/**
 * Engineering style packs.
 *
 * Each style is a small, fixed set of guideline bullets that the agent harness
 * appends to the default system-prompt `Guidelines:` section. Styles encode
 * opinionated authoring philosophies (e.g. surgical edits, goal-driven
 * execution) that the user opts into via settings.
 *
 * Adding a new style: add the literal to {@link EngineeringStyle}, append a
 * `case` to {@link getEngineeringStyleGuidelines}, and update settings docs.
 */

export type EngineeringStyle = "default" | "karpathy";

/**
 * Return the guideline bullets that should be appended to the system prompt
 * for the given style. Returns an empty array for "default" (no extra bullets).
 *
 * Bullets are short, imperative, and self-contained so they survive the system
 * prompt's existing deduplication path in `buildSystemPrompt`.
 */
export function getEngineeringStyleGuidelines(style: EngineeringStyle): string[] {
	switch (style) {
		case "karpathy":
			return KARPATHY_GUIDELINE_BULLETS;
		default:
			return [];
	}
}

/**
 * Return the small always-on pointer for a style pack. The full guidance stays
 * in the matching skill and is loaded only when the task needs it.
 */
export function getEngineeringStylePromptGuidelines(style: EngineeringStyle): string[] {
	switch (style) {
		case "karpathy":
			return [
				"Keep changes minimal, use existing project patterns, surface uncertainty, and verify the result; load karpathy-guidelines for the full workflow when needed.",
			];
		default:
			return [];
	}
}

/**
 * Full bullets derived from Karpathy's LLM-coding observations
 * (https://x.com/karpathy/status/2015883857489522876). The matching skill
 * ships under `examples/skills/karpathy-guidelines/`; the runtime keeps only a
 * short pointer in the system prompt and loads the long form on demand.
 *
 * Trade-off: biases toward caution and explicit verification over raw speed.
 * For trivial tasks the model should still use judgment and skip ceremony.
 */
const KARPATHY_GUIDELINE_BULLETS: string[] = [
	"Think before coding: surface assumptions explicitly; when interpretations diverge, present them instead of silently picking one; stop and ask when genuinely blocked rather than guessing.",
	"Identify before changing: find the real code path and root cause before editing — read the involved code, trace data flow and call sites, and form an explicit hypothesis. Fix the cause, not the symptom (reproduce a bug first); reuse existing utilities and patterns instead of inventing parallel ones.",
	"Simplicity first: before writing new code, check whether the task can be skipped, solved by existing code, handled by the standard library, handled by native platform behavior, or handled by an already-installed dependency. Then write the minimum code that solves the stated problem — no speculative features, single-use abstractions, or error handling for impossible cases. If 200 lines could be 50, rewrite. Ask whether a senior engineer would call it overcomplicated.",
	"Surgical changes: every changed line must trace to the user's request. Match existing style. Do not refactor adjacent code, reformat, or remove pre-existing dead code unless asked; only clean up orphans your own change created.",
	"Goal-driven execution: turn the task into a verifiable goal (e.g. 'add validation' → 'write tests for invalid inputs, then make them pass'; 'fix the bug' → 'write a test that reproduces it, then make it pass'). For multi-step work, state a brief plan with a verify-step per item, then loop until each check passes.",
];
