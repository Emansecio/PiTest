import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, VERSION } from "../config.ts";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import type { ExtensionFlag } from "./extensions/types.ts";
import { type FileStamp, isValidStamp, stampPath, stampsStillValid } from "./file-stamps.ts";

/**
 * Disk cache for `--help` extension flags so a plain `pit --help` prints
 * without building the full runtime (session + extensions + MCP config + model
 * registry — multi-second). Only the extension-contributed flags are cached;
 * the static help text is always rendered live by printHelp(), so editing
 * cli/args.ts can never serve stale text.
 *
 * Invalidation is fully automatic via a fingerprint of everything that
 * determines the extension flag set — stat (mtime+size) as the fast path, with
 * a content-hash fallback for files whose mtime changed but whose bytes did
 * not (Pit rewrites the global settings.json on every boot, so an mtime-only
 * key would self-invalidate constantly; helpers shared via file-stamps.ts):
 *   - global and project settings.json (install/remove/enable of packages)
 *   - the user and project extensions directories (add/remove local extensions)
 *   - the agent npm state (`npm/node_modules/.package-lock.json` — pkg updates)
 *   - every loaded extension entry file (including ones that failed to load)
 * Absent paths are recorded too (null stamp), so a file *appearing* is also a
 * miss. Any mismatch falls back to the full runtime path, which re-renders the
 * help and rewrites the cache. Entries are keyed by (pit version, cwd).
 *
 * Escape hatch: PIT_NO_HELP_CACHE=1 disables both read and write, forcing the
 * full path every time.
 */

const HELP_CACHE_FILE = "help-cache.json";
const HELP_CACHE_SCHEMA = 1;
/** Keep the most recent cwds only, so alternating projects don't grow the file. */
const HELP_CACHE_MAX_ENTRIES = 8;

interface HelpCacheEntry {
	/** Pit version that rendered the flags (a self-update invalidates). */
	version: string;
	cwd: string;
	stamps: FileStamp[];
	flags: ExtensionFlag[];
}

interface HelpCacheFile {
	schema: number;
	entries: HelpCacheEntry[];
}

function helpCachePath(agentDir: string): string {
	return join(agentDir, HELP_CACHE_FILE);
}

/**
 * Sources that decide *which* extensions load. Derived deterministically from
 * (cwd, agentDir) — the entry key — so validating the recorded stamps at read
 * time covers this set exactly (no need to re-derive it on the read path).
 */
function extensionSourceWatchSet(cwd: string, agentDir: string): string[] {
	return [
		join(agentDir, "settings.json"),
		join(agentDir, "extensions"),
		join(agentDir, "npm", "node_modules", ".package-lock.json"),
		join(cwd, CONFIG_DIR_NAME, "settings.json"),
		join(cwd, CONFIG_DIR_NAME, "extensions"),
	];
}

function isValidFlag(flag: unknown): flag is ExtensionFlag {
	if (typeof flag !== "object" || flag === null) {
		return false;
	}
	const f = flag as Partial<ExtensionFlag>;
	return (
		typeof f.name === "string" &&
		(f.type === "boolean" || f.type === "string") &&
		typeof f.extensionPath === "string" &&
		(f.description === undefined || typeof f.description === "string")
	);
}

function readCacheFile(agentDir: string): HelpCacheEntry[] {
	try {
		const file = JSON.parse(readFileSync(helpCachePath(agentDir), "utf8")) as Partial<HelpCacheFile>;
		if (file.schema === HELP_CACHE_SCHEMA && Array.isArray(file.entries)) {
			return file.entries;
		}
	} catch {
		// Missing/corrupt cache — treated as empty.
	}
	return [];
}

/**
 * Return the cached extension flags for (cwd, current pit version) when every
 * recorded fingerprint still matches; undefined on any miss (caller falls back
 * to the full runtime path).
 */
export function readCachedExtensionFlags(cwd: string, agentDir: string): ExtensionFlag[] | undefined {
	if (isTruthyEnvFlag(process.env.PIT_NO_HELP_CACHE)) {
		return undefined;
	}
	const entry = readCacheFile(agentDir).find((e) => e?.cwd === cwd && e.version === VERSION);
	if (!entry || !Array.isArray(entry.stamps) || !Array.isArray(entry.flags)) {
		return undefined;
	}
	if (!entry.stamps.every(isValidStamp) || !entry.flags.every(isValidFlag)) {
		return undefined;
	}
	if (!stampsStillValid(entry.stamps)) {
		return undefined;
	}
	return entry.flags;
}

/**
 * Record the freshly rendered extension flags plus the fingerprint of all their
 * sources. Best-effort: any failure just leaves `--help` on the slow path.
 */
export function writeExtensionFlagsCache(options: {
	cwd: string;
	agentDir: string;
	/** Paths of all loaded extensions plus failed-to-load ones (a fix changes flags). */
	extensionPaths: string[];
	flags: ExtensionFlag[];
}): void {
	if (isTruthyEnvFlag(process.env.PIT_NO_HELP_CACHE)) {
		return;
	}
	try {
		const { cwd, agentDir, extensionPaths, flags } = options;
		const stampPaths = new Set<string>(extensionSourceWatchSet(cwd, agentDir));
		for (const path of extensionPaths) {
			// Skip synthetic sources (inline factories register as "<factory:…>").
			if (!path || (path.startsWith("<") && path.endsWith(">"))) {
				continue;
			}
			stampPaths.add(path);
		}
		const entry: HelpCacheEntry = {
			version: VERSION,
			cwd,
			stamps: [...stampPaths].map((path) => stampPath(path)),
			flags,
		};
		const others = readCacheFile(agentDir).filter((e) => !(e?.cwd === cwd && e.version === VERSION));
		const file: HelpCacheFile = {
			schema: HELP_CACHE_SCHEMA,
			entries: [entry, ...others].slice(0, HELP_CACHE_MAX_ENTRIES),
		};
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(helpCachePath(agentDir), `${JSON.stringify(file, null, "\t")}\n`, "utf8");
	} catch {
		// Best-effort cache — --help just stays on the slow path.
	}
}
