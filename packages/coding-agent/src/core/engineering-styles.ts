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
 * Condensed bullets derived from Karpathy's LLM-coding observations
 * (https://x.com/karpathy/status/2015883857489522876). The full skill markdown
 * ships under `examples/skills/karpathy-guidelines/` for users who want the
 * long-form reference loadable as a skill file.
 *
 * Trade-off: biases toward caution and explicit verification over raw speed.
 * For trivial tasks the model should still use judgment and skip ceremony.
 */
const KARPATHY_GUIDELINE_BULLETS: string[] = [
	"Think before coding: surface assumptions explicitly; when multiple interpretations exist, present them instead of silently picking one; stop and ask if something is unclear.",
	"Simplicity first: write the minimum code that solves the stated problem — no speculative features, no single-use abstractions, no error handling for impossible scenarios. If 200 lines could be 50, rewrite.",
	"Surgical changes: every changed line must trace to the user's request. Match existing style. Do not refactor adjacent code, reformat, or remove pre-existing dead code unless asked. Only clean up orphans your own change created.",
	"Goal-driven execution: turn the task into a verifiable goal (e.g. 'add validation' → 'write tests for invalid inputs, then make them pass'). For multi-step work, state a brief plan with a verify-step per item, then loop until each check passes.",
];
