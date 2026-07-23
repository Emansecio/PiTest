/**
 * Built-in external-edit sentinel extension.
 *
 * Today, a file changing on disk outside the session (the user's editor, a
 * formatter, another agent) is only noticed reactively: `edit`/`write`/`edit_v2`
 * each compare against `FileMtimeStore` at mutation time and inject a "changed on
 * disk since you last read it" note — but the edit still applies, and the model
 * only learns about the drift after it already decided to mutate that file. This
 * extension turns the same class of signal proactive: it keeps its own
 * `path → { mtimeMs, size }` baseline (independent of `FileMtimeStore`, which
 * exists for the edit-time note above) for every file the session has
 * read/edited/written, then sweeps it once per turn — before the model sees the
 * next prompt — so drift surfaces as a single aggregated note instead of N
 * separate stale-read notes scattered across later tool calls.
 *
 * Design:
 *  - Registration (`pi.on("tool_result")`): every successful `read`, `edit`,
 *    `edit_v2`, `write`, `ast_edit` result stats the file it touched and records
 *    `{mtimeMs, size}` as the new baseline. Because this fires on the session's
 *    OWN writes too, the baseline already reflects Pit's own mutations — a sweep
 *    divergence can only mean the disk changed through some OTHER path. This is
 *    why the sweep needs no separate "was this our own write" check against
 *    `FileMtimeStore`: the registry IS the write-aware baseline.
 *  - Sweep (`pi.on("before_agent_start")`, tagged `markMessageInjector` since it
 *    only ever injects a message, never rewrites the system prompt): once per
 *    turn, stat every registered path in parallel. A path whose (mtime OR size)
 *    differs from the registry, or that no longer stats at all (deleted, or
 *    replaced by a directory), is a candidate. Reporting a path updates its
 *    baseline to the fresh values (or drops it, if removed) so the same drift is
 *    never reported twice.
 *  - `ast_edit`'s `path` argument is optional and may name a directory (a
 *    structural rewrite across a glob) rather than one file. `statFile` returns
 *    undefined for directories, so those calls are silently skipped for
 *    registration — this extension only ever tracks single files, never dirs.
 *  - Delivery: one aggregated note per turn as a `before_agent_start` injected
 *    message (`pi.markMessageInjector`), capped at 8 listed files (+ "N more").
 *  - Read-dedupe invalidation: a changed/removed path also calls
 *    `ReadDedupeStore.invalidatePath` (via the session-supplied accessor) so the
 *    next read of that file is sent in full instead of being suppressed against
 *    a body that no longer matches disk.
 *  - Fail-open by construction: a stat failure, a missing dedupe store, or any
 *    other error degrades to "skip this path" / "no note" — it can never break
 *    the turn. Kill-switch `PIT_NO_EXTERNAL_EDIT_SENTINEL` disables registration
 *    entirely (no `pi.on` calls at all).
 */

import { stat as fsStat } from "node:fs/promises";
import { relative } from "node:path";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import type { ExtensionAPI } from "../extensions/index.js";
import { extractPathArg, resolveToolPath } from "../tools/argument-prep.ts";
import { canonicalPathKey } from "../tools/path-utils.ts";
import type { ReadDedupeStore } from "../tools/read.ts";

/** Tool names whose successful result touches exactly one file's on-disk content. */
const TRACKED_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "edit", "edit_v2", "write", "ast_edit"]);

/** Bounds the baseline registry so a long session touching many files can't leak memory. */
const REGISTRY_MAX_ENTRIES = 128;

/** Max changed/removed files listed in the aggregated note before folding into "+N more". */
const NOTE_DISPLAY_CAP = 8;

export interface FileStatSnapshot {
	mtimeMs: number;
	size: number;
}

export interface ExternalEditSentinelOptions {
	cwd: string;
	/**
	 * Accessor for the session's `ReadDedupeStore`, resolved lazily (the session
	 * is constructed after extensions are bundled). Undefined in contexts that
	 * never have one (tests, `PIT_READ_DEDUPE=0`) — invalidation is then skipped,
	 * never a hard failure.
	 */
	getReadDedupeStore?: () => ReadDedupeStore | undefined;
	/**
	 * Injected for tests so the sweep never touches the real filesystem. Defaults
	 * to `fs/promises.stat`. Returns undefined for a missing path, a directory, or
	 * any stat error — every one of those is "nothing to track" to the caller.
	 */
	statFile?: (absPath: string) => Promise<FileStatSnapshot | undefined>;
}

