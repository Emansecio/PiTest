/**
 * Resolve the stance section for a permission mode (`<plan_mode>` /
 * `<ask_mode>` / `<confirm_mode>`; `auto` has none).
 *
 * One dispatcher so the three builders have a single caller and the host does
 * not have to know which modes carry a section. The result belongs in the
 * system prompt's CACHEABLE PREFIX (see `BuildSystemPromptOptions.permissionModeSection`):
 * the text is fixed per mode and the mode itself changes only on a deliberate
 * user action, so a mode switch costs one cache miss instead of ~260 tokens on
 * every request of every turn.
 *
 * `sessionToolNames` narrows plan/ask's blocked-tool enumeration to tools the
 * session actually exposes. Pass the SAME array that goes to
 * `BuildSystemPromptOptions.selectedTools`: the section then changes only on a
 * rebuild whose tool block already changed, so the prefix stays as stable as it
 * was before. Omit it for the previous (full static list) behaviour.
 */

import { buildAskModeSection } from "./ask-mode-prompt.ts";
import { buildConfirmModeSection } from "./confirm-mode-prompt.ts";
import { buildPlanModeSection } from "./plan-mode-prompt.ts";
import type { PermissionMode } from "./types.ts";

export function buildPermissionModeSection(
	mode: PermissionMode,
	sessionToolNames?: readonly string[],
): string | undefined {
	switch (mode) {
		case "plan":
			return buildPlanModeSection(sessionToolNames);
		case "ask":
			return buildAskModeSection(sessionToolNames);
		case "confirm":
			return buildConfirmModeSection();
		default:
			return undefined;
	}
}
