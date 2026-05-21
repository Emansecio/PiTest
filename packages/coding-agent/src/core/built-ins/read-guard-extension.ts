/**
 * Built-in read-guard extension.
 *
 * Blocks `edit` and `write` tool calls on files that have not been read in the
 * current compaction window. Prevents the model from generating diffs against
 * hallucinated file content.
 *
 * New files (that don't exist on disk) are exempt — the model can create them
 * without a prior read.
 *
 * The read set resets after compaction so the model must re-read files whose
 * content it only "remembers" from a now-summarized context window.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "../extensions/types.ts";
import { PATH_KEY_ALIASES } from "../tools/argument-prep.ts";

/**
 * Extract a path argument from raw tool input, accepting every alias that
 * `prepareWithPathAliases` would normalize later (path, file_path, filepath,
 * filename, file). The read-guard runs on the `tool_call` event — BEFORE
 * prepareArguments — so it must accept the same aliases the tool will, or a
 * model emitting `file_path` would bypass the guard entirely.
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

export function createReadGuardExtension(options: ReadGuardOptions) {
	return (pi: ExtensionAPI) => {
		const readFiles = new Set<string>();

		const resolvePath = (filePath: string): string => {
			if (filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath)) return filePath;
			return resolve(options.cwd, filePath);
		};

		pi.on("tool_call", (event) => {
			if (event.toolName === "read") {
				const path = extractPathArg(event.input as Record<string, unknown>);
				if (path !== undefined) {
					readFiles.add(resolvePath(path));
				}
				return undefined;
			}

			if (event.toolName === "edit" || event.toolName === "write") {
				const path = extractPathArg(event.input as Record<string, unknown>);
				if (path === undefined) return undefined;

				const resolved = resolvePath(path);

				// New files don't need a prior read
				if (!existsSync(resolved)) return undefined;

				if (!readFiles.has(resolved)) {
					return {
						block: true,
						reason: `Read guard: file "${path}" has not been read in this session. Read it first to confirm its current content before editing.`,
					};
				}
			}

			return undefined;
		});

		// Reset read tracking before compaction — after this point, the model's
		// "memory" of file content is only a summary, so it must re-read.
		pi.on("session_before_compact" as any, () => {
			readFiles.clear();
		});
	};
}
