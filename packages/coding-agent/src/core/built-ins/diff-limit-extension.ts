/**
 * Built-in diff-limit extension.
 *
 * Tracks cumulative lines changed by `edit` and `write` tool calls within a
 * single agent turn. When the total exceeds a configured threshold (default:
 * 300 lines), the extension surfaces a confirmation prompt to the user before
 * allowing further mutations.
 *
 * Prevents over-engineering: the model creating abstractions, helpers, and
 * speculative code beyond what was requested.
 */

import type { ExtensionAPI } from "../extensions/types.ts";

const DEFAULT_DIFF_LIMIT = 300;

export interface DiffLimitOptions {
	maxLinesPerTurn?: number;
}

export function createDiffLimitExtension(options?: DiffLimitOptions) {
	return (pi: ExtensionAPI) => {
		const maxLines = options?.maxLinesPerTurn ?? DEFAULT_DIFF_LIMIT;
		let linesChangedThisTurn = 0;
		let userApprovedOverage = false;

		// Reset at the start of each agent turn
		pi.on("before_agent_start" as any, () => {
			linesChangedThisTurn = 0;
			userApprovedOverage = false;
		});

		pi.on("tool_call", async (event, ctx) => {
			if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
			if (userApprovedOverage) return undefined;

			const input = event.input as Record<string, unknown>;

			let estimatedLines = 0;
			if (event.toolName === "write") {
				const content = input.content;
				if (typeof content === "string") {
					estimatedLines = content.split("\n").length;
				}
			} else if (event.toolName === "edit") {
				// Canonical edit schema: { path, edits: [{ oldText, newText }, ...] }.
				// Legacy shape with top-level new_string/old_string is also accepted by
				// prepareArguments → keep the fallback for resilience.
				const edits = Array.isArray(input.edits) ? input.edits : undefined;
				if (edits) {
					for (const edit of edits) {
						const e = edit as { oldText?: unknown; newText?: unknown };
						if (typeof e.oldText !== "string" || typeof e.newText !== "string") continue;
						const newLines = e.newText.split("\n").length;
						const oldLines = e.oldText.split("\n").length;
						estimatedLines += Math.abs(newLines - oldLines) + Math.min(newLines, oldLines);
					}
				} else {
					const newContent = input.new_string ?? input.newString;
					const oldContent = input.old_string ?? input.oldString;
					if (typeof newContent === "string" && typeof oldContent === "string") {
						const newLines = (newContent as string).split("\n").length;
						const oldLines = (oldContent as string).split("\n").length;
						estimatedLines = Math.abs(newLines - oldLines) + Math.min(newLines, oldLines);
					}
				}
			}

			linesChangedThisTurn += estimatedLines;

			if (linesChangedThisTurn >= maxLines) {
				if (!ctx.hasUI) {
					return {
						block: true,
						reason: `Diff limit: ${linesChangedThisTurn} lines changed this turn (limit: ${maxLines}). No UI to confirm — blocked in non-interactive mode.`,
					};
				}

				const confirmed = await ctx.ui.confirm(
					"Large change detected",
					`This turn has modified ~${linesChangedThisTurn} lines (limit: ${maxLines}). ` +
						`This may indicate over-engineering. Continue with these changes?`,
				);

				if (confirmed) {
					userApprovedOverage = true;
					return undefined;
				}
				return {
					block: true,
					reason: `User declined: ${linesChangedThisTurn} lines changed exceeds the ${maxLines}-line limit for this turn.`,
				};
			}

			return undefined;
		});
	};
}
