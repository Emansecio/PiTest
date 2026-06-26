/**
 * T1 #4: ReadDedupeStore is never invalidated on compaction, so a re-read of a
 * (path,range) still in the LRU window is suppressed as "already shown above"
 * even when the original body was dropped by compaction — the model then reasons
 * against content it no longer has. The fix adds clear(), called on
 * session_before_compact (mirroring the read-guard). This locks the store's part.
 */

import { describe, expect, it } from "vitest";
import { ReadDedupeStore } from "../src/core/tools/read.ts";

describe("T1 #4: ReadDedupeStore.clear() resets de-dup across compaction", () => {
	it("after clear(), a previously-seen (path,range) is re-sent in full (not a dup)", () => {
		const store = new ReadDedupeStore();
		const key = "a.ts:1-10";
		const hash = "h1";
		expect(store.record(key, hash, "body", true)).toBe(false); // first read
		expect(store.record(key, hash, "body", true)).toBe(true); // duplicate → suppressed
		store.clear(); // compaction boundary
		expect(store.record(key, hash, "body", true)).toBe(false); // re-sent in full
	});

	it("clear() empties the prior-body cache used for deltas", () => {
		const store = new ReadDedupeStore();
		const key = "b.ts:1-5";
		store.record(key, "h1", "original", true);
		expect(store.peek(key)).toBeDefined();
		store.clear();
		expect(store.peek(key)).toBeUndefined();
	});
});
