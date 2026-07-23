/**
 * Policy for the opt-in Repair Node (the success-path note built in
 * `@pit/agent`'s `tool-repair-note.ts`). The note helps a WEAK / open model
 * self-correct malformed tool arguments; strong frontier models don't need it
 * and the note costs context, so it is enabled per-model rather than globally.
 *
 * Rule (fixed, auditable): enable for every provider EXCEPT the native frontier
 * set. That is exactly where the open models the technique targets live —
 * DeepSeek / Qwen / Kimi / GLM / Llama served over OpenAI-compatible endpoints
 * (providers `opencode`, `opencode-go`, `zai`, and any custom OpenAI-compat URL).
 * The note is only ever appended when a real repair happened. Strong model ids
 * routed via weak providers (e.g. Claude on a custom OpenAI-compat endpoint) are
 * also OFF so frontier models don't pay the cost.
 *
 * Override with `PIT_TOOL_REPAIR_NOTE` (`1`/`true`/`yes` to force on, anything
 * else to force off); unset falls back to the auto rule above.
 */

import { isTruthyEnvFlag } from "../utils/env-flags.ts";

/** Native frontier providers whose models don't need the Repair Node nudge. */
const STRONG_NATIVE_PROVIDERS = new Set(["anthropic", "openai-codex"]);

/** Frontier model ids even when served via weak/open providers (e.g. OpenRouter). */
const STRONG_MODEL_ID_PATTERN = /claude|gpt-4|gpt-5|gemini|o[1-9]/i;

/**
 * Weak/open-model classification, shared by every harness feature that scales
 * itself down for models outside the native frontier set: on for weak/open
 * providers and model ids, off for the frontier set (see module doc for the
 * exact rule). Originally the Repair Node's own predicate; also backs the P7
 * tiered system prompt (`system-prompt.ts`'s `resolvePromptProfile`) — same
 * classification, different consumer.
 */
export function isWeakModelProfile(model: { provider: string; id?: string }): boolean {
	if (STRONG_NATIVE_PROVIDERS.has(model.provider)) {
		return false;
	}
	if (model.id !== undefined && STRONG_MODEL_ID_PATTERN.test(model.id)) {
		return false;
	}
	return true;
}

/** Auto rule: on for weak/open providers and model ids outside the frontier set. */
export function shouldAutoEmitRepairNotes(model: { provider: string; id?: string }): boolean {
	return isWeakModelProfile(model);
}

/**
 * Resolve whether to emit Repair Node notes for `model`: the `PIT_TOOL_REPAIR_NOTE`
 * override wins when set, otherwise the auto rule decides. Passed to the Agent as
 * a function so the gate re-evaluates against the CURRENT model each run (the
 * model can change between runs via the fallback chain or `/model`).
 */
export function resolveEmitRepairNotes(model: { provider: string; id?: string }): boolean {
	const raw = process.env.PIT_TOOL_REPAIR_NOTE;
	if (raw !== undefined && raw.trim() !== "") {
		return isTruthyEnvFlag(raw);
	}
	return shouldAutoEmitRepairNotes(model);
}
