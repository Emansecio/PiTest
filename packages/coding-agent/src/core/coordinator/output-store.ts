import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactForDisk } from "../secret-redactor.ts";

/**
 * Session-scoped, disk-backed store for the INTEGRAL (untruncated) final output
 * of each settled subagent, keyed by its task handle.
 *
 * Why disk (N7, auditoria §3.5/§5.8): the parent used to carry a 24KB tail of a
 * subagent's output permanently in context, with the full text only in the
 * in-memory registry — losing an elided excerpt meant re-spawning. Now the
 * parent sees a small head+tail digest + a pointer, and the full output is
 * persisted here so `task({op:"read"})` can recover it without a re-spawn. The
 * in-memory registry stays the PRIMARY cache; disk is the recovery layer that
 * also survives registry eviction and resume/continue runs (which re-drive a
 * live Agent and never write a registry record).
 *
 * Mirrors `deferred-output-store.ts`: bytes that land on disk pass through
 * `redactForDisk` (repo invariant for disk artifacts), the temp dir is created
 * lazily on first write, a disk I/O failure degrades the store to a silent no-op
 * for the rest of the session (never aborts a turn), and the temp dir is removed
 * on `dispose`. Intra-session only.
 *
 * Handles are mapped to opaque `s<seq>.txt` filenames via an in-memory index so
 * arbitrary handle strings can never traverse the filesystem and two distinct
 * handles can never collide on a sanitized name. The index holds only the tiny
 * handle→filename mapping; the (potentially large) output lives solely on disk.
 */
export interface SubagentOutputStore {
	/** Persist the full output for `handle` (redacted). Best-effort; a disk failure is swallowed. */
	put(handle: string, content: string): void;
	/** Retrieve the full output for `handle`, or undefined if never stored / unavailable. */
	get(handle: string): string | undefined;
	/** Remove the temp dir and clear the index. Idempotent. */
	dispose(): void;
}

export interface SubagentOutputStoreOptions {
	/** Directory outputs are written to (created lazily on first write). Test seam; defaults to a fresh temp dir. */
	dir?: string;
}

export function createSubagentOutputStore(options?: SubagentOutputStoreOptions): SubagentOutputStore {
	// handle -> "s<seq>.txt"; only the mapping is held in memory, never the content.
	const index = new Map<string, string>();
	let seq = 0;
	// Created lazily on first write so a session that never spawns touches no filesystem.
	let dir: string | undefined;
	// Set on the first write failure: degrade to a no-op for the rest of the session
	// instead of re-failing on every subsequent put.
	let diskUnavailable = false;

	function ensureDir(): string | undefined {
		if (diskUnavailable) return undefined;
		if (dir === undefined) {
			try {
				if (options?.dir !== undefined) {
					mkdirSync(options.dir, { recursive: true });
					dir = options.dir;
				} else {
					dir = mkdtempSync(join(tmpdir(), "pit-subagent-"));
				}
			} catch {
				diskUnavailable = true;
				return undefined;
			}
		}
		return dir;
	}

	return {
		put(handle, content) {
			const target = ensureDir();
			if (target === undefined) return;
			// Reuse the same filename when a handle is re-stored (resume/continue), so a
			// later op:"read" always resolves to the latest output.
			const file = index.get(handle) ?? `s${++seq}.txt`;
			try {
				// Repo invariant: bytes that land on disk pass through redactForDisk.
				writeFileSync(join(target, file), redactForDisk(content), "utf8");
				index.set(handle, file);
			} catch {
				diskUnavailable = true;
			}
		},
		get(handle) {
			const file = index.get(handle);
			if (file === undefined || dir === undefined) return undefined;
			const path = join(dir, file);
			if (!existsSync(path)) return undefined;
			try {
				return readFileSync(path, "utf8");
			} catch {
				return undefined;
			}
		},
		dispose() {
			index.clear();
			if (dir !== undefined) {
				try {
					rmSync(dir, { recursive: true, force: true });
				} catch {
					// best-effort
				}
				dir = undefined;
			}
		},
	};
}
