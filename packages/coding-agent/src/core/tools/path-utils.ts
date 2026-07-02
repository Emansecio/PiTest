import { accessSync, constants, realpathSync } from "node:fs";
import * as os from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

/**
 * True on filesystems that are case-insensitive by default (Windows, macOS).
 * Governs whether a path KEY is case-folded — never used to rewrite a path a
 * tool actually operates on.
 */
export const FS_CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

/**
 * Canonical map/set KEY for an already-resolved absolute path.
 *
 * Resolves symlinks via `fs.realpathSync.native` — so a `read` through a symlink
 * and an `edit` of its target collapse to ONE key — and, on case-insensitive
 * platforms (win32/darwin), lowercases the result so `README.md` and `readme.md`
 * (the same file there) don't hash to two entries. On any error (the file
 * doesn't exist yet, permissions) it falls back to the input, so a brand-new
 * path still gets a stable key.
 *
 * KEY ONLY. Callers must never substitute this for the path the tool receives,
 * nor surface it in a user-visible message: it is a normalized identity for
 * map/set membership, not the real (case-/link-preserving) path.
 */
export function canonicalPathKey(absPath: string): string {
	let real = absPath;
	try {
		real = realpathSync.native(absPath);
	} catch {
		// Non-existent / unreadable path — keep the resolved input as the key.
	}
	return FS_CASE_INSENSITIVE ? real.toLowerCase() : real;
}

/**
 * Equality of two path components (basenames) as KEYS: case-insensitive on
 * win32/darwin, exact elsewhere. Same "KEY only" caveat as {@link canonicalPathKey}
 * — used to decide whether two directory entries denote the same file, never to
 * rewrite either name.
 */
export function sameCanonicalName(a: string, b: string): boolean {
	return FS_CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Matches a URL-like prefix (e.g. `pr://`, `conflict://`). Kept local so we
// don't pull in the url-schemes module \u2014 these helpers are called from many
// places that must stay independent of the scheme registry.
export const URL_SCHEME_RE = /^[a-z][a-z0-9+-]*:\/\//;

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";
function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	// macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function normalizeAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

/**
 * Strip a trailing `:line` or `:line:col` suffix a model copied from grep /
 * find-symbol output into a path arg ("src/x.ts:42" -> "src/x.ts"). The capture
 * requires a non-`:` char before the suffix and bails on a bare drive-relative
 * path ("C:42"), so a Windows drive prefix is never mangled. Real filenames
 * almost never end in `:<digits>` (the char is invalid on Windows, vanishing on
 * POSIX), so this is safe to apply unconditionally to every path arg.
 */
function stripLineSuffix(filePath: string): string {
	const match = filePath.match(/^(.*?[^:]):\d+(?::\d+)?$/);
	if (!match) return filePath;
	const base = match[1];
	if (/^[a-zA-Z]$/.test(base)) return filePath; // "C:42" drive-relative — leave intact
	return base;
}

export function expandPath(filePath: string): string {
	const normalized = stripLineSuffix(normalizeUnicodeSpaces(normalizeAtPrefix(filePath)));
	if (normalized === "~") {
		return os.homedir();
	}
	if (normalized.startsWith("~/")) {
		return os.homedir() + normalized.slice(1);
	}
	return normalized;
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	// URL-scheme paths (e.g. `pr://1428`) are virtual — never touch the FS for them.
	if (URL_SCHEME_RE.test(filePath)) return filePath;
	const expanded = expandPath(filePath);
	if (isAbsolute(expanded)) {
		return expanded;
	}
	return resolvePath(cwd, expanded);
}

export function resolveReadPath(filePath: string, cwd: string): string {
	if (URL_SCHEME_RE.test(filePath)) return filePath;
	const resolved = resolveToCwd(filePath, cwd);

	if (fileExists(resolved)) {
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExists(amPmVariant)) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && fileExists(nfdVariant)) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExists(curlyVariant)) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
		return nfdCurlyVariant;
	}

	return resolved;
}
