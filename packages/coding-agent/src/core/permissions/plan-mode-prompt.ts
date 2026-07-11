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
 * Pure string, no dependencies: injected by the permissions extension from the
 * `before_agent_start` handler (pre-model band), appended AFTER the system
 * prompt's dynamic marker so it never invalidates the cacheable prefix.
 */

/**
 * The `<plan_mode>` block appended to the system prompt while plan mode active.
 * Keep these invariants in the text: blocked-tools warning, numbered workflow,
 * brief/produces/verify requirement, and the obligation to call `exit_plan`.
 */
export function buildPlanModeSection(): string {
	return [
		"<plan_mode>",
		"Plan mode is ACTIVE: this session is READ-ONLY.",
		"- Mutating tools (edit, edit_v2, write, bash, eval, debug, ast_edit, code, recipe, retain, forget, resolve, preview, MCP tools) are BLOCKED at the permission layer. Do not attempt them; do not promise edits.",
		"Workflow you MUST follow:",
		"1. Research with read-only tools (read, grep, find, ls, symbol, lsp navigation).",
		"2. Read files IN FULL before planning changes to them.",
		"3. Build the plan with the `plan` tool (`propose`, then `revise` as understanding improves). Fill `brief` with context the executor needs (constraints, invariants, key files read, decisions and why). Every step that changes code MUST have `produces` (artifact) and `verify` (command that proves it done).",
		"4. When the plan is complete, call `exit_plan` to present it for user approval. Never just stop responding with an un-presented plan.",
		"Do NOT write code blocks as a substitute for edits; describe the change in the plan step instead.",
		"</plan_mode>",
	].join("\n");
}
