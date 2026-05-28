/**
 * PreviewQueue
 *
 * In-process staging area for mutation tools (edit, write, edit_v2, ...).
 * A tool invoked with `{ preview: true }` computes the new content but does
 * NOT touch disk — it pushes a PreviewItem here and returns the id. The
 * `resolve` tool then commits (`apply()`) or discards the staged change.
 *
 * Pattern: stage -> review -> atomic apply.
 *
 * Single-process; no locking. Mirrors `user-input-bus.ts` and the hindsight
 * bank registry: a module-level "current queue" is set at session boot and
 * cleared on dispose, so tools can pull the active queue on demand.
 */

import { randomUUID } from "node:crypto";

export type PreviewKind = "edit" | "write" | "edit_v2" | "ast_edit";

export interface PreviewItem {
	id: string;
	kind: PreviewKind;
	path: string;
	createdAt: number;
	/** Commits the staged mutation to disk. */
	apply: () => Promise<void>;
	/** Optional cleanup (temp file removal, etc.). */
	discard?: () => Promise<void>;
	summary: {
		description: string;
		replacementCount?: number;
		diff?: string;
	};
}

export interface PreviewQueue {
	add(item: Omit<PreviewItem, "id" | "createdAt">): PreviewItem;
	get(id: string): PreviewItem | undefined;
	list(): PreviewItem[];
	accept(id: string, reason?: string): Promise<{ id: string; ok: true } | { id: string; ok: false; error: string }>;
	discard(id: string): Promise<boolean>;
	count(): number;
	clear(): void;
}

function shortId(): string {
	return randomUUID().replace(/-/g, "").slice(0, 8);
}

export function createPreviewQueue(): PreviewQueue {
	const items = new Map<string, PreviewItem>();

	const queue: PreviewQueue = {
		add(input) {
			let id = shortId();
			// Collision is astronomically rare for 8 hex chars, but be defensive.
			while (items.has(id)) {
				id = shortId();
			}
			const item: PreviewItem = {
				...input,
				id,
				createdAt: Date.now(),
			};
			items.set(id, item);
			return item;
		},

		get(id) {
			return items.get(id);
		},

		list() {
			return Array.from(items.values());
		},

		async accept(id, _reason) {
			const item = items.get(id);
			if (!item) {
				return { id, ok: false, error: `No preview found for id ${id}.` };
			}
			try {
				await item.apply();
				items.delete(id);
				return { id, ok: true };
			} catch (err) {
				// Leave the item in the queue so the model can retry or discard.
				const message = err instanceof Error ? err.message : String(err);
				return { id, ok: false, error: message };
			}
		},

		async discard(id) {
			const item = items.get(id);
			if (!item) return false;
			items.delete(id);
			if (item.discard) {
				try {
					await item.discard();
				} catch {
					// Best-effort cleanup; do not surface.
				}
			}
			return true;
		},

		count() {
			return items.size;
		},

		clear() {
			items.clear();
		},
	};

	return queue;
}

// ---------------------------------------------------------------------------
// Module-level "current session" registry. Active mode publishes the queue at
// session boot; tools pull it on demand inside execute().
// ---------------------------------------------------------------------------

let currentPreviewQueue: PreviewQueue | undefined;

export function setCurrentPreviewQueue(queue: PreviewQueue | undefined): void {
	currentPreviewQueue = queue;
}

export function getCurrentPreviewQueue(): PreviewQueue | undefined {
	return currentPreviewQueue;
}
