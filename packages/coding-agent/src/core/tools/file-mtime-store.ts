/**
 * Per-session record of the on-disk mtime of each file at the moment the agent
 * last observed it — a read, or one of our own write/edit commits. Lets edit and
 * write warn on the "stale read" case: the file changed on disk between the read
 * the model is reasoning from and the mutation. The edit still applies to the
 * CURRENT file (oldText is matched against fresh content), so this is a non-fatal
 * note, not a block — it flags that surrounding content the model wasn't shown
 * may have moved. Cheap: one number per path, LRU-bounded so a long session can't
 * leak memory.
 */
import { stat as fsStat } from "node:fs/promises";
import { canonicalPathKey } from "./path-utils.ts";

const DEFAULT_MTIME_WINDOW = 256;

export class FileMtimeStore {
	private readonly seen = new Map<string, number>();
	private readonly max: number;
	constructor(max: number = DEFAULT_MTIME_WINDOW) {
		this.max = Math.max(1, max);
	}

	/** mtime (ms) recorded the last time we observed this path, or undefined. */
	get(absolutePath: string): number | undefined {
		return this.seen.get(canonicalPathKey(absolutePath));
	}

	/** Record/refresh the observed mtime for this path (re-insert refreshes LRU recency). */
	set(absolutePath: string, mtimeMs: number): void {
		const key = canonicalPathKey(absolutePath);
		this.seen.delete(key);
		this.seen.set(key, mtimeMs);
		while (this.seen.size > this.max) {
			const oldest = this.seen.keys().next().value;
			if (oldest === undefined) break;
			this.seen.delete(oldest);
		}
	}
}

/**
 * Stat `absolutePath` and record its mtime in `store`. Non-fatal: a failed
 * stat (permission race, file deleted mid-flight) silently skips the
 * refresh — the next read/edit re-records it. No-op when `store` is
 * undefined (custom `operations` overrides, e.g. SSH, where a local stat is
 * meaningless). Shared by `write` and `edit_v2`'s post-write refresh; `edit`
 * folds the same stat into its own post-write integrity check instead.
 */
export async function refreshFileMtime(store: FileMtimeStore | undefined, absolutePath: string): Promise<void> {
	if (!store) return;
	try {
		const st = await fsStat(absolutePath);
		store.set(absolutePath, st.mtimeMs);
	} catch {
		// stat failed — non-fatal; the next read re-records it.
	}
}
