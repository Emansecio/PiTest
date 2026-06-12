import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	__getEditDiffBaseCacheDiskReads,
	__resetEditDiffBaseCache,
	computeEditsDiff,
	computeEditsDiffWithBaseCache,
	type Edit,
} from "../src/core/tools/edit-diff.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-edit-base-cache-"));
	__resetEditDiffBaseCache();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function diffOf(result: Awaited<ReturnType<typeof computeEditsDiff>>): string {
	if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
	return result.diff;
}

describe("computeEditsDiffWithBaseCache", () => {
	it("reuses the cached base across consecutive computes for an unchanged file (second compute does not re-read)", async () => {
		const file = join(dir, "stable.ts");
		const lines: string[] = [];
		for (let i = 0; i < 2000; i++) lines.push(`const v${i} = ${i};`);
		await writeFile(file, `${lines.join("\n")}\n`);

		const edits: Edit[] = [{ oldText: "const v1000 = 1000;", newText: "const v1000 = 4242;" }];

		const first = await computeEditsDiffWithBaseCache(file, edits, dir);
		const readsAfterFirst = __getEditDiffBaseCacheDiskReads();
		expect(readsAfterFirst).toBe(1);

		const second = await computeEditsDiffWithBaseCache(file, edits, dir);
		// No additional disk read on the cache hit.
		expect(__getEditDiffBaseCacheDiskReads()).toBe(readsAfterFirst);

		// Byte-identical diff between calls...
		expect(diffOf(second)).toBe(diffOf(first));
		// ...and identical to the non-cached reference implementation.
		const reference = await computeEditsDiff(file, edits, dir);
		expect(diffOf(first)).toBe(diffOf(reference));
	});

	it("caches across DIFFERENT edits of the same unchanged file (streaming deltas)", async () => {
		const file = join(dir, "stream.ts");
		await writeFile(file, "alpha\nbeta\ngamma\ndelta\n");

		// Simulate growing newText deltas during streaming — each is a distinct edit
		// but the base file never changes, so only the first should read disk.
		await computeEditsDiffWithBaseCache(file, [{ oldText: "beta", newText: "b" }], dir);
		await computeEditsDiffWithBaseCache(file, [{ oldText: "beta", newText: "be" }], dir);
		await computeEditsDiffWithBaseCache(file, [{ oldText: "beta", newText: "beta!" }], dir);

		expect(__getEditDiffBaseCacheDiskReads()).toBe(1);
	});

	it("re-reads when the file mtime changes between computes (diff reflects new content)", async () => {
		const file = join(dir, "mutated.ts");
		await writeFile(file, "one\ntwo\nthree\n");
		// Pin an old mtime so the post-edit write is guaranteed to differ.
		const past = new Date(Date.now() - 60_000);
		await utimes(file, past, past);

		const edits: Edit[] = [{ oldText: "two", newText: "TWO" }];
		const before = await computeEditsDiffWithBaseCache(file, edits, dir);
		expect(diffOf(before)).toContain("two");
		expect(diffOf(before)).toContain("TWO");
		expect(__getEditDiffBaseCacheDiskReads()).toBe(1);

		// External modification mid-stream: same line "two" no longer exists; the
		// stale cached base would still match it, so a re-read is mandatory.
		await writeFile(file, "one\nSECOND\nthree\n");
		const now = new Date();
		await utimes(file, now, now);

		const after = await computeEditsDiffWithBaseCache(file, [{ oldText: "SECOND", newText: "2ND" }], dir);
		// New content was read (mtime changed → cache miss).
		expect(__getEditDiffBaseCacheDiskReads()).toBe(2);
		expect(diffOf(after)).toContain("SECOND");
		expect(diffOf(after)).toContain("2ND");

		// And it matches the non-cached reference on the new content.
		const reference = await computeEditsDiff(file, [{ oldText: "SECOND", newText: "2ND" }], dir);
		expect(diffOf(after)).toBe(diffOf(reference));
	});

	it("evicts to a 2-entry LRU without retaining more bases", async () => {
		const fileA = join(dir, "a.ts");
		const fileB = join(dir, "b.ts");
		const fileC = join(dir, "c.ts");
		await writeFile(fileA, "a1\na2\n");
		await writeFile(fileB, "b1\nb2\n");
		await writeFile(fileC, "c1\nc2\n");

		await computeEditsDiffWithBaseCache(fileA, [{ oldText: "a1", newText: "A1" }], dir); // read 1
		await computeEditsDiffWithBaseCache(fileB, [{ oldText: "b1", newText: "B1" }], dir); // read 2
		await computeEditsDiffWithBaseCache(fileC, [{ oldText: "c1", newText: "C1" }], dir); // read 3, evicts A
		expect(__getEditDiffBaseCacheDiskReads()).toBe(3);

		// A was evicted (LRU cap = 2) → re-read.
		await computeEditsDiffWithBaseCache(fileA, [{ oldText: "a2", newText: "A2" }], dir);
		expect(__getEditDiffBaseCacheDiskReads()).toBe(4);

		// C is still warm → no read.
		await computeEditsDiffWithBaseCache(fileC, [{ oldText: "c2", newText: "C2" }], dir);
		expect(__getEditDiffBaseCacheDiskReads()).toBe(4);
	});
});
