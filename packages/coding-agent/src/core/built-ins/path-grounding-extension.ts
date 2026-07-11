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
 * try/catch as defense-in-depth (emitToolCall already isolates per-handler
 * throws) so a guard bug never hard-blocks — fail-open is load-bearing. Opt out
 * with PIT_NO_PATH_GROUNDING.
 */

import { existsSync, readdirSync } from "node:fs";
import { suggestClosest, suggestClosestN } from "@pit/ai";
import type { ExtensionAPI } from "../extensions/index.js";
import { groundPath, isPathGroundingDisabled, PATH_GROUNDING_DEFAULTS } from "../path-grounding.ts";
import { extractPathArg } from "../tools/argument-prep.ts";
import { expandPath, resolveReadPath, sameCanonicalName, URL_SCHEME_RE } from "../tools/path-utils.ts";
import { createFireOnceBlockGuard } from "./grounding-fire-once.ts";

/** Default TTL for sync path/dir existence caches (ms). */
export const PATH_GROUNDING_FS_CACHE_TTL_MS = 2000;

type CacheEntry<T> = { at: number; value: T };

/**
 * Sync existsSync / readdirSync wrappers with short TTL Maps.
 * Keeps the grounding API sync while avoiding repeated syscalls in a burst of tool calls.
 */
export function createPathGroundingFsCache(
	ttlMs: number = PATH_GROUNDING_FS_CACHE_TTL_MS,
	now: () => number = () => Date.now(),
	deps: {
		existsSync?: (path: string) => boolean;
		readdirSync?: (path: string) => string[];
	} = {},
): {
	fileExists: (absPath: string) => boolean;
	listDir: (absDir: string) => string[];
	clear: () => void;
} {
	const existsImpl = deps.existsSync ?? existsSync;
	const readdirImpl = deps.readdirSync ?? ((dir: string) => readdirSync(dir));
	const existsCache = new Map<string, CacheEntry<boolean>>();
	const dirCache = new Map<string, CacheEntry<string[]>>();

	return {
		fileExists(absPath: string): boolean {
			const t = now();
			const hit = existsCache.get(absPath);
			if (hit && t - hit.at < ttlMs) return hit.value;
			const value = existsImpl(absPath);
			existsCache.set(absPath, { at: t, value });
			return value;
		},
		listDir(absDir: string): string[] {
			const t = now();
			const hit = dirCache.get(absDir);
			if (hit && t - hit.at < ttlMs) return hit.value;
			const value = readdirImpl(absDir);
			dirCache.set(absDir, { at: t, value });
			return value;
		},
		clear(): void {
			existsCache.clear();
			dirCache.clear();
		},
	};
}

export function createPathGroundingExtension(options: { cwd: string }): (pi: ExtensionAPI) => void {
	const fsCache = createPathGroundingFsCache();
	return createFireOnceBlockGuard({
		category: "guard.path-grounding",
		source: "path-grounding-extension",
		ruleId: "path-enoent",
		decide(event) {
			if (isPathGroundingDisabled()) return undefined;
			if (event.toolName !== "read" && event.toolName !== "edit") return undefined;

			const input = event.input as Record<string, unknown>;
			const path = extractPathArg(input);
			if (path === undefined) return undefined;
			if (URL_SCHEME_RE.test(path)) return undefined;

			const decision = groundPath(
				{ path },
				{
					resolve: (raw) => resolveReadPath(raw, options.cwd),
					fileExists: (absPath) => fsCache.fileExists(absPath),
					listDir: (absDir) => fsCache.listDir(absDir),
					fuzzy: suggestClosest,
					fuzzyN: suggestClosestN,
					// Case-fold entry equality on win32/darwin so a case-variant of an
					// existing file is treated as present, not blocked (KEY-level only).
					sameName: sameCanonicalName,
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
