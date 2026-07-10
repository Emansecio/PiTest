/**
 * Human-readable labels for permission / orchestration mode transitions.
 * Shown in ephemeral notify toasts (not footer chips).
 */

import { truncateWithEllipsis } from "../../utils/surrogate.ts";
import type { Orchestration } from "../fusion/types.ts";
import type { PermissionMode } from "./types.ts";

/**
 * One-line copy for mode cycle / /permission-mode notifies.
 * Fusion always rides plan (read-only) in v1.
 */
export function humanModeNotifyLabel(orchestration: Orchestration, mode: PermissionMode): string {
	if (orchestration === "fusion") {
		return "Fusion · multi-model plan (read-only)";
	}
	if (mode === "plan") {
		return "Plan · research only — won't edit files";
	}
	return "Auto · can edit with built-in guard-rails";
}

/**
 * Compact blocked-action line for the transcript (custom message body).
 * Plain text — the renderer adds the `◦` bullet and warning color.
 */
export function formatPermissionBlockedContent(
	toolName: string,
	reason: string | undefined,
	mode: PermissionMode,
): string {
	const action = toolName.trim() || "tool";
	const modeHint =
		mode === "plan"
			? "plan mode (read-only) · cycle mode to allow"
			: "blocked by permission rules · cycle mode or adjust rules";
	const detail = reason?.trim();
	if (detail) {
		// Keep reason short for the one-line compact renderer.
		return `blocked: ${action} · ${truncateWithEllipsis(detail, 120)}`;
	}
	return `blocked: ${action} · ${modeHint}`;
}
