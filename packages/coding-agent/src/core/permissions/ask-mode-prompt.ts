/**
 * System-prompt section injected while the permission mode is "ask".
 *
 * Ask is the Q&A stance over the SAME read-only enforcement as plan (one gate,
 * `checkReadOnly`): the user wants an answer, not a plan. Without this section
 * the model inherits plan's reflex — research, build a DAG, call `exit_plan` —
 * and answers a question with a proposal nobody asked for. So the text keeps the
 * read-only warning and drops the whole plan ritual, explicitly.
 *
 * The blocked-tools list is DERIVED from the same canonical side-effect source as
 * `<plan_mode>` ({@link blockedToolsBullet}) so neither prompt can drift from
 * what the checker actually denies, and it is narrowed to the session's own tool
 * surface when the caller passes it. Rendered into the system prompt's CACHEABLE
 * PREFIX by the host (`BuildSystemPromptOptions.permissionModeSection`), which
 * rebuilds only when the permission mode (or the tool surface) changes.
 */

import { blockedToolsBullet, readOnlyDelegationBullet } from "./plan-mode-prompt.ts";

/**
 * The `<ask_mode>` block appended to the system prompt while ask mode is active.
 * Keep these invariants in the text: read-only warning with the derived blocked
 * list, answer-directly instruction, and the explicit no-plan-ritual ban.
 */
export function buildAskModeSection(sessionToolNames?: readonly string[]): string {
	return [
		"<ask_mode>",
		"Ask mode is ACTIVE: this session is READ-ONLY.",
		blockedToolsBullet(sessionToolNames),
		readOnlyDelegationBullet(),
		"Your job is to ANSWER the user's question, directly:",
		"1. Investigate with read-only tools (read, grep, find, ls, symbol, lsp navigation) until the answer is grounded in the actual code — cite files/symbols you looked at.",
		"2. Answer in prose. Explaining how a change would work is fine; describe it instead of writing it.",
		"3. Do NOT run the plan ritual: do not use the `plan` tool, do not call `exit_plan`, do not present a step-by-step proposal for approval unless the user asked for a plan.",
		"If the user asks you to actually change code, say the session is read-only and that they need to switch mode (cycle key, or `/permission-mode auto`) — do not attempt the edit.",
		"</ask_mode>",
	].join("\n");
}
