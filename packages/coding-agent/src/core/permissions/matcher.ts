/**
 * Path glob and command regex matchers for the permission system.
 *
 * Glob syntax:
 *  - `*` matches any non-separator chars
 *  - `**` matches any chars including separators
 *  - `?` matches a single non-separator char
 *  - Other chars match literally
 *
 * Matches are case-insensitive on Windows and macOS (APFS is typically
 * case-insensitive), case-sensitive on Linux and other platforms.
 */

import { isAbsolute, resolve } from "node:path";
import { LruMap } from "../lru-map.ts";
import { createRegexTestDeadline, testRegexWithinBudget, validateSafeRegex } from "../regex-budget.ts";
import { canonicalPathKey } from "../tools/path-utils.ts";
import { BUILTIN_SENSITIVE_PATHS } from "./types.ts";

const REGEXP_CACHE_CAP = 256;
const globRegExpCache = new LruMap<string, RegExp>(REGEXP_CACHE_CAP);
const cmdRegExpCache = new LruMap<string, RegExp>(REGEXP_CACHE_CAP);

/** Max `**` segments allowed in a permission glob (ReDoS / complexity cap). */
export const GLOB_MAX_DOUBLE_STAR = 3;

function normalizePathForMatch(path: string): string {
	return path.replace(/\\/g, "/");
}

/** Compile a glob pattern to a RegExp anchored to start and end. Cached. */
export function globToRegExp(pattern: string): RegExp {
	const cached = globRegExpCache.get(pattern);
	if (cached) return cached;
	const normalized = pattern.replace(/\\/g, "/");
	let regex = "";
	let i = 0;
	let doubleStarCount = 0;
	while (i < normalized.length) {
		const c = normalized[i];
		if (c === "*") {
			if (normalized[i + 1] === "*") {
				doubleStarCount += 1;
				if (doubleStarCount > GLOB_MAX_DOUBLE_STAR) {
					throw new Error(`Glob pattern has too many ** segments (max ${GLOB_MAX_DOUBLE_STAR})`);
				}
				// `**` — match anything including `/`
				regex += ".*";
				i += 2;
				// Eat a following `/` so `**/foo` matches `foo` too.
				if (normalized[i] === "/") {
					i++;
				}
				continue;
			}
			regex += "[^/]*";
			i++;
			continue;
		}
		if (c === "?") {
			regex += "[^/]";
			i++;
			continue;
		}
		if (/[.+^${}()|[\]\\]/.test(c)) {
			regex += `\\${c}`;
			i++;
			continue;
		}
		regex += c;
		i++;
	}
	const flags = process.platform === "win32" || process.platform === "darwin" ? "i" : "";
	const re = new RegExp(`^${regex}$`, flags);
	globRegExpCache.set(pattern, re);
	return re;
}

/** Returns true if `path` (any string) matches the glob. */
export function matchGlob(pattern: string, path: string): boolean {
	try {
		const re = globToRegExp(pattern);
		const matched = testRegexWithinBudget(re, normalizePathForMatch(path), createRegexTestDeadline());
		return matched === true;
	} catch {
		return false;
	}
}

/**
 * Resolve a target path to an absolute, normalized form.
 * Used to make path-rule matches consistent regardless of how the LLM phrased the argument.
 */
export function normalizeTargetPath(path: string, cwd: string): string {
	const abs = isAbsolute(path) ? path : resolve(cwd, path);
	return normalizePathForMatch(abs);
}

/**
 * Identity set of the built-in sensitive-path rules (`.env`, `.ssh/**`, …) —
 * the deny-floor's OWN entries, never a user-authored `denyPaths`/`allowPaths`
 * rule even when it happens to reuse the same glob text (those are a different
 * object, `.has()` is a reference check). `findMatchingGlob` uses this to apply
 * the stronger canonical-path matching ONLY to the deny-floor's sensitive globs,
 * without `checker.ts` having to say which rules are "sensitive" — it just
 * spreads `BUILTIN_SENSITIVE_PATHS` into the rule list it already passes in.
 */
const SENSITIVE_PATH_RULE_IDENTITY = new Set<{ glob: string }>(BUILTIN_SENSITIVE_PATHS);

/**
 * Strip an NTFS ADS suffix (`::$DATA`, `::$INDEX_ALLOCATION`, …) and a single
 * trailing space or dot from the end of a path string. Windows treats
 * `.env::$DATA`, `.env ` and `.env.` as the same underlying file as `.env` for
 * file-open purposes, so a sensitive-glob check must see through the quirk.
 * Applied only on the sensitive-glob path (see {@link matchesSensitiveGlob}) —
 * ordinary path matching never calls this.
 */
function stripWindowsPathQuirks(path: string): string {
	return path.replace(/::\$[A-Za-z_]+$/, "").replace(/[ .]$/, "");
}

/**
 * Sensitive-glob match: tests the glob against the raw resolved `target`, a
 * Windows-quirk-stripped variant (trailing space/dot, NTFS ADS suffix), and the
 * canonical path key (`realpathSync.native` + case-fold — resolves symlinks, so
 * an in-repo symlink to `~/.ssh` matches the built-in ssh-directory glob) of
 * both. `canonicalPathKey` is memoized, so repeated calls with the same target
 * across sibling sensitive rules cost no extra stat.
 *
 * FAIL CLOSED: any error while computing these forms is treated as a MATCH
 * (block) — a canonicalization failure on a SENSITIVE path must resolve toward
 * denying it, never toward silently passing it through.
 */
function matchesSensitiveGlob(pattern: string, target: string): boolean {
	try {
		if (matchGlob(pattern, target)) return true;
		const stripped = stripWindowsPathQuirks(target);
		if (stripped !== target && matchGlob(pattern, stripped)) return true;
		if (matchGlob(pattern, canonicalPathKey(target))) return true;
		if (stripped !== target && matchGlob(pattern, canonicalPathKey(stripped))) return true;
		return false;
	} catch {
		return true;
	}
}

/** Returns the matching pattern entry (with its reason) or undefined. */
export function findMatchingGlob<T extends { glob: string; tools?: string[]; reason?: string }>(
	patterns: readonly T[],
	target: string,
	toolName?: string,
): T | undefined {
	for (const p of patterns) {
		if (p.tools && toolName && !p.tools.includes(toolName)) continue;
		const isSensitive = SENSITIVE_PATH_RULE_IDENTITY.has(p);
		const matched = isSensitive ? matchesSensitiveGlob(p.glob, target) : matchGlob(p.glob, target);
		if (matched) return p;
	}
	return undefined;
}

/** True when regex evaluation exceeded the wall-clock budget (fail-closed for deny). */
export function wasRegexBudgetExceeded(deadlineMs: number): boolean {
	return Date.now() > deadlineMs;
}

/** Returns the matching command rule or undefined. */
export function findMatchingCommandRule<T extends { pattern: string; flags?: string; reason?: string }>(
	rules: readonly T[],
	command: string,
	deadlineMs: number = createRegexTestDeadline(),
): T | undefined {
	for (const rule of rules) {
		const cacheKey = `${rule.pattern}\0${rule.flags ?? "i"}`;
		let re = cmdRegExpCache.get(cacheKey);
		if (!re) {
			try {
				validateSafeRegex(rule.pattern);
				re = new RegExp(rule.pattern, rule.flags ?? "i");
			} catch {
				continue;
			}
			cmdRegExpCache.set(cacheKey, re);
		}
		const matched = testRegexWithinBudget(re, command, deadlineMs);
		if (matched === null) return undefined;
		if (matched) return rule;
	}
	return undefined;
}
