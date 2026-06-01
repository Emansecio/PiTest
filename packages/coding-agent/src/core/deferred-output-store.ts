import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Session-scoped store for tool outputs deferred out of context during
 * compaction. Instead of discarding a large tool output, its full text is
 * written to disk and replaced in-context by a short placeholder + id; the
 * model re-fetches on demand via the `recall_tool_output` tool. Intra-session
 * only (temp dir, removed on dispose).
 */
export interface DeferredOutputStore {
	/** Persist content, return a short retrieval id. */
	put(content: string): string;
	/** Retrieve content by id, or undefined if unknown. */
	get(id: string): string | undefined;
	dispose(): void;
}

export function createDeferredOutputStore(): DeferredOutputStore {
	const dir = mkdtempSync(join(tmpdir(), "pit-deferred-"));
	let seq = 0;
	return {
		put(content) {
			seq += 1;
			const id = `d${seq}`;
			writeFileSync(join(dir, `${id}.txt`), content, "utf8");
			return id;
		},
		get(id) {
			// Guard against path traversal: ids are `d<number>` only.
			if (!/^d\d+$/.test(id)) return undefined;
			const path = join(dir, `${id}.txt`);
			if (!existsSync(path)) return undefined;
			try {
				return readFileSync(path, "utf8");
			} catch {
				return undefined;
			}
		},
		dispose() {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		},
	};
}

let currentStore: DeferredOutputStore | undefined;
export function setCurrentDeferredOutputStore(store: DeferredOutputStore | undefined): void {
	currentStore = store;
}
export function getCurrentDeferredOutputStore(): DeferredOutputStore | undefined {
	return currentStore;
}
