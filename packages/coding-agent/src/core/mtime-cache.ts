import { closeSync, openSync, readFileSync, readSync, statSync } from "fs";

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

/** Args passed to `prefixIsSufficient` so it can decide conservatively. */
export type PrefixSufficiencyContext = {
	/** True when the buffer we read covers the whole file (size <= prefixBytes). */
	atEof: boolean;
	/** Number of bytes actually read into the prefix buffer. */
	bytesRead: number;
};

export type MtimePrefixParseOptions = {
	/** Max bytes to pull off the head of the file before deciding. */
	prefixBytes: number;
	/**
	 * Returns true iff parsing `prefix` is guaranteed to yield the SAME result
	 * the consumer would get from the whole file (e.g. the YAML frontmatter's
	 * closing fence is fully contained and the body is discarded anyway). When
	 * false, the caller falls back to reading the entire file.
	 */
	prefixIsSufficient: (prefix: string, ctx: PrefixSufficiencyContext) => boolean;
};

/**
 * Like `createMtimeParseCache`, but for consumers that only need the HEAD of a
 * file (e.g. SKILL.md, where the parse consumes just the YAML frontmatter and
 * throws the body away). On a cache miss it `readSync`s at most `prefixBytes`
 * instead of slurping the whole file: if `prefixIsSufficient(prefix)` holds it
 * parses the prefix (a guaranteed-identical result), otherwise it falls back to
 * the full `readFileSync` path. This is purely opt-in — the generic cache above
 * is unchanged for consumers that need the full body.
 *
 * The prefix is decoded as utf-8, same as `readFileSync(_, "utf-8")`, so BOM /
 * CRLF handling is identical to the full-read path. Multi-byte safety (a char
 * split across the prefix boundary) is the caller's concern via the margin
 * check inside `prefixIsSufficient`.
 */
export function createMtimePrefixParseCache<T>(
	parse: (rawContent: string, filePath: string) => T,
	options: MtimePrefixParseOptions,
) {
	const cache = new Map<string, { mtimeMs: number; parsed: T }>();
	const { prefixBytes, prefixIsSufficient } = options;

	function readRaw(filePath: string, size: number): string {
		// Only the head-read is a win when the file is bigger than the window;
		// for files that already fit, readFileSync is the single fast syscall and
		// manual fd juggling would only add overhead — so take the full read.
		if (size <= prefixBytes) {
			return readFileSync(filePath, "utf-8");
		}
		// Large file: pull just the prefix. When the head is enough (closing
		// fence present, body irrelevant) we parse it directly and the result is
		// byte-for-byte what the full file would produce. Otherwise we fall back
		// to a full read so behavior is preserved for giant-frontmatter files.
		const buffer = Buffer.allocUnsafe(prefixBytes);
		const fd = openSync(filePath, "r");
		let bytesRead = 0;
		try {
			bytesRead = readSync(fd, buffer, 0, prefixBytes, 0);
		} finally {
			closeSync(fd);
		}
		const prefix = buffer.toString("utf-8", 0, bytesRead);
		if (prefixIsSufficient(prefix, { atEof: bytesRead >= size, bytesRead })) {
			return prefix;
		}
		return readFileSync(filePath, "utf-8");
	}

	return function read(filePath: string): T {
		const stat = statSync(filePath);
		const cached = cache.get(filePath);
		if (cached && cached.mtimeMs === stat.mtimeMs) {
			return cached.parsed;
		}
		const rawContent = readRaw(filePath, stat.size);
		const parsed = parse(rawContent, filePath);
		cache.set(filePath, { mtimeMs: stat.mtimeMs, parsed });
		return parsed;
	};
}
