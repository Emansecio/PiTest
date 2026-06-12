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
import { resolve } from "node:path";
import type { ExtensionAPI } from "../extensions/index.js";
import { PATH_KEY_ALIASES } from "../tools/argument-prep.ts";
import { computeEditsDiff, type Edit } from "../tools/edit-diff.ts";

/** Same path-alias extraction the read-guard uses (kept in sync with PATH_KEY_ALIASES). */
function extractPathArg(input: Record<string, unknown>): string | undefined {
	if (typeof input.path === "string") return input.path;
	for (const alias of Object.keys(PATH_KEY_ALIASES)) {
		const value = input[alias];
		if (typeof value === "string") return value;
	}
	return undefined;
}

/**
 * Normalize the raw tool input into `Edit[]` ({oldText,newText}), accepting the
 * cross-harness aliases the tool will. Returns null for any shape we can't fully
 * parse (e.g. edits as a JSON string, a missing newText) so the gate fails open
 * rather than blocking on a format it didn't understand.
 */
function extractEdits(input: Record<string, unknown>): Edit[] | null {
	const toEdit = (oldRaw: unknown, newRaw: unknown): Edit | null =>
		typeof oldRaw === "string" && typeof newRaw === "string" ? { oldText: oldRaw, newText: newRaw } : null;

	const edits = input.edits;
	if (Array.isArray(edits)) {
		const out: Edit[] = [];
		for (const e of edits) {
			if (!e || typeof e !== "object") return null;
			const rec = e as Record<string, unknown>;
			const edit = toEdit(
				rec.oldText ?? rec.old_string ?? rec.oldString ?? rec.old_str,
				rec.newText ?? rec.new_string ?? rec.newString ?? rec.new_str,
			);
			if (!edit) return null;
			out.push(edit);
		}
		return out.length > 0 ? out : null;
	}
	// Legacy flat single-edit shape.
	const flat = toEdit(
		input.oldText ?? input.old_string ?? input.oldString ?? input.old_str,
		input.newText ?? input.new_string ?? input.newString ?? input.new_str,
	);
	return flat ? [flat] : null;
}

export interface EditPreconditionOptions {
	cwd: string;
}

export function createEditPreconditionExtension(options: EditPreconditionOptions) {
	return (pi: ExtensionAPI) => {
		const editedThisTurn = new Set<string>();

		const resolvePath = (filePath: string): string => {
			if (filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath)) return filePath;
			return resolve(options.cwd, filePath);
		};

		pi.on("turn_start", () => {
			editedThisTurn.clear();
		});

		pi.on("tool_call", async (event) => {
			if (event.toolName !== "edit") return undefined;
			if (process.env.PIT_NO_EDIT_PRECONDITION) return undefined;

			const input = event.input as Record<string, unknown>;
			const path = extractPathArg(input);
			if (path === undefined) return undefined;

			const abs = resolvePath(path);
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
