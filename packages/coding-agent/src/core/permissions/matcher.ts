/**
 * Path glob and command regex matchers for the permission system.
 *
 * Glob syntax:
 *  - `*` matches any non-separator chars
 *  - `**` matches any chars including separators
 *  - `?` matches a single non-separator char
 *  - Other chars match literally
 *
 * Matches are case-insensitive on Windows, case-sensitive elsewhere.
 */

import { isAbsolute, resolve, sep } from "node:path";

const globRegExpCache = new Map<string, RegExp>();
const cmdRegExpCache = new Map<string, RegExp>();

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
	while (i < normalized.length) {
		const c = normalized[i];
		if (c === "*") {
			if (normalized[i + 1] === "*") {
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
	const flags = process.platform === "win32" ? "i" : "";
	const re = new RegExp(`^${regex}$`, flags);
	globRegExpCache.set(pattern, re);
	return re;
}

/** Returns true if `path` (any string) matches the glob. */
export function matchGlob(pattern: string, path: string): boolean {
	const re = globToRegExp(pattern);
	return re.test(normalizePathForMatch(path));
}

/**
 * Resolve a target path to an absolute, normalized form.
 * Used to make path-rule matches consistent regardless of how the LLM phrased the argument.
 */
export function normalizeTargetPath(path: string, cwd: string): string {
	const abs = isAbsolute(path) ? path : resolve(cwd, path);
	return normalizePathForMatch(abs);
}

/** Returns true if any provided glob matches the resolved path. */
export function anyGlobMatches(
	patterns: readonly { glob: string; tools?: string[] }[],
	target: string,
	toolName?: string,
): boolean {
	for (const p of patterns) {
		if (p.tools && toolName && !p.tools.includes(toolName)) continue;
		if (matchGlob(p.glob, target)) return true;
	}
	return false;
}

/** Returns the matching pattern entry (with its reason) or undefined. */
export function findMatchingGlob<T extends { glob: string; tools?: string[]; reason?: string }>(
	patterns: readonly T[],
	target: string,
	toolName?: string,
): T | undefined {
	for (const p of patterns) {
		if (p.tools && toolName && !p.tools.includes(toolName)) continue;
		if (matchGlob(p.glob, target)) return p;
	}
	return undefined;
}

/** Returns the matching command rule or undefined. */
export function findMatchingCommandRule<T extends { pattern: string; flags?: string; reason?: string }>(
	rules: readonly T[],
	command: string,
): T | undefined {
	for (const rule of rules) {
		const cacheKey = `${rule.pattern}\0${rule.flags ?? "i"}`;
		let re = cmdRegExpCache.get(cacheKey);
		if (!re) {
			try {
				re = new RegExp(rule.pattern, rule.flags ?? "i");
			} catch {
				continue;
			}
			cmdRegExpCache.set(cacheKey, re);
		}
		if (re.test(command)) return rule;
	}
	return undefined;
}

/** Make sure we use the same separator regardless of platform when displaying paths. */
export function displayPath(path: string): string {
	if (process.platform === "win32") return path;
	return path.replace(/\//g, sep);
}
