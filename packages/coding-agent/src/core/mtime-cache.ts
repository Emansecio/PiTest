import { readFileSync, statSync } from "fs";

/**
 * mtime-keyed parse cache for files that are re-read on every resource reload
 * (SKILL.md, prompt templates). Avoids re-reading + re-parsing files whose
 * mtime is unchanged since the last reload.
 *
 * Mirrors the ignore-file line cache in skills.ts: stat first, return the
 * cached parse on an mtime hit, otherwise read + parse and store. A changed
 * file (new mtime) is always re-parsed, so behavior is preserved.
 */
export function createMtimeParseCache<T>(parse: (rawContent: string, filePath: string) => T) {
	const cache = new Map<string, { mtimeMs: number; parsed: T }>();

	return function read(filePath: string): T {
		const stat = statSync(filePath);
		const cached = cache.get(filePath);
		if (cached && cached.mtimeMs === stat.mtimeMs) {
			return cached.parsed;
		}
		const rawContent = readFileSync(filePath, "utf-8");
		const parsed = parse(rawContent, filePath);
		cache.set(filePath, { mtimeMs: stat.mtimeMs, parsed });
		return parsed;
	};
}
