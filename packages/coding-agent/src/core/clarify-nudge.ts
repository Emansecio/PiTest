/**
 * Clarify nudge — "ask before you wander".
 *
 * When a MUTATING prompt (task-rigor >= 2) looks under-specified, this injects
 * a compact `<clarify_first>` directive telling the model it may ask the user
 * up to 3 targeted questions via the `ask` tool BEFORE its first mutating
 * action — instead of spending turns building something the user did not ask
 * for. It is a NUDGE, not a gate: the model proceeds without asking when the
 * request is actually clear, and nothing ever blocks a tool call.
 *
 * Ambiguity is heuristic and deliberately conservative: it fires ONLY on a
 * prompt that is both short (<160 chars) and anchor-less — no path, file
 * extension, backticked identifier, camelCase/snake_case symbol, or URL.
 * Detailed or paragraph-length prompts never fire. Deictic ("isso", "aquele
 * bug") and broad-scope ("melhora tudo") markers are reported as extra
 * signals but never trigger on their own.
 *
 * Interactive-only (the extension checks the UserInputBus listener) and
 * parent-only (registered in the main built-ins bundle, never propagated to
 * subagents). Fail-open; opt out with PIT_NO_CLARIFY_GATE=1.
 */

import { isTruthyEnvFlag } from "../utils/env-flags.ts";

export interface PromptClarity {
	ambiguous: boolean;
	/** Which vagueness signals fired (empty when not ambiguous). */
	signals: string[];
}

/**
 * Prompts at/over this length never fire: a user who wrote this much has
 * specified the task, even without symbols — and deictic words ("disso") in
 * longer prose usually have their referent right there in the prompt. Being
 * short is a PRECONDITION, not just one signal: this is a nudge, so a false
 * negative costs nothing while a false positive nags on a clear prompt.
 */
const SHORT_PROMPT_CHARS = 160;

/**
 * Concrete anchors that make a prompt self-grounding: a filesystem path or
 * extension, a backticked span, a camelCase/snake_case/PascalCase identifier,
 * or a URL. Any hit disables the nudge entirely.
 */
const ANCHOR_PATTERNS: RegExp[] = [
	/[\\/][\w.-]+[\\/]/, // path with at least two separators (src/core/…)
	/\.\w{1,4}(?=[\s:,)"'`]|$)/m, // file extension (utils.ts, config.json)
	/`[^`]+`/, // backticked identifier
	/\b[a-z][a-z0-9]*[A-Z]\w*\b/, // camelCase
	/\b[A-Z][a-z0-9]+[A-Z]\w*\b/, // PascalCase (two humps)
	/\b\w+_\w+\b/, // snake_case
	/\bhttps?:\/\//i, // URL
];

/** Vague back-references with no in-prompt referent. */
const DEICTIC_PATTERN =
	/\b(isso|isto|aquilo|disso|nisso|daquilo|aquele|aquela|como falamos|como conversamos|o de antes|that thing|that one|the thing|as discussed|like before|the same)\b/i;

/** Broad, target-less scope words ("melhora tudo", "optimize everything"). */
const BROAD_PATTERN =
	/\b(tudo|todos os|geral|inteiro|completo|do zero|melhor(ar|ia|e)?|otimiz\w*|arrum\w*|consert\w*|everything|entire|whole|all of|from scratch|improve|optimi[sz]e|clean ?up|polish)\b/i;

function hasConcreteAnchor(prompt: string): boolean {
	return ANCHOR_PATTERNS.some((pattern) => pattern.test(prompt));
}

/**
 * Assess whether a prompt looks under-specified. Pure and fail-open. Fires
 * only when the prompt is BOTH short and anchor-less; deictic/broad markers
 * are reported as extra signals when present (they sharpen the nudge text)
 * but never fire on their own.
 */
export function assessPromptClarity(prompt: string): PromptClarity {
	const normalized = prompt.trim();
	if (normalized.length === 0 || normalized.length >= SHORT_PROMPT_CHARS) return { ambiguous: false, signals: [] };
	if (hasConcreteAnchor(normalized)) return { ambiguous: false, signals: [] };

	const signals: string[] = ["short", "no-anchor"];
	if (DEICTIC_PATTERN.test(normalized)) signals.push("deictic-reference");
	if (BROAD_PATTERN.test(normalized)) signals.push("broad-scope");
	return { ambiguous: true, signals };
}

/** The `<clarify_first>` directive appended to the system prompt for this turn. */
export function formatClarifyNudge(clarity: PromptClarity): string {
	return (
		"<clarify_first>\n" +
		`This request looks under-specified (${clarity.signals.join(", ")}). ` +
		"Before your FIRST mutating action: if missing context could change WHAT you build " +
		"(target, scope, expected behavior, constraints), ask the user 2-3 targeted questions " +
		"in ONE round using the `ask` tool (max 3 questions, offer concrete options when possible). " +
		"Do NOT ask what the codebase can answer — read it instead. " +
		"If the request is actually clear, proceed without asking.\n" +
		"</clarify_first>"
	);
}

/** Opt-out: PIT_NO_CLARIFY_GATE disables the clarify nudge entirely (FAIL-OPEN). */
export function isClarifyNudgeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_NO_CLARIFY_GATE);
}
