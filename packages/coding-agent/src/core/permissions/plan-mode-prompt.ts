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
 * classification (`BUILTIN_TOOL_SIDE_EFFECTS` + `EXTENSION_TOOL_SIDE_EFFECTS` +
 * `isPlanBlockingSideEffect`). Native coordinator names are intentionally removed
 * from that categorical list and explained by a separate host-proof bullet,
 * matching the checker's trusted read-only delegation seam. Both maps are read
 * explicitly here so re-splitting them cannot silently drop `memory_append` and
 * other unconditionally blocked tools from the prompt.
 *
 * The list is then INTERSECTED with the session's tool surface when the caller
 * passes it: naming `ast_edit`/`recipe`/`goal_complete` to a model that was never
 * given those tools is pure noise (7 of 19 derived names on a default surface).
 * The surface comes from the SAME `selectedTools` array the prompt build already
 * consumes, so the section can only change on a rebuild where the tool block of
 * the prefix changed anyway — which is what keeps this block in the CACHEABLE
 * PREFIX: the host renders it via `BuildSystemPromptOptions.permissionModeSection`
 * and rebuilds the prompt only when the permission mode (or the tool surface)
 * changes.
 */

import { COORDINATOR_TOOL_NAMES } from "../coordinator/brand.ts";
import { BUILTIN_TOOL_SIDE_EFFECTS } from "./checker.ts";
import { EXTENSION_TOOL_SIDE_EFFECTS, isPlanBlockingSideEffect, type ToolSideEffect } from "./side-effect.ts";

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
 * The tools plan mode blocks unconditionally, derived from the canonical
 * side-effect maps so the prompt and gating share one source of truth. Native
 * coordinator tools are excluded because trusted host proof may authorize their
 * side-effect-free selections. Sorted for a stable, cache-friendly string;
 * optional integration namespaces are folded into the general read-only rule.
 *
 * `sessionToolNames` narrows the result to tools the session actually exposes.
 * Omit it (tests, callers without a surface) to get the full static derivation —
 * the previous behaviour.
 */
export function planBlockedToolNames(sessionToolNames?: readonly string[]): string[] {
	const surface = sessionToolNames ? new Set(sessionToolNames) : undefined;
	const merged: Record<string, ToolSideEffect> = {
		...BUILTIN_TOOL_SIDE_EFFECTS,
		...EXTENSION_TOOL_SIDE_EFFECTS,
	};
	return Object.entries(merged)
		.filter(([name, effect]) => {
			if (!isPlanBlockingSideEffect(effect) || isIntegrationNamespaced(name) || COORDINATOR_TOOL_NAMES.has(name)) {
				return false;
			}
			return surface === undefined || surface.has(name);
		})
		.map(([name]) => name)
		.sort();
}

/**
 * The shared "these are BLOCKED" bullet for `<plan_mode>` / `<ask_mode>`. Kept in
 * one place so the two stances cannot describe the same gate differently, and so
 * an empty derived list (a session with no mutating tools at all) degrades to a
 * sentence instead of an empty parenthesis.
 */
export function blockedToolsBullet(sessionToolNames?: readonly string[]): string {
	const names = planBlockedToolNames(sessionToolNames);
	const inner =
		names.length > 0
			? `${names.join(", ")}, and MCP tools`
			: "MCP tools, and anything that writes, executes or spawns";
	return `- Mutating tools (${inner}) are BLOCKED at the permission layer. Do not attempt them; do not promise edits.`;
}

/** Explain the one trusted exception without implying that models can self-authorize it. */
export function readOnlyDelegationBullet(): string {
	return "- Coordinator tools (`task`, `parallel`, `fanout`) are conditional: host-proven read-only delegation may run only when every effective child tool is side-effect-free. A worktree, an acceptance gate, unsafe child tools, or missing proof remains BLOCKED.";
}

/**
 * The `<plan_mode>` block appended to the system prompt while plan mode active.
 * Keep these invariants in the text: blocked-tools warning, numbered workflow,
 * brief/produces/verify guidance, and the obligation to call `exit_plan`.
 */
export function buildPlanModeSection(sessionToolNames?: readonly string[]): string {
	return [
		"<plan_mode>",
		"Plan mode is ACTIVE: this session is READ-ONLY.",
		blockedToolsBullet(sessionToolNames),
		readOnlyDelegationBullet(),
		"Workflow you MUST follow:",
		"1. Research with read-only tools (read, grep, find, ls, symbol, lsp navigation).",
		"2. Read files IN FULL before planning changes to them.",
		"3. Build the plan with the `plan` tool (`propose`, then `revise` as understanding improves). Fill `brief` with context the executor needs (constraints, invariants, key files read, decisions and why). Every step that changes code SHOULD have `produces` (artifact) and `verify` (command that proves it done).",
		"4. When the plan is complete, call `exit_plan` to present it for user approval. Never just stop responding with an un-presented plan.",
		"Do NOT write code blocks as a substitute for edits; describe the change in the plan step instead.",
		"</plan_mode>",
	].join("\n");
}
