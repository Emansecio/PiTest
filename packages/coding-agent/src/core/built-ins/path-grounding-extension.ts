/**
 * Built-in path-grounding extension (thin adapter).
 *
 * Pre-exec counterpart for a tool's FILE-PATH arg: when a `read`/`edit` references
 * a file that does not exist on disk and a close-named sibling sits in its
 * directory, this blocks with the candidate — BEFORE the call fails with ENOENT.
 * `write` is intentionally OUT of scope (it creates files; a missing path is the
 * intent). All decision logic (resolve, fail-open, block-only) lives in the pure
 * `../path-grounding.ts`; this adapter only wires the fs + fuzzy deps and reads the
 * path arg.
 *
 * Session state: a fire-once set so an insistent model re-issuing the identical
 * blocked call runs it (advises, never wedges). The whole handler is wrapped in
 * try/catch because `emitToolCall` has no per-handler isolation and a throw out of
 * beforeToolCall would hard-block the call — fail-open is load-bearing. Opt out
 * with PIT_NO_PATH_GROUNDING.
 */

import { existsSync, readdirSync } from "node:fs";
import { recordDiagnostic, suggestClosest, suggestClosestN } from "@pit/ai";
import type { ExtensionAPI } from "../extensions/index.js";
import { groundPath, isPathGroundingDisabled, PATH_GROUNDING_DEFAULTS } from "../path-grounding.ts";
import { extractPathArg, resolveToolPath } from "../tools/argument-prep.ts";
import { expandPath } from "../tools/path-utils.ts";

export function createPathGroundingExtension(options: { cwd: string }) {
	return (pi: ExtensionAPI) => {
		const fired = new Set<string>();

		pi.on("tool_call", async (event) => {
			try {
				if (isPathGroundingDisabled()) return undefined;
				// read/edit REFERENCE an existing file; write CREATES one (never grounded).
				if (event.toolName !== "read" && event.toolName !== "edit") return undefined;

				const input = event.input as Record<string, unknown>;
				const path = extractPathArg(input);
				if (path === undefined) return undefined;

				const decision = groundPath(
					{ path },
					{
						resolve: (raw) => resolveToolPath(raw, options.cwd),
						fileExists: (absPath) => existsSync(absPath),
						listDir: (absDir) => readdirSync(absDir),
						fuzzy: suggestClosest,
						fuzzyN: suggestClosestN,
						normalize: expandPath,
						maxDistance: PATH_GROUNDING_DEFAULTS.maxDistance,
						prefixMinOverlap: PATH_GROUNDING_DEFAULTS.prefixMinOverlap,
					},
				);

				if (decision.action === "block") {
					// Stable key (sorted top-level arg keys) so a verbatim re-issue with
					// reordered keys still matches the fire-once escape.
					const key = `${event.toolName}:${JSON.stringify(input, Object.keys(input).sort())}`;
					if (fired.has(key)) return undefined; // already advised once -> let it run
					fired.add(key);
					recordDiagnostic({
						category: "guard.path-grounding",
						level: "info",
						source: "path-grounding-extension",
						context: { note: event.toolName },
					});
					return { block: true, reason: decision.message };
				}
				return undefined;
			} catch {
				// emitToolCall has no per-handler try/catch; a throw out of beforeToolCall
				// would hard-block the call. Fail-open is the invariant -> swallow.
				return undefined;
			}
		});
	};
}
