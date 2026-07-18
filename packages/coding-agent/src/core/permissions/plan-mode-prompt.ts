/**
 * System-prompt section injected while the permission mode is "plan".
 *
 * Plan mode is read-only at the permission layer (tools are BLOCKED), but the
 * model only discovers that when a tool call is denied — which causes it to
 * retry, oscillate, and waste turns. This section tells the model UP FRONT that
 * it is in plan mode and imposes a workflow that ends in the `exit_plan` tool,
 * so the model researches, builds a structured DAG, and presents it for
 * approval instead of fighting the permission layer.
 *
 * The blocked-tools list is DERIVED from the canonical side-effect
 * classification (`BUILTIN_TOOL_SIDE_EFFECTS` + `isPlanBlockingSideEffect`) so
 * the prompt can never drift from what `checkPlan` actually denies — the bug
 * this replaced was a hand-maintained string that had gone stale (it omitted the
 * spawn/memory tools). Injected by the permissions extension from the
 * `before_agent_start` handler (pre-model band), appended AFTER the system
 * prompt's dynamic marker so it never invalidates the cacheable prefix.
 */

import { BUILTIN_TOOL_SIDE_EFFECTS } from "./checker.ts";
import { isPlanBlockingSideEffect } from "./side-effect.ts";

/**
 * Optional, conditionally-registered integration families (browser automation,
 * security scanners). They ARE blocked in plan mode, but they are only present
 * when their integration is loaded, and enumerating every operation would bloat
 * an always-on prompt — the blanket "READ-ONLY" rule already covers them. The
 * prompt names the core built-ins + coordinator/memory tools instead.
 */
const INTEGRATION_NAMESPACES = ["chrome_devtools_", "security_"] as const;

function isIntegrationNamespaced(toolName: string): boolean {
	return INTEGRATION_NAMESPACES.some((ns) => toolName.startsWith(ns));
}

/**
 * The tools plan mode blocks, derived from the canonical side-effect map so the
 * prompt and the gating (`checker.ts` / `side-effect.ts`) share one source of
 * truth. Sorted for a stable, cache-friendly string. Optional integration
 * namespaces are folded into the general read-only rule (see above).
 */
export function planBlockedToolNames(): string[] {
	return Object.entries(BUILTIN_TOOL_SIDE_EFFECTS)
		.filter(([name, effect]) => isPlanBlockingSideEffect(effect) && !isIntegrationNamespaced(name))
		.map(([name]) => name)
		.sort();
}

/**
 * The `<plan_mode>` block appended to the system prompt while plan mode active.
 * Keep these invariants in the text: blocked-tools warning, numbered workflow,
 * brief/produces/verify guidance, and the obligation to call `exit_plan`.
 */
export function buildPlanModeSection(): string {
	const blocked = planBlockedToolNames().join(", ");
	return [
		"<plan_mode>",
		"Plan mode is ACTIVE: this session is READ-ONLY.",
		`- Mutating tools (${blocked}, and MCP tools) are BLOCKED at the permission layer. Do not attempt them; do not promise edits.`,
		"- Subagents/spawn (`task`, `parallel`, `fanout`) are also blocked — there is no read-only carve-out; do your own research with the read-only tools directly.",
		"Workflow you MUST follow:",
		"1. Research with read-only tools (read, grep, find, ls, symbol, lsp navigation).",
		"2. Read files IN FULL before planning changes to them.",
		"3. Build the plan with the `plan` tool (`propose`, then `revise` as understanding improves). Fill `brief` with context the executor needs (constraints, invariants, key files read, decisions and why). Every step that changes code SHOULD have `produces` (artifact) and `verify` (command that proves it done).",
		"4. When the plan is complete, call `exit_plan` to present it for user approval. Never just stop responding with an un-presented plan.",
		"Do NOT write code blocks as a substitute for edits; describe the change in the plan step instead.",
		"</plan_mode>",
	].join("\n");
}
