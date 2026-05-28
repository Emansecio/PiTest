import { describe, expect, test } from "vitest";
import { createPreviewQueue, type PreviewQueue } from "../src/core/preview-queue.js";

function makeQueue(): PreviewQueue {
	return createPreviewQueue();
}

describe("PreviewQueue", () => {
	test("add returns an item with an id and list includes it", () => {
		const q = makeQueue();
		const item = q.add({
			kind: "edit",
			path: "/tmp/foo.ts",
			apply: async () => {},
			summary: { description: "test" },
		});
		expect(item.id).toMatch(/^[0-9a-f]+$/);
		expect(q.count()).toBe(1);
		expect(q.list().map((i) => i.id)).toContain(item.id);
		expect(q.get(item.id)?.path).toBe("/tmp/foo.ts");
	});

	test("accept runs apply and removes the item", async () => {
		const q = makeQueue();
		let applied = false;
		const item = q.add({
			kind: "write",
			path: "/tmp/bar.ts",
			apply: async () => {
				applied = true;
			},
			summary: { description: "write file" },
		});
		const result = await q.accept(item.id);
		expect(result.ok).toBe(true);
		expect(applied).toBe(true);
		expect(q.count()).toBe(0);
		expect(q.get(item.id)).toBeUndefined();
	});

	test("accept returns { ok: false, error } when apply throws AND keeps the item", async () => {
		const q = makeQueue();
		const item = q.add({
			kind: "edit",
			path: "/tmp/fail.ts",
			apply: async () => {
				throw new Error("boom");
			},
			summary: { description: "fails" },
		});
		const result = await q.accept(item.id);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("boom");
		}
		expect(q.count()).toBe(1);
		expect(q.get(item.id)).toBeDefined();
	});

	test("accept with unknown id returns ok:false", async () => {
		const q = makeQueue();
		const result = await q.accept("does-not-exist");
		expect(result.ok).toBe(false);
	});

	test("discard removes the item without applying", async () => {
		const q = makeQueue();
		let applied = false;
		let discardCalled = false;
		const item = q.add({
			kind: "edit",
			path: "/tmp/d.ts",
			apply: async () => {
				applied = true;
			},
			discard: async () => {
				discardCalled = true;
			},
			summary: { description: "discard me" },
		});
		const ok = await q.discard(item.id);
		expect(ok).toBe(true);
		expect(applied).toBe(false);
		expect(discardCalled).toBe(true);
		expect(q.count()).toBe(0);
	});

	test("discard unknown id returns false", async () => {
		const q = makeQueue();
		const ok = await q.discard("nope");
		expect(ok).toBe(false);
	});

	test("clear empties everything", () => {
		const q = makeQueue();
		q.add({ kind: "edit", path: "a", apply: async () => {}, summary: { description: "a" } });
		q.add({ kind: "edit", path: "b", apply: async () => {}, summary: { description: "b" } });
		expect(q.count()).toBe(2);
		q.clear();
		expect(q.count()).toBe(0);
		expect(q.list()).toEqual([]);
	});
});
