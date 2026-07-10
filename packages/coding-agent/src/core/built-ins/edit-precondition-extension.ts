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
import { recordDiagnostic } from "@pit/ai";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
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
			if (isTruthyEnvFlag(process.env.PIT_NO_EDIT_PRECONDITION)) return undefined;

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
			if (!edits) {
				// Path is valid and the file exists, but `edits` can't be parsed into
				// [{oldText,newText}] (non-object element, missing a field, empty array,
				// JSON-stringified-but-not-an-array). The tool would reject this with a
				// generic schema error the model often re-issues verbatim. Block early
				// with the exact shape so it self-corrects in the same turn.
				recordDiagnostic({
					category: "guard.edit-precondition",
					level: "info",
					source: "edit-precondition-extension.malformedShape",
					context: {
						path,
						outcome: "blocked",
						ruleId: "edits-malformed",
						toolName: event.toolName,
						toolCallId: event.toolCallId,
					},
				});
				return {
					block: true,
					reason:
						'Edit precondition (no write attempted): the "edits" argument is missing or malformed. ' +
						"Expected `edits: [{ oldText, newText }, …]` — a non-empty array where every element is an " +
						"object carrying both string fields. Re-issue with that exact shape.",
				};
			}

			// Reserve before awaiting the dry-run so sibling handlers cannot both
			// validate pre-batch contents for the same file.
			editedThisTurn.add(abs);
			let diff: Awaited<ReturnType<typeof computeEditsDiff>>;
			try {
				diff = await computeEditsDiff(path, edits, options.cwd);
			} catch {
				editedThisTurn.delete(abs);
				return undefined;
			}

			if ("error" in diff) {
				recordDiagnostic({
					category: "guard.edit-precondition",
					level: "info",
					source: "edit-precondition-extension",
					context: {
						path,
						outcome: "blocked",
						ruleId: "oldtext-mismatch",
						toolName: event.toolName,
						toolCallId: event.toolCallId,
					},
				});
				return {
					block: true,
					reason: `Edit precondition (dry-run, no write attempted): ${diff.error}`,
				};
			}

			// The early reservation keeps dependent sibling edits from being checked
			// against stale pre-batch content.
			return undefined;
		});
	};
}
