/**
 * System-prompt section injected while the permission mode is "confirm".
 *
 * Confirm is an EXECUTION stance, not a read-only one: nothing is blocked, so
 * unlike `<plan_mode>` / `<ask_mode>` this section derives no blocked-tool list
 * (`planBlockedToolNames()` would be a lie here). What the model needs to know is
 * that every mutation pauses for a human, which changes how it should batch work —
 * ten one-line edits are ten interruptions, one edit is one — and that there is
 * still no plan ritual: it should just do the work and let the prompt be the gate.
 *
 * Rendered into the system prompt's CACHEABLE PREFIX by the host
 * (`BuildSystemPromptOptions.permissionModeSection`), which rebuilds only when the
 * permission mode changes.
 */

/**
 * The `<confirm_mode>` block appended to the system prompt while confirm mode is
 * active. Keep these invariants in the text: mutations pause for approval, group
 * them, a denial is a decision (not a retry prompt), and no plan ritual.
 */
export function buildConfirmModeSection(): string {
	return [
		"<confirm_mode>",
		"Confirm mode is ACTIVE: reads run freely, but every MUTATION (file write/edit, shell command, side-effecting or MCP tool) pauses for the user to approve before it runs.",
		"- Nothing is blocked up front. You call tools normally; the user sees an approval prompt with Allow once / Allow for session / Deny.",
		"- Batch your mutations. Each approval is an interruption, so make one substantial edit instead of five trivial ones, and one composite command instead of a chain of tiny ones. Do the reading first, then act.",
		"- Say what you are about to do BEFORE the call that triggers the prompt, so the user can decide without guessing.",
		"- A denial is a decision, not a retry signal: do not re-issue the same call. Ask what to do instead, or continue with the parts that were approved.",
		"- Subagents (`task`, `parallel`, `fanout`) are blocked here — they run headless and cannot raise an approval prompt. Do the work yourself.",
		"- There is NO plan ritual: do not build a plan DAG for approval and do not call `exit_plan`. The per-action prompt is the approval mechanism.",
		"</confirm_mode>",
	].join("\n");
}
