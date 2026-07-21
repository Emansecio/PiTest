import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditTool } from "../src/core/tools/edit.js";
import { __resetEditDiffBaseCache, computeEditsDiffWithBaseCache } from "../src/core/tools/edit-diff.js";
import { _resetRealpathCacheForTest, canonicalPathKey } from "../src/core/tools/path-utils.js";

type TextResult = { content: Array<{ type: string; text?: string }> };

const FS_CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-edit-perf-"));
	__resetEditDiffBaseCache();
	_resetRealpathCacheForTest();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	delete process.env.PIT_NO_EDIT_BASE_CACHE;
	delete process.env.PIT_NO_OMISSION_CHECK;
});

function resultText(res: TextResult): string {
	return res.content[0]?.text ?? "";
}

describe("canonicalPathKey realpath cache", () => {
	it("memoizes the realpath syscall and returns a stable, correct key", async () => {
		const file = join(dir, "canon.txt");
		await writeFile(file, "x");
		_resetRealpathCacheForTest();

		const spy = vi.spyOn(realpathSync, "native");
		try {
			const k1 = canonicalPathKey(file);
			const k2 = canonicalPathKey(file);
			// Second call is served from the cache — one syscall for two lookups.
			expect(spy).toHaveBeenCalledTimes(1);
			expect(k2).toBe(k1);

			// Key is identical to the pre-cache behavior: case-folded realpath.
			const real = realpathSync.native(file);
			expect(k1).toBe(FS_CASE_INSENSITIVE ? real.toLowerCase() : real);
		} finally {
			spy.mockRestore();
			_resetRealpathCacheForTest();
		}
	});
});

describe("edit execute() base-content cache", () => {
	it("always applies against current disk bytes even when preview cache mtime matches", async () => {
		const file = join(dir, "hit.txt");
		await writeFile(file, "alpha ONE\n");
		// Pin a fixed past mtime so the cache key is reproducible after a rewrite.
		const past = new Date(Date.now() - 60_000);
		await utimes(file, past, past);

		// Streaming-preview read warms the base cache with the CURRENT bytes.
		await computeEditsDiffWithBaseCache(file, [{ oldText: "ONE", newText: "TWO" }], dir);

		// Bytes change on disk but the mtime is restored to the cached one. Execute
		// must ignore the timestamp-only cache as a write base and preserve the
		// external bytes around the requested replacement.
		await writeFile(file, "bravo ONE\n");
		await utimes(file, past, past);

		const editTool = createEditTool(dir);
		const res = (await editTool.execute("c1", {
			path: file,
			edits: [{ oldText: "ONE", newText: "TWO" }],
		})) as TextResult;

		expect(resultText(res)).toContain("Successfully replaced");
		expect(await readFile(file, "utf8")).toBe("bravo TWO\n");
	});

	it("re-reads from disk on an mtime mismatch (cache miss)", async () => {
		const file = join(dir, "miss.txt");
		await writeFile(file, "hello\nworld\n");
		const past = new Date(Date.now() - 60_000);
		await utimes(file, past, past);

		await computeEditsDiffWithBaseCache(file, [{ oldText: "world", newText: "WORLD" }], dir);

		// Disk changes AND the mtime advances → cache key no longer matches → the
		// fresh bytes ("planet") must be read.
		await writeFile(file, "hello\nplanet\n");
		const now = new Date();
		await utimes(file, now, now);

		const editTool = createEditTool(dir);
		const res = (await editTool.execute("c2", {
			path: file,
			edits: [{ oldText: "planet", newText: "PLANET" }],
		})) as TextResult;

		expect(resultText(res)).toContain("Successfully replaced");
		expect(await readFile(file, "utf8")).toBe("hello\nPLANET\n");
	});

	it("PIT_NO_EDIT_BASE_CACHE forces a disk read even when a stale entry matches the mtime", async () => {
		const file = join(dir, "killswitch.txt");
		await writeFile(file, "hello\nworld\n");
		const past = new Date(Date.now() - 60_000);
		await utimes(file, past, past);

		await computeEditsDiffWithBaseCache(file, [{ oldText: "world", newText: "WORLD" }], dir);
		await writeFile(file, "hello\nplanet\n");
		await utimes(file, past, past); // same mtime → would be a cache hit if enabled

		process.env.PIT_NO_EDIT_BASE_CACHE = "1";
		const editTool = createEditTool(dir);
		// Disabled → reads disk ("planet"); "world" no longer matches → the edit fails.
		await expect(
			editTool.execute("c3", { path: file, edits: [{ oldText: "world", newText: "WORLD" }] }),
		).rejects.toThrow();
		// And the on-disk bytes are untouched.
		expect(await readFile(file, "utf8")).toBe("hello\nplanet\n");
	});

	it("invalidates/refreshes the cache after a write so a follow-up execute sees new bytes", async () => {
		const file = join(dir, "refresh.txt");
		await writeFile(file, "a\nb\nc\n");

		const editTool = createEditTool(dir);
		// First edit warms + supersedes the cache with post-edit content.
		const first = (await editTool.execute("r1", {
			path: file,
			edits: [{ oldText: "b", newText: "B" }],
		})) as TextResult;
		expect(resultText(first)).toContain("Successfully replaced");
		expect(await readFile(file, "utf8")).toBe("a\nB\nc\n");

		// Second edit must see the post-first bytes ("B"), not a stale cached "b".
		const second = (await editTool.execute("r2", {
			path: file,
			edits: [{ oldText: "B", newText: "BB" }],
		})) as TextResult;
		expect(resultText(second)).toContain("Successfully replaced");
		expect(await readFile(file, "utf8")).toBe("a\nBB\nc\n");
	});
});

describe("edit execute() omission warning (kept inline despite concurrent scan)", () => {
	it("splices the lazy-omission warning into the result by default", async () => {
		const file = join(dir, "omit.txt");
		await writeFile(file, "line1\nline2\nline3\n");

		const editTool = createEditTool(dir);
		const res = (await editTool.execute("o1", {
			path: file,
			edits: [{ oldText: "line2", newText: "// ... rest of the code ..." }],
		})) as TextResult;

		expect(resultText(res)).toContain("Successfully replaced");
		expect(resultText(res)).toMatch(/Possible truncated edit/);
	});

	it("respects PIT_NO_OMISSION_CHECK (no warning when disabled)", async () => {
		const file = join(dir, "omit-off.txt");
		await writeFile(file, "line1\nline2\nline3\n");

		process.env.PIT_NO_OMISSION_CHECK = "1";
		const editTool = createEditTool(dir);
		const res = (await editTool.execute("o2", {
			path: file,
			edits: [{ oldText: "line2", newText: "// ... rest of the code ..." }],
		})) as TextResult;

		expect(resultText(res)).toContain("Successfully replaced");
		expect(resultText(res)).not.toMatch(/Possible truncated edit/);
	});
});
