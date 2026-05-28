/**
 * Built-in read-guard extension.
 *
 * Blocks `edit` and `write` tool calls on files that have not been read in the
 * current session. Prevents the model from generating diffs against
 * hallucinated file content.
 *
 * New files (that don't exist on disk) are exempt — the model can create them
 * without a prior read.
 *
 * Compaction handling: the `readFiles` set used to be cleared on
 * `session_before_compact`, forcing the model to re-read every file it had
 * already loaded into context. That is correct in the worst case (model lost
 * the content from memory) but wasteful when the file is unchanged. Instead,
 * on compaction we snapshot the current `(mtimeMs, size)` of every tracked
 * file into `postCompactStamps`. Post-compaction, an edit/write is allowed
 * iff the file is either:
 *   - in `readFiles` (re-read this session), OR
 *   - in `postCompactStamps` AND the current stat still matches the snapshot.
 * If the stat drifted (another process / another agent touched the file), the
 * stamp is consumed and the edit is blocked with a "re-read it" reason.
 *
 * `extractPathArg` accepts the same aliases `prepareWithPathAliases` will
 * later normalize (path, file_path, filepath, filename, file). The read-guard
 * runs on the `tool_call` event — BEFORE prepareArguments — so it must accept
 * the same aliases the tool will, or a model emitting `file_path` would
 * bypass the guard entirely.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "../extensions/index.js";
import { PATH_KEY_ALIASES } from "../tools/argument-prep.ts";

interface FileStamp {
	mtimeMs: number;
	size: number;
}

/**
 * Extract a path argument from raw tool input, accepting every alias that
 * `prepareWithPathAliases` would normalize later. Returns undefined when no
 * recognised key is present or the value is not a string. Kept in sync with
 * PATH_KEY_ALIASES so the guard and the tool agree on which key wins.
 */
function extractPathArg(input: Record<string, unknown>): string | undefined {
	if (typeof input.path === "string") return input.path;
	for (const alias of Object.keys(PATH_KEY_ALIASES)) {
		const value = input[alias];
		if (typeof value === "string") return value;
	}
	return undefined;
}

export interface ReadGuardOptions {
	cwd: string;
}

function stampFile(absPath: string): FileStamp | undefined {
	try {
		const st = statSync(absPath);
		return { mtimeMs: st.mtimeMs, size: st.size };
	} catch {
		return undefined;
	}
}

export function createReadGuardExtension(options: ReadGuardOptions) {
	return (pi: ExtensionAPI) => {
		const readFiles = new Set<string>();
		const postCompactStamps = new Map<string, FileStamp>();

		const resolvePath = (filePath: string): string => {
			if (filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath)) return filePath;
			return resolve(options.cwd, filePath);
		};

		pi.on("tool_call", (event) => {
			if (event.toolName === "read") {
				const path = extractPathArg(event.input as Record<string, unknown>);
				if (path !== undefined) {
					const abs = resolvePath(path);
					readFiles.add(abs);
					// A fresh read supersedes any post-compaction stamp gate.
					postCompactStamps.delete(abs);
				}
				return undefined;
			}

			if (event.toolName === "edit" || event.toolName === "write") {
				const path = extractPathArg(event.input as Record<string, unknown>);
				if (path === undefined) return undefined;

				const abs = resolvePath(path);

				// New files don't need a prior read. Probe existence with a
				// single statSync instead of existsSync (+ a later statSync):
				// a throw (ENOENT or any error) means the file does not exist
				// on disk, matching the old `!existsSync(abs)` allow branch.
				try {
					statSync(abs);
				} catch {
					return undefined;
				}

				if (readFiles.has(abs)) return undefined;

				const stamp = postCompactStamps.get(abs);
				if (stamp !== undefined) {
					const current = stampFile(abs);
					if (current && current.mtimeMs === stamp.mtimeMs && current.size === stamp.size) {
						// Unchanged since pre-compaction read → allow (no forced re-read).
						return undefined;
					}
					// Drifted (or stat failed) — consume the stale stamp so the
					// model can't accidentally retry and slip through.
					postCompactStamps.delete(abs);
					return {
						block: true,
						reason: `Read guard: file "${path}" changed since it was last read (pre-compaction snapshot stale). Read it again to confirm current content before editing.`,
					};
				}

				return {
					block: true,
					reason: `Read guard: file "${path}" has not been read in this session. Read it first to confirm its current content before editing.`,
				};
			}

			return undefined;
		});

		// On compaction, migrate the in-memory read set to a stat snapshot. The
		// model loses the verbatim content (it only sees the summary) but if the
		// file on disk has not drifted by the time it tries to edit, we can
		// still trust the snapshot it carried into context.
		pi.on("session_before_compact" as any, () => {
			for (const abs of readFiles) {
				const stamp = stampFile(abs);
				if (stamp) postCompactStamps.set(abs, stamp);
				// If stat fails (file deleted/permissions), we drop the entry —
				// the model will have to re-read, which is correct.
			}
			readFiles.clear();
		});
	};
}
