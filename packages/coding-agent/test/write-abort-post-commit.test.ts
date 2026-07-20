/**
 * Regression: `write` removed its abort listener AFTER awaiting
 * `refreshFileMtime`, so an ESC arriving during that post-commit mtime stat
 * could reject a write that had already landed on disk (rejecting with
 * "Operation aborted" even though the file was written and there is no way
 * for the caller to tell). The fix mirrors `edit.ts`'s "point of no return"
 * discipline: remove the listener immediately after `ops.writeFile` resolves,
 * before any further await.
 *
 * This test fires abort from inside `FileMtimeStore.set`, which
 * `refreshFileMtime` calls only after `ops.writeFile` has already committed —
 * reproducing the exact post-commit window deterministically, without racing
 * real timers against real disk I/O.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { FileMtimeStore } from "../src/core/tools/file-mtime-store.js";
import { createWriteToolDefinition } from "../src/core/tools/write.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-write-abort-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/**
 * Fires a callback the instant `refreshFileMtime` records the post-write
 * mtime — i.e. strictly after `ops.writeFile` has already resolved and the
 * write has committed to disk.
 */
class AbortOnSetMtimeStore extends FileMtimeStore {
	private readonly onSet: () => void;
	constructor(onSet: () => void) {
		super();
		this.onSet = onSet;
	}
	override set(absolutePath: string, mtimeMs: number): void {
		this.onSet();
		super.set(absolutePath, mtimeMs);
	}
}

type TextResult = { content: Array<{ type: string; text?: string }> };

describe("write: abort during the post-commit mtime refresh is not honored", () => {
	it("resolves successfully (not 'Operation aborted') when ESC arrives after the write already landed", async () => {
		const file = join(dir, "out.txt");
		const controller = new AbortController();
		const store = new AbortOnSetMtimeStore(() => controller.abort());
		const def = createWriteToolDefinition(dir, { mtimeStore: store });
		const ctx = {} as ExtensionContext;

		const result = (await def.execute(
			"c",
			{ path: file, content: "hello\n", preview: undefined },
			controller.signal,
			undefined,
			ctx,
		)) as TextResult;

		expect(result.content[0]?.text).toMatch(/Successfully wrote/);
		expect(result.content[0]?.text).not.toMatch(/aborted/i);
		expect(readFileSync(file, "utf8")).toBe("hello\n");
	});

	it("still rejects when abort fires before the write starts (baseline unchanged)", async () => {
		const file = join(dir, "pre-abort.txt");
		const controller = new AbortController();
		controller.abort();
		const def = createWriteToolDefinition(dir, { mtimeStore: new FileMtimeStore() });
		const ctx = {} as ExtensionContext;

		await expect(
			def.execute("c", { path: file, content: "hello\n", preview: undefined }, controller.signal, undefined, ctx),
		).rejects.toThrow(/aborted/i);
	});
});
