/**
 * Built-in read-guard extension.
 *
 * Blocks `edit`, `edit_v2`, and `write` tool calls on files that have not been read in the
 * current session. Prevents the model from generating diffs against
 * hallucinated file content.
 *
 * New files (that don't exist on disk) are exempt — the model can create them
 * without a prior read.
 *
 * Compaction handling: the `readFiles` set used to be cleared on
 * `session_before_compact`, forcing the model to re-read every file it had
 * already loaded into context. That is correct in the worst case (model lost
 * the content from memory) but wasteful when the file is unchanged. Instead,
 * on compaction we snapshot the current `(mtimeMs, size, hash)` of every tracked
 * file into `postCompactStamps`. Post-compaction, an edit/write is allowed
 * iff the file is either:
 *   - in `readFiles` (re-read this session), OR
 *   - in `postCompactStamps` AND the current stat+hash still matches the snapshot.
 * If the snapshot drifted (another process / another agent touched the file), the
 * stamp is consumed and the edit is blocked with a "re-read it" reason. For an
 * `edit` whose snapshot still matches, we additionally require every oldText to
 * match the file VERBATIM — the model only carried a lossy summary of the file
 * across compaction, so a fuzzy/indent match there risks corrupting the middle.
 *
 * The shared `extractPathArg` accepts the same aliases `prepareWithPathAliases`
 * will later normalize (path, file_path, filepath, filename, file). The read-guard
 * runs on the `tool_call` event — BEFORE prepareArguments — so it must accept
 * the same aliases the tool will, or a model emitting `file_path` would
 * bypass the guard entirely.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { recordDiagnostic } from "@pit/ai";
import type { ExtensionAPI } from "../extensions/index.js";
import { extractEditOldTexts, extractPathArg, resolveToolPath } from "../tools/argument-prep.ts";
import { canonicalPathKey } from "../tools/path-utils.ts";

interface FileStamp {
	mtimeMs: number;
	size: number;
	/**
	 * Content hash (lazy). mtime+size alone miss an in-place edit that keeps the byte
	 * count identical (another agent swapping a line for one of equal length);
	 * the hash closes that drift window so a stale post-compaction snapshot can't
	 * green-light an edit against changed content. Computed on first drift compare,
	 * not on every read/stat.
	 */
	hash?: string;
}

export interface ReadGuardOptions {
	cwd: string;
}

/**
 * Short path for read-guard block reasons (UI + model). Prefer cwd-relative;
 * fall back to basename so absolute Windows paths don't wrap the transcript.
 */
export function formatReadGuardPath(path: string, cwd: string): string {
	const trimmed = path.trim();
	if (!trimmed) return path;
	try {
		const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
		const rel = relative(resolve(cwd), abs);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
			return rel.replace(/\\/g, "/");
		}
		return basename(abs) || trimmed;
	} catch {
		return basename(trimmed) || trimmed;
	}
}

type ReadGuardKind = "never-read" | "stale" | "write-drift" | "postcompact-edit" | "postcompact-write";

/** One-line block reason — keeps the transcript scannable; model still has full path in tool args. */
export function formatReadGuardReason(kind: ReadGuardKind, path: string, cwd: string): string {
	const p = formatReadGuardPath(path, cwd);
	switch (kind) {
		case "never-read":
			return `Read guard: unread "${p}" — read it first.`;
		case "stale":
			return `Read guard: stale "${p}" — re-read, then retry.`;
		case "write-drift":
			return `Read guard: "${p}" changed on disk — re-read, or re-issue write to overwrite.`;
		case "postcompact-edit":
			return `Read guard: "${p}" post-compact mismatch — re-read exact region, then edit.`;
		case "postcompact-write":
			return `Read guard: "${p}" post-compact — re-read before overwrite, or re-issue write.`;
	}
}

function readFileContentSafe(absPath: string): string | undefined {
	try {
		return readFileSync(absPath, "utf-8");
	} catch {
		return undefined;
	}
}

const STAMP_READ_CHUNK_BYTES = 64 * 1024;

