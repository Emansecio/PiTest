import { renameSync, rmSync, writeFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";

export interface AsyncAtomicWriteOperations {
	write: (path: string, content: string) => Promise<void>;
	rename: (from: string, to: string) => Promise<void>;
	remove: (path: string) => Promise<void>;
}

export interface SyncAtomicWriteOperations {
	write: (path: string, content: string) => void;
	rename: (from: string, to: string) => void;
	remove: (path: string) => void;
}

const asyncOperations: AsyncAtomicWriteOperations = {
	write: (path, content) => writeFile(path, content, "utf-8"),
	rename,
	remove: (path) => rm(path, { force: true }),
};

const syncOperations: SyncAtomicWriteOperations = {
	write: (path, content) => writeFileSync(path, content, "utf-8"),
	rename: renameSync,
	remove: (path) => rmSync(path, { force: true }),
};

// Per-process monotonic counter so two overlapping writes to the SAME path don't
// collide on the temp name (a pid-only suffix did — the LSP rename-rollback hit
// this). Plain number; never resets within a process.
let tmpCounter = 0;

/**
 * Write `content` to `filePath` atomically: write a sibling temp file, then rename
 * it over the target. Rename is atomic on the same volume, so a concurrent reader
 * never sees a half-written file and an interrupted write never truncates the
 * original (the failure modes of a plain truncate-then-rewrite `writeFile`).
 *
 * Abort semantics: when `signal` is given, cancellation is honored UP TO the
 * rename. Aborted after the temp is written but before the commit → the temp is
 * removed and the original is left untouched, so the caller correctly observes the
 * write as NOT applied (no disk/model divergence, no duplicate on retry). Once the
 * rename lands the write has happened and abort is no longer honored.
 *
 * Fallback: if the rename fails (EXDEV cross-volume, EPERM), it degrades to a
 * direct write — non-atomic, but no worse than a plain `writeFile`.
 */
export async function writeFileAtomic(
	filePath: string,
	content: string,
	signal?: AbortSignal,
	operations: AsyncAtomicWriteOperations = asyncOperations,
): Promise<void> {
	const tmp = `${filePath}.tmp-${process.pid}-${tmpCounter++}`;
	let tempWritten = false;
	try {
		await operations.write(tmp, content);
		tempWritten = true;
		// Commit point is the rename below; honor abort right before it so a cancel
		// here leaves the original intact.
		if (signal?.aborted) {
			await operations.remove(tmp).catch(() => {});
			throw new Error("Operation aborted");
		}
		await operations.rename(tmp, filePath);
	} catch (err) {
		await operations.remove(tmp).catch(() => {});
		// A pre-commit abort must propagate (the write did NOT happen).
		if (!tempWritten || (err instanceof Error && err.message === "Operation aborted")) throw err;
		// Rename can fail across volumes or on locked targets — fall back to a
		// direct write so the operation still succeeds where a plain writeFile would.
		await operations.write(filePath, content);
	}
}

/**
 * Synchronous counterpart of {@link writeFileAtomic} for call-sites that must stay
 * sync (e.g. inside a sync file lock). Same temp-then-rename guarantee: a crash or
 * kill during the write never truncates the original, and a concurrent reader never
 * sees a half-written file. Falls back to a direct write if the rename fails.
 */
export function writeFileAtomicSync(
	filePath: string,
	content: string,
	operations: SyncAtomicWriteOperations = syncOperations,
): void {
	const tmp = `${filePath}.tmp-${process.pid}-${tmpCounter++}`;
	let tempWritten = false;
	try {
		operations.write(tmp, content);
		tempWritten = true;
		operations.rename(tmp, filePath);
	} catch (error) {
		try {
			operations.remove(tmp);
		} catch {
			// best-effort cleanup
		}
		if (!tempWritten) throw error;
		operations.write(filePath, content);
	}
}
