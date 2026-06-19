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
const DEFAULT_MTIME_WINDOW = 256;

export class FileMtimeStore {
	private readonly seen = new Map<string, number>();
	private readonly max: number;
	constructor(max: number = DEFAULT_MTIME_WINDOW) {
		this.max = Math.max(1, max);
	}

	/** mtime (ms) recorded the last time we observed this path, or undefined. */
	get(absolutePath: string): number | undefined {
		return this.seen.get(absolutePath);
	}

	/** Record/refresh the observed mtime for this path (re-insert refreshes LRU recency). */
	set(absolutePath: string, mtimeMs: number): void {
		this.seen.delete(absolutePath);
		this.seen.set(absolutePath, mtimeMs);
		while (this.seen.size > this.max) {
			const oldest = this.seen.keys().next().value;
			if (oldest === undefined) break;
			this.seen.delete(oldest);
		}
	}
}
