/**
 * Built-in edit-precondition extension.
 *
 * Re-uses `computeEditsDiff` — the dry-run match engine that already powers the
 * TUI diff preview, and touches no disk writes — as a PRE-CONDITION gate on the
 * `tool_call` event. When an `edit`'s oldText won't match (missing, or matches
 * more than once), the call is blocked BEFORE it enters the file-mutation queue
 * and pays a real failure + re-read. The block reason carries computeEditsDiff's
 * own copy-pasteable candidate hint, so the model can fix oldText in the SAME
 * turn instead of one round-trip later.
 *
 * Runs on `tool_call` (before prepareArguments), so it accepts the same arg
 * aliases the tool normalizes later (file_path / old_string / …). Fail-open by
 * construction: a non-edit tool, an unparseable args shape, a missing file, or
 * any computeEditsDiff throw passes through untouched.
 *
 * False-positive guard: in a multi-edit batch the dry-run sees the PRE-batch
 * file (beforeToolCall fires before any sibling edit lands), so a second edit
 * that depends on a first edit of the SAME file would mis-fire. We therefore
 * only gate the FIRST edit of each path per turn (`editedThisTurn`, cleared on
 * `turn_start`); later edits of an already-touched file pass through ungated.
 */

import { statSync } from "node:fs";
import type { ExtensionAPI } from "../extensions/index.js";
import { extractEdits, extractPathArg, resolveToolPath } from "../tools/argument-prep.ts";
import { computeEditsDiff } from "../tools/edit-diff.ts";

export interface EditPreconditionOptions {
	cwd: string;
}

export function createEditPreconditionExtension(options: EditPreconditionOptions) {
	return (pi: ExtensionAPI) => {
		const editedThisTurn = new Set<string>();

		pi.on("turn_start", () => {
			editedThisTurn.clear();
		});

		pi.on("tool_call", async (event) => {
			if (event.toolName !== "edit") return undefined;
			if (process.env.PIT_NO_EDIT_PRECONDITION) return undefined;

			const input = event.input as Record<string, unknown>;
			const path = extractPathArg(input);
			if (path === undefined) return undefined;

			const abs = resolveToolPath(path, options.cwd);
			// A later edit of an already-touched file may depend on the earlier one,
			// which the pre-batch dry-run can't see — skip to avoid a false block.
			if (editedThisTurn.has(abs)) return undefined;

			// Only precondition existing files; new-file creation has no oldText to match.
			try {
				statSync(abs);
			} catch {
				return undefined;
			}

			const edits = extractEdits(input);
			if (!edits) return undefined;

			let diff: Awaited<ReturnType<typeof computeEditsDiff>>;
			try {
				diff = await computeEditsDiff(path, edits, options.cwd);
			} catch {
				return undefined;
			}

			if ("error" in diff) {
				return {
					block: true,
					reason: `Edit precondition (dry-run, no write attempted): ${diff.error}`,
				};
			}

			// Dry-run matched: the real edit will land. Mark the path so a dependent
			// follow-up edit this turn isn't gated against stale pre-batch content.
			editedThisTurn.add(abs);
			return undefined;
		});
	};
}
