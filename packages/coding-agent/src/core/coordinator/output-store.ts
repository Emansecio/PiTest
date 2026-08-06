import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
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
	put(handle: string, content: string): Promise<void>;
	/** Retrieve the full output for `handle`, or undefined if never stored / unavailable. */
	get(handle: string): Promise<string | undefined>;
	/** Remove the temp dir and clear the index. Idempotent. */
	dispose(): Promise<void>;
}

export interface SubagentOutputStoreOptions {
	/** Directory outputs are written to (created lazily on first write). Test seam; defaults to a fresh temp dir. */
	dir?: string;
	/** Maximum number of integral outputs retained in one session. */
	maxEntries?: number;
	/** Maximum UTF-8 bytes retained in one session. */
	maxBytes?: number;
}

export function createSubagentOutputStore(options?: SubagentOutputStoreOptions): SubagentOutputStore {
	// handle -> filename/size; only the mapping is held in memory, never the content.
	const index = new Map<string, { file: string; bytes: number }>();
	const maxEntries = Math.max(1, options?.maxEntries ?? 256);
	const maxBytes = Math.max(1, options?.maxBytes ?? 16 * 1024 * 1024);
	let totalBytes = 0;
	let seq = 0;
	// Created lazily on first write so a session that never spawns touches no filesystem.
	let dir: string | undefined;
	// Set on the first write failure: degrade to a no-op for the rest of the session
	// instead of re-failing on every subsequent put.
	let diskUnavailable = false;
	let disposed = false;
	let queue: Promise<void> = Promise.resolve();

	async function ensureDir(): Promise<string | undefined> {
		if (diskUnavailable) return undefined;
		if (dir === undefined) {
			try {
				if (options?.dir !== undefined) {
					await mkdir(options.dir, { recursive: true });
					dir = options.dir;
				} else {
					dir = await mkdtemp(join(tmpdir(), "pit-subagent-"));
				}
			} catch {
				diskUnavailable = true;
				return undefined;
			}
		}
		return dir;
	}

	function enqueue(work: () => Promise<void>): Promise<void> {
		const next = queue.then(work, work);
		queue = next.catch(() => {});
		return next;
	}

	async function trim(target: string, protectedHandle: string): Promise<void> {
		while (index.size > maxEntries || totalBytes > maxBytes) {
			const oldest = index.keys().next().value;
			if (oldest === undefined) break;
			const entry = index.get(oldest);
			if (!entry) {
				index.delete(oldest);
				continue;
			}
			// A single oversized output is not useful as a retained side channel.
			// Evict it immediately rather than allowing the cap to be exceeded forever.
			if (oldest === protectedHandle && index.size === 1) {
				try {
					await unlink(join(target, entry.file));
				} catch {
					// best-effort
				}
				index.delete(oldest);
				totalBytes -= entry.bytes;
				break;
			}
			try {
				await unlink(join(target, entry.file));
			} catch {
				// best-effort
			}
			index.delete(oldest);
			totalBytes -= entry.bytes;
		}
	}

	return {
		put(handle, content) {
			if (disposed) return Promise.resolve();
			return enqueue(async () => {
				const target = await ensureDir();
				if (target === undefined || disposed) return;
				try {
					const redacted = redactForDisk(content);
					const bytes = Buffer.byteLength(redacted, "utf8");
					const previous = index.get(handle);
					if (bytes > maxBytes) {
						// Do not write an output that will be evicted immediately. Remove an
						// older value for the same handle so the cap remains meaningful.
						if (previous) {
							try {
								await unlink(join(target, previous.file));
							} catch {
								// best-effort
							}
							index.delete(handle);
							totalBytes -= previous.bytes;
						}
						return;
					}
					const file = previous?.file ?? `s${++seq}.txt`;
					await writeFile(join(target, file), redacted, "utf8");
					if (previous) totalBytes -= previous.bytes;
					index.delete(handle);
					index.set(handle, { file, bytes });
					totalBytes += bytes;
					await trim(target, handle);
				} catch {
					diskUnavailable = true;
				}
			});
		},
		async get(handle) {
			if (disposed) return undefined;
			await queue;
			if (disposed || dir === undefined) return undefined;
			const entry = index.get(handle);
			if (entry === undefined) return undefined;
			try {
				return await readFile(join(dir, entry.file), "utf8");
			} catch {
				return undefined;
			}
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			await queue;
			index.clear();
			totalBytes = 0;
			if (dir !== undefined) {
				const target = dir;
				dir = undefined;
				try {
					await rm(target, { recursive: true, force: true });
				} catch {
					// best-effort
				}
			}
		},
	};
}
