/**
 * Tool-call JSON repair — the agent-side entry to the shared coercion table.
 *
 * When a model emits malformed or type-mismatched tool arguments, this layer
 * silently fixes them BEFORE TypeBox validation instead of failing the call and
 * burning a model round-trip. It is native / default-on, with a single
 * kill-switch (`PIT_NO_TOOLCALL_REPAIR=1`).
 *
 * Precedence in the agent loop (see agent-loop.ts `prepareToolCall`):
 *   1. curated tool-rewrite registries WIN — they run first, unchanged;
 *   2. structural repair — only when the raw arguments are a STRING that fails
 *      JSON.parse (fence strip + `jsonrepair`);
 *   3. schema coercion — walk parsed args against the tool's JSON schema and
 *      coerce type mismatches (the higher-value tier);
 *   4. the existing `validateToolArguments` runs as today.
 *
 * P2-9: the coercion table itself (step 3) is no longer implemented here. It
 * lives in `@pit/ai` `utils/arg-coercion.ts`, next to the schema it walks, and is
 * shared with `validateToolArguments` — which used to run a SECOND coercion
 * pipeline with divergent rules (`enum_case_fix` only here, the `null`/`{}`
 * placeholder drop only there). One table, one taxonomy, one stats tally: this
 * module now owns only the structural tier, the kill-switch, and the attribution
 * of the coercions to a tool name.
 *
 * IMPORTANT LIMITATION (structural tier). By the time arguments reach the agent
 * loop the provider layer (`@pit/ai` `finalizeStreamingJson`) has ALREADY parsed
 * the tool-call JSON — running JSON.parse → `repairJson` → `partial-json`, and
 * on total failure yielding `{}` with a `_streamingParseError` marker. So a raw
 * malformed *whole-arguments* string almost never reaches this module: the
 * structural tier here is a defensive fallback (a custom streamFn, or a string
 * VALUE inside the args that is itself stringified JSON). The high-value work is
 * the schema-coercion tier, which the provider does NOT do. We deliberately do
 * not reach into `@pit/ai`'s parse path.
 */

import {
	coerceToolArguments,
	getToolArgCoercionStats,
	parseLooseJson,
	recordToolArgCoercions,
	resetToolArgCoercionStats,
	stripJsonCodeFence,
	type ToolArgCoercionKind,
	type ToolArgCoercionStats,
} from "@pit/ai";

/**
 * The distinct repair operations recorded for a tool call. Alias of the shared
 * taxonomy — the repair kinds ARE the taxonomy, with the rules that used to live
 * only in validation (`null_to_undefined`, `empty_object_to_undefined`,
 * `schema_convert_fallback`) folded in.
 */
export type ToolArgRepairKind = ToolArgCoercionKind;

export interface ToolArgRepairResult {
	/** The repaired arguments. Same reference as the input when nothing changed. */
	args: unknown;
	/** The repairs applied, in application order. Empty when untouched. */
	repairs: ToolArgRepairKind[];
}

/** Where agent-side coercions are attributed on the diagnostics channel. */
const REPAIR_SOURCE = "agent-loop.toolArgRepair";

// --- Kill-switch --------------------------------------------------------------

/**
 * `PIT_NO_TOOLCALL_REPAIR=1` disables BOTH tiers (structural + coercion) of THIS
 * layer. The curated tool-rewrite registries are unaffected — they run before it.
 * `validateToolArguments`' own fallback coercion is likewise unaffected: it is
 * the last line before a hard validation error and has never been gated by this
 * flag, so setting it can never turn a call that works today into a failure.
 */
export function isToolCallRepairDisabled(): boolean {
	const raw = typeof process !== "undefined" ? process.env.PIT_NO_TOOLCALL_REPAIR : undefined;
	if (!raw) return false;
	const v = raw.toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

// --- Stats / observability ----------------------------------------------------

export type ToolArgRepairStats = ToolArgCoercionStats;

/**
 * Snapshot of coercion counts per (tool, kind) — from this layer AND from
 * validation's fallback pass, which since P2-9 report into the same tally.
 */
export function getToolArgRepairStats(): ToolArgRepairStats {
	return getToolArgCoercionStats();
}

/** Reset the tally. Intended for tests. */
export function resetToolArgRepairStats(): void {
	resetToolArgCoercionStats();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- Public entry -------------------------------------------------------------

/**
 * Repair a tool call's raw arguments before validation. Two tiers:
 *   (A) structural — only when `rawArgs` is a STRING (defensive; normally the
 *       provider already parsed it — see the module-level limitation);
 *   (B) schema coercion — the shared `@pit/ai` table walked against `schema`.
 *
 * Returns the same `args` reference when nothing changed (so the caller's
 * validation fast-path and repair-note diff both see an untouched object). Never
 * throws — any internal parse failure leaves the value for `validateToolArguments`
 * to report. Records per-(tool, kind) stats + one diagnostic line per repair.
 */
export function repairToolArguments(rawArgs: unknown, schema: unknown, toolName: string): ToolArgRepairResult {
	if (isToolCallRepairDisabled()) return { args: rawArgs, repairs: [] };

	const repairs: ToolArgRepairKind[] = [];
	let args = rawArgs;

	// Tier A: structural repair of a whole-arguments STRING.
	if (typeof args === "string") {
		const fence = stripJsonCodeFence(args);
		const parsed = parseLooseJson(fence.text);
		if (isRecord(parsed)) {
			if (fence.stripped) repairs.push("fence_strip");
			repairs.push("structural_json");
			args = parsed;
		} else {
			// Unparseable — leave the original for validation to report.
			return { args: rawArgs, repairs: [] };
		}
	}

	// Tier B: the shared schema-coercion table.
	const coerced = coerceToolArguments(args, schema);
	args = coerced.args;
	repairs.push(...coerced.coercions);

	if (repairs.length > 0) recordToolArgCoercions(toolName, repairs, REPAIR_SOURCE);
	return { args, repairs };
}
