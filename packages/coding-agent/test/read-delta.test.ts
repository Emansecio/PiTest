import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createReadTool, ReadDedupeStore } from "../src/core/tools/read.js";

const dir = mkdtempSync(join(tmpdir(), "pit-read-delta-"));

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
	const c = res.content[0];
	return c?.type === "text" ? (c.text ?? "") : "";
}

// A body large enough to clear READ_DELTA_MIN_BYTES (1500) so delta framing applies.
function bigBody(values: number[]): string {
	return `${values.map((v, i) => `export const field${i} = ${v};`).join("\n")}\n`;
}

describe("read delta re-send", () => {
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("re-reading a changed large file sends only the diff", async () => {
		const store = new ReadDedupeStore();
		const tool = createReadTool(dir, { embedHashlineAnchors: false, readDedupeStore: store });
		const vals = Array.from({ length: 100 }, (_, i) => i);
		writeFileSync(join(dir, "big.ts"), bigBody(vals));

		const first = textOf(await tool.execute("t1", { path: "big.ts" }));
		expect(first).toContain("field0");
		expect(first).toContain("field99");

		// Flip one line in the middle, then re-read the same range.
		vals[50] = 9999;
		writeFileSync(join(dir, "big.ts"), bigBody(vals));
		const second = textOf(await tool.execute("t2", { path: "big.ts" }));

		expect(second).toContain("showing only the diff");
		expect(second).toContain("9999"); // the changed value survives in the diff
		expect(second).not.toContain("field99"); // unchanged tail is elided
		expect(second.length).toBeLessThan(first.length); // delta beats re-sending in full
	});

	it("re-reading an identical file suppresses the body", async () => {
		const store = new ReadDedupeStore();
		const tool = createReadTool(dir, { embedHashlineAnchors: false, readDedupeStore: store });
		writeFileSync(join(dir, "same.ts"), bigBody(Array.from({ length: 100 }, (_, i) => i)));
		await tool.execute("t1", { path: "same.ts" });
		const second = textOf(await tool.execute("t2", { path: "same.ts" }));
		expect(second).toContain("identical to an earlier read");
	});

	it("a small changed file is re-sent in full (delta framing not worth it)", async () => {
		const store = new ReadDedupeStore();
		const tool = createReadTool(dir, { embedHashlineAnchors: false, readDedupeStore: store });
		writeFileSync(join(dir, "small.ts"), "export const a = 1;\n");
		await tool.execute("t1", { path: "small.ts" });
		writeFileSync(join(dir, "small.ts"), "export const a = 2;\n");
		const second = textOf(await tool.execute("t2", { path: "small.ts" }));
		expect(second).not.toContain("showing only the diff");
		expect(second).toContain("export const a = 2;");
	});

	it("a re-read of a partial (limit) body never emits a delta, footer and all", async () => {
		const store = new ReadDedupeStore();
		const tool = createReadTool(dir, { embedHashlineAnchors: false, readDedupeStore: store });
		// 200 lines, read with limit 100 → leaves a "100 more lines" footer (unclean body).
		const vals = Array.from({ length: 200 }, (_, i) => i);
		writeFileSync(join(dir, "partial.ts"), bigBody(vals));
		const first = textOf(await tool.execute("t1", { path: "partial.ts", limit: 100 }));
		expect(first).toContain("more lines in file");

		// Edit a line inside the window, re-read the same range.
		vals[10] = 9999;
		writeFileSync(join(dir, "partial.ts"), bigBody(vals));
		const second = textOf(await tool.execute("t2", { path: "partial.ts", limit: 100 }));
		// No delta: the unclean (footered) body is never diffed; full body re-sent.
		expect(second).not.toContain("showing only the diff");
		expect(second).toContain("more lines in file");
		expect(second).toContain("9999");
	});

	it("ReadDedupeStore.peek returns the prior clean body until evicted by the LRU window", () => {
		const store = new ReadDedupeStore(2);
		expect(store.peek("k1")).toBeUndefined();
		store.record("k1", "h1", "body1", true);
		expect(store.peek("k1")).toEqual({ hash: "h1", content: "body1", clean: true });
		store.record("k2", "h2", "body2", true);
		store.record("k3", "h3", "body3", true); // evicts k1 (max=2)
		expect(store.peek("k1")).toBeUndefined();
		expect(store.peek("k3")).toEqual({ hash: "h3", content: "body3", clean: true });
	});

	it("ReadDedupeStore drops the body of an unclean read but still dedups by hash", () => {
		const store = new ReadDedupeStore();
		expect(store.record("k", "h1", "footered-body", false)).toBe(false);
		expect(store.peek("k")).toEqual({ hash: "h1", content: "", clean: false }); // body not retained
		expect(store.record("k", "h1", "footered-body", false)).toBe(true); // still dedups on hash
	});

	it("ReadDedupeStore.record reports a duplicate only on identical hash", () => {
		const store = new ReadDedupeStore();
		expect(store.record("k", "h1", "a", true)).toBe(false); // first sighting
		expect(store.record("k", "h1", "a", true)).toBe(true); // same hash → duplicate
		expect(store.record("k", "h2", "b", true)).toBe(false); // changed hash → not a duplicate
	});
});
