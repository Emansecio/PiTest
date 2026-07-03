/**
 * N3 — range-aware read de-dup (containment + byte budget).
 *
 * Covers the containment path (a RANGE read whose file was already FULLY read
 * this session is suppressed with a marker when the range is byte-identical to
 * the corresponding slice of the full body) and the store's byte-budget eviction.
 * The safety-critical invariant: a range that changed on disk since the full read
 * is NEVER suppressed — content equality of the slice is the only signal.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createReadTool, ReadDedupeStore } from "../src/core/tools/read.js";

const dir = mkdtempSync(join(tmpdir(), "pit-read-containment-"));

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
	return res.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

/** `n` distinct, short lines: line-001, line-002, ... (plus a trailing newline). */
function lines(n: number, mutate?: (i: number) => string | undefined): string {
	const out: string[] = [];
	for (let i = 1; i <= n; i++) {
		out.push(mutate?.(i) ?? `line-${String(i).padStart(3, "0")}`);
	}
	return `${out.join("\n")}\n`;
}

describe("ReadDedupeStore byte budget", () => {
	it("evicts the least-recently-used entry when the byte budget is exceeded", () => {
		// maxEntries generous so the byte budget (not the count) drives eviction.
		const store = new ReadDedupeStore(1000, 200);
		store.record("k1", "h1", "a".repeat(100), true); // ~104 bytes
		expect(store.peek("k1")).toBeDefined();
		store.record("k2", "h2", "b".repeat(100), true); // pushes total past 200 → evict k1
		expect(store.peek("k1")).toBeUndefined();
		expect(store.peek("k2")).toBeDefined();
	});

	it("keeps a single oversized entry rather than evicting itself to empty", () => {
		const store = new ReadDedupeStore(1000, 10);
		store.record("big", "h", "z".repeat(500), true); // far over budget, but it's the only entry
		expect(store.peek("big")).toBeDefined();
	});

	it("still enforces the entry-count guard under the byte budget", () => {
		const store = new ReadDedupeStore(2, 1024 * 1024);
		store.record("k1", "h1", "x", true);
		store.record("k2", "h2", "y", true);
		store.record("k3", "h3", "z", true); // 3rd entry evicts k1 by count
		expect(store.peek("k1")).toBeUndefined();
		expect(store.peek("k3")).toBeDefined();
	});

	it("detects identical content by hash (dup only on matching hash)", () => {
		const store = new ReadDedupeStore();
		expect(store.record("k", "h1", "a", true)).toBe(false); // first sighting
		expect(store.record("k", "h1", "a", true)).toBe(true); // same hash → dup
		expect(store.record("k", "h2", "b", true)).toBe(false); // changed hash → not a dup
	});

	it("clear() resets the store (and its byte accounting) so a repeat re-sends in full", () => {
		const store = new ReadDedupeStore(1000, 32);
		store.record("k", "h1", "body-under-budget", true);
		expect(store.record("k", "h1", "body-under-budget", true)).toBe(true); // dup before clear
		store.clear();
		expect(store.peek("k")).toBeUndefined();
		expect(store.record("k", "h1", "body-under-budget", true)).toBe(false); // re-sent after clear
	});
});

describe("read containment (range after full)", () => {
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("suppresses a range read that is unchanged since a full read of the same file", async () => {
		const store = new ReadDedupeStore();
		const tool = createReadTool(dir, { embedHashlineAnchors: false, readDedupeStore: store });
		writeFileSync(join(dir, "cover.ts"), lines(30));

		await tool.execute("full", { path: "cover.ts" }); // full read seeds the store
		const ranged = textOf(await tool.execute("range", { path: "cover.ts", offset: 5, limit: 10 }));

		expect(ranged).toContain("lines 5-14 unchanged since the full read");
		expect(ranged).toContain("cover.ts");
		expect(ranged).not.toContain("line-007"); // the actual body is suppressed
	});

	it("NEVER suppresses a range whose bytes changed on disk since the full read", async () => {
		const store = new ReadDedupeStore();
		const tool = createReadTool(dir, { embedHashlineAnchors: false, readDedupeStore: store });
		writeFileSync(join(dir, "changed.ts"), lines(30));

		await tool.execute("full", { path: "changed.ts" }); // full read
		// Flip line 7 (inside the 5-14 window) then re-read that range.
		writeFileSync(
			join(dir, "changed.ts"),
			lines(30, (i) => (i === 7 ? "CHANGED-LINE-7" : undefined)),
		);
		const ranged = textOf(await tool.execute("range", { path: "changed.ts", offset: 5, limit: 10 }));

		expect(ranged).not.toContain("unchanged since the full read");
		expect(ranged).toContain("CHANGED-LINE-7"); // fresh disk content is delivered intact
	});

	it("does not fabricate a marker when there was no prior full read", async () => {
		const store = new ReadDedupeStore();
		const tool = createReadTool(dir, { embedHashlineAnchors: false, readDedupeStore: store });
		writeFileSync(join(dir, "norange.ts"), lines(30));

		const ranged = textOf(await tool.execute("range", { path: "norange.ts", offset: 5, limit: 10 }));
		expect(ranged).not.toContain("unchanged since the full read");
		expect(ranged).toContain("line-005"); // real body
	});

	it("does not suppress a range when the prior full read was truncated (not a clean full body)", async () => {
		const store = new ReadDedupeStore();
		const tool = createReadTool(dir, { embedHashlineAnchors: false, readDedupeStore: store });
		// 4000 lines > DEFAULT_MAX_LINES → the full read truncates, so it is never
		// recorded as a clean body and can't back a containment claim.
		writeFileSync(join(dir, "huge.ts"), lines(4000));

		await tool.execute("full", { path: "huge.ts" }); // truncated full read
		const ranged = textOf(await tool.execute("range", { path: "huge.ts", offset: 5, limit: 10 }));
		expect(ranged).not.toContain("unchanged since the full read");
		expect(ranged).toContain("line-005"); // real body, no false containment
	});

	it("a full read of an unchanged file is still suppressed by the exact-key path", async () => {
		const store = new ReadDedupeStore();
		const tool = createReadTool(dir, { embedHashlineAnchors: false, readDedupeStore: store });
		writeFileSync(join(dir, "exact.ts"), lines(30));

		await tool.execute("full1", { path: "exact.ts" });
		const second = textOf(await tool.execute("full2", { path: "exact.ts" }));
		expect(second).toContain("identical to an earlier read this session");
	});
});