function hashFileSync(absPath: string): string {
	const hash = createHash("sha256");
	const fd = openSync(absPath, "r");
	try {
		const buf = Buffer.alloc(STAMP_READ_CHUNK_BYTES);
		while (true) {
			const n = readSync(fd, buf, 0, buf.length, null);
			if (n <= 0) break;
			hash.update(buf.subarray(0, n));
		}
		return hash.digest("hex");
	} finally {
		closeSync(fd);
	}
}

export function createReadGuardExtension(options: ReadGuardOptions) {
	return (pi: ExtensionAPI) => {
		const stampCache = new Map<string, FileStamp>();

		function ensureHash(absPath: string, stamp: FileStamp): string {
			if (stamp.hash !== undefined) return stamp.hash;
			const hash = hashFileSync(absPath);
			stamp.hash = hash;
			stampCache.set(absPath, stamp);
			return hash;
		}

		function stampFile(absPath: string): FileStamp | undefined {
			try {
				const st = statSync(absPath);
				const cached = stampCache.get(absPath);
				if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
					return cached;
				}
				const stamp: FileStamp = { mtimeMs: st.mtimeMs, size: st.size };
				stampCache.set(absPath, stamp);
				return stamp;
			} catch {
				return undefined;
			}
		}

		function stampContentDiffers(absPath: string, a: FileStamp, b: FileStamp): boolean {
			if (a.size !== b.size) return true;
			// Both missing hash: stats-only until background compact hashing finishes.
			if (a.hash === undefined && b.hash === undefined) return false;
			if (a.hash !== undefined && b.hash !== undefined) return a.hash !== b.hash;
			// One stamp already captured content at stamp-time; hash the other from disk now.
			const known = a.hash !== undefined ? a : b;
			const other = a.hash !== undefined ? b : a;
			return known.hash !== ensureHash(absPath, other);
		}

		function stampStatMatches(absPath: string, a: FileStamp, b: FileStamp): boolean {
			return a.mtimeMs === b.mtimeMs && a.size === b.size && !stampContentDiffers(absPath, a, b);
		}
		// Maps an absolute path to its content stamp AT READ TIME (or null when the
		// file couldn't be stamped). Membership = "read this session"; the stamp
		// powers the intra-session drift guard below.
		const readFiles = new Map<string, FileStamp | null>();
		const postCompactStamps = new Map<string, FileStamp>();
		// Files already warned about overwriting (post-compaction OR intra-session
		// drift) — fire-once anti-wedge: a verbatim re-issue runs.
		const firedWriteWarnings = new Set<string>();

		pi.on("tool_call", (event) => {
			if (event.toolName === "read") {
				const path = extractPathArg(event.input as Record<string, unknown>);
				if (path !== undefined) {
					const abs = canonicalPathKey(resolveToolPath(path, options.cwd));
					// Stamp at read time so a later write can detect the file drifting
					// underneath the model (concurrent user edit / git checkout / another
					// agent). null = unstampable -> drift check can't fire (fail-open).
					readFiles.set(abs, stampFile(abs) ?? null);
					// A fresh read supersedes any stale gate.
					postCompactStamps.delete(abs);
					firedWriteWarnings.delete(abs);
				}
				return undefined;
			}

			if (event.toolName === "edit" || event.toolName === "edit_v2" || event.toolName === "write") {
				const path = extractPathArg(event.input as Record<string, unknown>);
				if (path === undefined) return undefined;

				const abs = canonicalPathKey(resolveToolPath(path, options.cwd));

				// New files don't need a prior read. Probe existence with a
				// single statSync instead of existsSync (+ a later statSync):
				// a throw (ENOENT or any error) means the file does not exist
				// on disk, matching the old `!existsSync(abs)` allow branch.
				try {
					statSync(abs);
				} catch {
					return undefined;
				}

				if (readFiles.has(abs)) {
					// Intra-session drift guard (WRITE only): the file was read this
					// session, but a `write` OVERWRITES the whole file from the model's
					// in-context copy. If the bytes on disk changed since that read
					// (concurrent user edit / git op / another agent), the overwrite
					// would silently clobber that change. `edit` is exempt — its oldText
					// is dry-run-matched against current disk by edit-precondition, so a
					// surgical edit can't clobber an unseen region. Compare on content
					// (hash+size), ignoring mtime, so a touch/reformat that left bytes
					// identical isn't a false drift.
					if (event.toolName === "write") {
						const readStamp = readFiles.get(abs);
						const current = stampFile(abs);
						const drifted =
							readStamp != null && current !== undefined && stampContentDiffers(abs, current, readStamp);
						if (drifted && !firedWriteWarnings.has(abs)) {
							firedWriteWarnings.add(abs);
							recordDiagnostic({
								category: "guard.read",
								level: "info",
								source: "read-guard-extension.intraSessionDrift",
								context: {
									path,
									outcome: "blocked",
									ruleId: "write-drift-clobber",
									toolName: event.toolName,
									toolCallId: event.toolCallId,
								},
							});
							return {
								block: true,
								reason: formatReadGuardReason("write-drift", path, options.cwd),
							};
						}
						// A write that reaches here with a pending intra-session-drift
						// warning means the model is OVERRIDING the fire-once warning by
						// re-issuing the identical call. Record the acceptance so
						// override-rate is measurable vs the blocks above. (A normal write
						// to a read, undrifted file never entered firedWriteWarnings, so
						// this stays silent in the common case.)
						if (firedWriteWarnings.has(abs)) {
							recordDiagnostic({
								category: "guard.read",
								level: "info",
								source: "read-guard-extension.writeWarnOverridden",
								context: {
									path,
									outcome: "overridden",
									ruleId: "write-drift-clobber",
									toolName: event.toolName,
									toolCallId: event.toolCallId,
								},
							});
						}
					}
					return undefined;
				}

				const stamp = postCompactStamps.get(abs);
				if (stamp !== undefined) {
					const current = stampFile(abs);
					const statMatches = current !== undefined && stampStatMatches(abs, current, stamp);
					if (statMatches) {
						// Unchanged since pre-compaction read. The model only carried the
						// SUMMARY of this file across compaction (head+tail excerpt), so the
						// middle is amnesic. Allow editing without a re-read only when every
						// oldText still matches EXACTLY — that proves the model is anchored to
						// real content, not reconstructing from a lossy summary (which would
						// otherwise slip through fuzzy/indent matching and corrupt the file).
						// edit verifies every oldText verbatim (below); write has no anchor at
						// all, so a post-compaction overwrite gets a one-time warning instead.
						if (event.toolName === "edit") {
							const oldTexts = extractEditOldTexts(event.input as Record<string, unknown>);
							if (oldTexts.length > 0) {
								// const (not let) so the narrowed type survives into the `.some` closure.
								const fileContent = readFileContentSafe(abs);
								if (fileContent !== undefined && oldTexts.some((t) => !fileContent.includes(t))) {
									postCompactStamps.delete(abs);
									recordDiagnostic({
										category: "guard.read",
										level: "info",
										source: "read-guard-extension.postCompactEditMismatch",
										context: {
											path,
											outcome: "blocked",
											ruleId: "postcompact-edit-mismatch",
											toolName: event.toolName,
											toolCallId: event.toolCallId,
										},
									});
									return {
										block: true,
										reason: formatReadGuardReason("postcompact-edit", path, options.cwd),
									};
								}
							}
						}
						if (event.toolName === "write" && !firedWriteWarnings.has(abs)) {
							// A write OVERWRITES the whole file. Across compaction the model only
							// carried a lossy summary (head+tail excerpt), so a blind overwrite
							// from that risks dropping the amnesic middle — a higher data-loss
							// risk than an edit (which is anchored by oldText). Warn ONCE: a
							// re-issue means the overwrite is intended and runs.
							firedWriteWarnings.add(abs);
							recordDiagnostic({
								category: "guard.read",
								level: "info",
								source: "read-guard-extension.postCompactWriteWarn",
								context: {
									path,
									outcome: "blocked",
									ruleId: "postcompact-write-overwrite",
									toolName: event.toolName,
									toolCallId: event.toolCallId,
								},
							});
							return {
								block: true,
								reason: formatReadGuardReason("postcompact-write", path, options.cwd),
							};
						}
						// A write that reaches here with a pending post-compaction warning
						// is the model OVERRIDING the fire-once warn by re-issuing the
						// identical call. Record the acceptance so override-rate is
						// measurable vs the postCompactWriteWarn blocks above. (Stays
						// silent for an edit, or a write that was never warned.)
						if (event.toolName === "write" && firedWriteWarnings.has(abs)) {
							recordDiagnostic({
								category: "guard.read",
								level: "info",
								source: "read-guard-extension.writeWarnOverridden",
								context: {
									path,
									outcome: "overridden",
									ruleId: "postcompact-write-overwrite",
									toolName: event.toolName,
									toolCallId: event.toolCallId,
								},
							});
						}
						return undefined;
					}
					// Drifted (or stat failed) — consume the stale stamp so the
					// model can't accidentally retry and slip through.
					postCompactStamps.delete(abs);
					recordDiagnostic({
						category: "guard.read",
						level: "info",
						source: "read-guard-extension.stampDrifted",
						context: {
							path,
							outcome: "blocked",
							ruleId: "stamp-drifted",
							toolName: event.toolName,
							toolCallId: event.toolCallId,
						},
					});
					return {
						block: true,
						reason: formatReadGuardReason("stale", path, options.cwd),
					};
				}

				recordDiagnostic({
					category: "guard.read",
					level: "info",
					source: "read-guard-extension.neverRead",
					context: {
						path,
						outcome: "blocked",
						ruleId: "edit-never-read",
						toolName: event.toolName,
						toolCallId: event.toolCallId,
					},
				});
				return {
					block: true,
					reason: formatReadGuardReason("never-read", path, options.cwd),
				};
			}

			return undefined;
		});

		// After the model's OWN successful write/edit, the file on disk is now what
		// the model just authored — re-stamp it so a follow-up write doesn't read
		// the model's own change as external drift (false positive). Only re-stamp
		// already-tracked files: a brand-new file the model just created stays
		// untracked (its first edit still requires the normal read), preserving the
		// existing new-file contract.
		pi.on("tool_result", (event) => {
			if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "edit_v2") return undefined;
			if (event.isError) return undefined;
			const path = extractPathArg(event.input as Record<string, unknown>);
			if (path === undefined) return undefined;
			const abs = canonicalPathKey(resolveToolPath(path, options.cwd));
			// A post-compaction file lives only in postCompactStamps (readFiles was
			// cleared at session_before_compact). The model's own successful edit/write
			// is now the disk baseline — refresh the snapshot so a follow-up edit isn't
			// read as external drift (the pre-edit stamp would no longer statMatch).
			if (postCompactStamps.has(abs)) {
				const restamp = stampFile(abs);
				if (restamp) postCompactStamps.set(abs, restamp);
				firedWriteWarnings.delete(abs);
				return undefined;
			}
			if (!readFiles.has(abs)) return undefined;
			readFiles.set(abs, stampFile(abs) ?? null);
			firedWriteWarnings.delete(abs);
			return undefined;
		});

		// On compaction, migrate the in-memory read set to a stat snapshot. The
		// model loses the verbatim content (it only sees the summary) but if the
		// file on disk has not drifted by the time it tries to edit, we can
		// still trust the snapshot it carried into context. Hashing is deferred
		// to setImmediate so compact doesn't block the event loop on N full-file
		// SHA-256 passes; stampContentDiffers falls back to mtime+size until ready.
		pi.on("session_before_compact", () => {
			const pendingHash: Array<{ abs: string; stamp: FileStamp }> = [];
			for (const abs of readFiles.keys()) {
				const stamp = stampFile(abs);
				if (stamp) {
					postCompactStamps.set(abs, stamp);
					if (stamp.hash === undefined) pendingHash.push({ abs, stamp });
				}
				// If stat fails (file deleted/permissions), we drop the entry —
				// the model will have to re-read, which is correct.
			}
			readFiles.clear();
			if (pendingHash.length > 0) {
				setImmediate(() => {
					for (const { abs, stamp } of pendingHash) {
						if (postCompactStamps.get(abs) !== stamp) continue;
						try {
							ensureHash(abs, stamp);
						} catch {
							// Best-effort; drift compare stays stats-only without a hash.
						}
					}
				});
			}
		});
	};
}