export function isExternalEditSentinelDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_NO_EXTERNAL_EDIT_SENTINEL);
}

async function defaultStatFile(absPath: string): Promise<FileStatSnapshot | undefined> {
	try {
		const st = await fsStat(absPath);
		if (st.isDirectory()) return undefined;
		return { mtimeMs: st.mtimeMs, size: st.size };
	} catch {
		return undefined;
	}
}

interface RegistryEntry extends FileStatSnapshot {
	absPath: string;
	/** Repo-relative, forward-slash display path when under cwd; absolute otherwise. */
	displayPath: string;
}

function toDisplayPath(cwd: string, absPath: string): string {
	const rel = relative(cwd, absPath);
	if (!rel || rel.startsWith("..")) return absPath.split("\\").join("/");
	return rel.split("\\").join("/");
}

/** One drift finding from a single sweep pass. */
interface DriftFinding {
	note: string;
}

function formatSweepNote(findings: readonly DriftFinding[]): string {
	const shown = findings.slice(0, NOTE_DISPLAY_CAP);
	const remaining = findings.length - shown.length;
	const tail = remaining > 0 ? `, +${remaining} more` : "";
	const list = shown.map((f) => f.note).join(", ");
	return `${findings.length} file(s) changed outside the session since last read: ${list}${tail}. Re-read before editing.`;
}

export function createExternalEditSentinelExtension(options: ExternalEditSentinelOptions) {
	return (pi: ExtensionAPI) => {
		if (isExternalEditSentinelDisabled()) return;
		const statFile = options.statFile ?? defaultStatFile;

		// canonicalPathKey -> baseline. Delete-then-set on every touch refreshes LRU
		// recency (same idiom as FileMtimeStore), so eviction under the cap always
		// drops the least-recently-touched path first.
		const registry = new Map<string, RegistryEntry>();

		const remember = (key: string, entry: RegistryEntry): void => {
			registry.delete(key);
			registry.set(key, entry);
			while (registry.size > REGISTRY_MAX_ENTRIES) {
				const oldest = registry.keys().next().value;
				if (oldest === undefined) break;
				registry.delete(oldest);
			}
		};

		pi.on("tool_result", async (event) => {
			try {
				if (event.isError) return undefined;
				if (!TRACKED_TOOL_NAMES.has(event.toolName)) return undefined;
				const rawPath = extractPathArg(event.input);
				if (!rawPath) return undefined;
				const absPath = resolveToolPath(rawPath, options.cwd);
				const stat = await statFile(absPath);
				// Directory (ast_edit over a glob), or the stat failed — nothing to
				// baseline for a single file; fail open rather than guess.
				if (!stat) return undefined;
				remember(canonicalPathKey(absPath), {
					...stat,
					absPath,
					displayPath: toDisplayPath(options.cwd, absPath),
				});
			} catch {
				// Registration is best-effort; never let it affect the tool result.
			}
			return undefined;
		});

		pi.on(
			"before_agent_start",
			pi.markMessageInjector(async () => {
				try {
					if (registry.size === 0) return undefined;
					const dedupeStore = options.getReadDedupeStore?.();
					const snapshot = [...registry.entries()];
					const stats = await Promise.all(snapshot.map(([, entry]) => statFile(entry.absPath)));

					const now = Date.now();
					const findings: DriftFinding[] = [];
					for (let i = 0; i < snapshot.length; i++) {
						const [key, entry] = snapshot[i];
						const stat = stats[i];
						if (!stat) {
							// Deleted (or replaced by a directory) since we last observed it.
							findings.push({ note: `${entry.displayPath} (removed)` });
							registry.delete(key);
							dedupeStore?.invalidatePath(key);
							continue;
						}
						if (stat.mtimeMs === entry.mtimeMs && stat.size === entry.size) continue;
						const ageSeconds = Math.max(0, Math.round((now - stat.mtimeMs) / 1000));
						findings.push({ note: `${entry.displayPath} (+${ageSeconds}s)` });
						// Update the baseline to the observed values so this same drift is
						// never reported again on a later sweep.
						remember(key, { ...entry, mtimeMs: stat.mtimeMs, size: stat.size });
						dedupeStore?.invalidatePath(key);
					}

					if (findings.length === 0) return undefined;
					return {
						message: {
							customType: "pi.external-edit-sentinel",
							content: formatSweepNote(findings),
							display: true,
						},
					};
				} catch {
					return undefined;
				}
			}),
		);
	};
}
