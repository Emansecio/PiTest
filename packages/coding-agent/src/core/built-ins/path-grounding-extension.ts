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
import { suggestClosest, suggestClosestN } from "@pit/ai";
import type { ExtensionAPI } from "../extensions/index.js";
import { groundPath, isPathGroundingDisabled, PATH_GROUNDING_DEFAULTS } from "../path-grounding.ts";
import { extractPathArg, resolveToolPath } from "../tools/argument-prep.ts";
import { expandPath } from "../tools/path-utils.ts";
import { createFireOnceBlockGuard } from "./grounding-fire-once.ts";

export function createPathGroundingExtension(options: { cwd: string }): (pi: ExtensionAPI) => void {
	return createFireOnceBlockGuard({
		category: "guard.path-grounding",
		source: "path-grounding-extension",
		decide(event) {
			if (isPathGroundingDisabled()) return undefined;
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
				return { block: true, reason: decision.message };
			}
			return undefined;
		},
	});
}
