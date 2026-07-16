import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";

/**
 * Shared filesystem fingerprint helpers for the boot-time disk caches
 * (help-cache, resolve-cache). A FileStamp records the identity of one path at
 * cache-write time; `stampStillValid` re-checks it at read time.
 *
 * Semantics (designed around the discovery that Pit rewrites the global
 * settings.json on every boot with identical bytes — an mtime-only key would
 * self-invalidate constantly):
 *   - file stamps use stat (mtime+size) as the fast path; when only the mtime
 *     drifted and a content hash was recorded, identical bytes still count.
 *   - dir stamps record a digest of the child entry listing (names + types).
 *     Dir mtime alone is NOT a reliable add/remove signal: on Windows/NTFS,
 *     creating a subdirectory does not bump the parent's mtime (measured),
 *     only file creation/removal does. The digest catches every child
 *     add/remove/rename regardless. Legacy dir stamps without a digest fall
 *     back to the mtime rule.
 *   - "missing" stamps require the path to still be absent (appearance = miss).
 *   - existence-only stamps (mtimeMs === null on a file/dir kind) match as long
 *     as the path still exists with the same kind — for inputs where only
 *     presence matters (e.g. an ancestor `.git`, whose mtime churns on every
 *     git operation).
 */
export interface FileStamp {
	path: string;
	/** "missing" = the path did not exist at cache time (its appearance invalidates). */
	kind: "file" | "dir" | "missing";
	/** null on "missing" stamps and on existence-only stamps. */
	mtimeMs: number | null;
	size: number | null;
	/** sha1 of file contents; only for kind "file" when hashing was requested. */
	hash: string | null;
	/**
	 * sha1 of the sorted child entry listing (name + type); only for kind "dir"
	 * (absent on existence-only stamps and entries written by older versions).
	 */
	children?: string | null;
}

function childrenDigestOf(entries: Dirent[]): string {
	const listing = entries
		.map((entry) => {
			const type = entry.isDirectory() ? "d" : entry.isFile() ? "f" : entry.isSymbolicLink() ? "l" : "o";
			return `${entry.name}/${type}`;
		})
		.sort()
		.join("\0");
	return createHash("sha1").update(listing).digest("hex");
}

function childrenDigestSync(path: string): string | null {
	try {
		return childrenDigestOf(readdirSync(path, { withFileTypes: true }));
	} catch {
		return null;
	}
}

async function childrenDigestAsync(path: string): Promise<string | null> {
	try {
		return childrenDigestOf(await readdir(path, { withFileTypes: true }));
	} catch {
		return null;
	}
}

export function hashFile(path: string): string | null {
	try {
		return createHash("sha1").update(readFileSync(path)).digest("hex");
	} catch {
		return null;
	}
}

export interface StampOptions {
	/**
	 * Record a sha1 of file contents so an mtime-only rewrite with identical
	 * bytes still validates. Costs a read per file at write time — reserve it
	 * for files that are rewritten in place (settings.json). Default true to
	 * preserve the original help-cache behavior.
	 */
	hash?: boolean;
	/**
	 * Record only existence+kind; mtime/size are ignored at validation time.
	 * For paths whose *presence* is the input, not their content (.git).
	 */
	existenceOnly?: boolean;
}

export function stampPath(path: string, options?: StampOptions): FileStamp {
	let stats: Stats;
	try {
		stats = statSync(path);
	} catch {
		return { path, kind: "missing", mtimeMs: null, size: null, hash: null };
	}
	if (stats.isDirectory()) {
		if (options?.existenceOnly) {
			return { path, kind: "dir", mtimeMs: null, size: null, hash: null };
		}
		return { path, kind: "dir", mtimeMs: stats.mtimeMs, size: null, hash: null, children: childrenDigestSync(path) };
	}
	if (options?.existenceOnly) {
		return { path, kind: "file", mtimeMs: null, size: null, hash: null };
	}
	return {
		path,
		kind: "file",
		mtimeMs: stats.mtimeMs,
		size: stats.size,
		hash: (options?.hash ?? true) ? hashFile(path) : null,
	};
}

/**
 * Directory rule: digest of the child listing when recorded (the reliable
 * add/remove/rename signal), else the legacy mtime rule; existence-only
 * stamps (mtimeMs null, no digest) match on kind alone.
 */
function dirStampNeedsDigest(stamp: FileStamp): boolean {
	return typeof stamp.children === "string";
}

function dirStampMatchesWithoutDigest(stamp: FileStamp, stats: Stats): boolean {
	return stamp.kind === "dir" && (stamp.mtimeMs === null || stats.mtimeMs === stamp.mtimeMs);
}

function fileStampMatches(stamp: FileStamp, stats: Stats, readHash: () => string | null): boolean {
	if (stamp.kind !== "file") {
		return false;
	}
	if (stamp.mtimeMs === null) {
		// Existence-only stamp: any file at this path satisfies it.
		return true;
	}
	if (stats.mtimeMs === stamp.mtimeMs && stats.size === stamp.size) {
		return true;
	}
	// mtime/size drifted — same content still counts (boot rewrites settings.json
	// with identical bytes on every run). Only for stamps that recorded a hash.
	return stamp.hash !== null && stats.size === stamp.size && readHash() === stamp.hash;
}

/**
 * A recorded file stamp still matches when the stat identity is unchanged
 * (fast path, no reads), or — mtime bumped — when the bytes are still the
 * same (content-hash fallback). Directories match on their child-listing
 * digest (legacy entries: mtime); missing paths must still be missing.
 */
export function stampStillValid(stamp: FileStamp): boolean {
	let stats: Stats | undefined;
	try {
		stats = statSync(stamp.path);
	} catch {
		stats = undefined;
	}
	if (!stats) {
		return stamp.kind === "missing";
	}
	if (stats.isDirectory()) {
		if (stamp.kind !== "dir") {
			return false;
		}
		if (dirStampNeedsDigest(stamp)) {
			return childrenDigestSync(stamp.path) === stamp.children;
		}
		return dirStampMatchesWithoutDigest(stamp, stats);
	}
	return fileStampMatches(stamp, stats, () => hashFile(stamp.path));
}

export function stampsStillValid(stamps: FileStamp[]): boolean {
	return stamps.every(stampStillValid);
}

async function hashFileAsync(path: string): Promise<string | null> {
	try {
		return createHash("sha1")
			.update(await readFile(path))
			.digest("hex");
	} catch {
		return null;
	}
}

async function stampStillValidAsync(stamp: FileStamp): Promise<boolean> {
	let stats: Stats | undefined;
	try {
		stats = await stat(stamp.path);
	} catch {
		stats = undefined;
	}
	if (!stats) {
		return stamp.kind === "missing";
	}
	if (stats.isDirectory()) {
		if (stamp.kind !== "dir") {
			return false;
		}
		if (dirStampNeedsDigest(stamp)) {
			return (await childrenDigestAsync(stamp.path)) === stamp.children;
		}
		return dirStampMatchesWithoutDigest(stamp, stats);
	}
	// Fast path first (pure stat compare); only fall back to the async hash when
	// the stat identity drifted and a hash was recorded.
	if (fileStampMatches(stamp, stats, () => null)) {
		return true;
	}
	if (stamp.kind !== "file" || stamp.hash === null || stats.size !== stamp.size) {
		return false;
	}
	return (await hashFileAsync(stamp.path)) === stamp.hash;
}

/**
 * Parallel validation of a stamp set (fs/promises fan-out). Hundreds of stamps
 * validate in a few ms of wall time instead of a serial statSync per entry —
 * this is what makes a large resolve-cache fingerprint cheap on the boot path.
 */
export async function stampsStillValidAsync(stamps: FileStamp[]): Promise<boolean> {
	const results = await Promise.all(stamps.map(stampStillValidAsync));
	return results.every(Boolean);
}

export function isValidStamp(stamp: unknown): stamp is FileStamp {
	if (typeof stamp !== "object" || stamp === null) {
		return false;
	}
	const s = stamp as Partial<FileStamp>;
	return (
		typeof s.path === "string" &&
		(s.kind === "file" || s.kind === "dir" || s.kind === "missing") &&
		(typeof s.mtimeMs === "number" || s.mtimeMs === null) &&
		(typeof s.size === "number" || s.size === null) &&
		(typeof s.hash === "string" || s.hash === null) &&
		(s.children === undefined || s.children === null || typeof s.children === "string")
	);
}
