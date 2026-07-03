import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fsPromises from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditHashlineToolDefinition } from "../src/core/tools/edit-hashline.ts";
import { computeAnchorIndex } from "../src/core/tools/edit-hashline-diff.ts";
import { FileMtimeStore } from "../src/core/tools/file-mtime-store.ts";

// edit-hashline.ts imports its post-write `stat` from "fs/promises" (no
// "node:" prefix) — mock that exact specifier so the integrity-check test
// below intercepts the same binding. Everything else delegates to the real
// implementation; only the one test that needs it overrides `stat` per-call.
vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
	return { ...actual, stat: vi.fn(actual.stat) };
});

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-edit-v2-mtime-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function hashAtLine(content: string, line: number): string {
	const index = computeAnchorIndex(content);
	const entry = [...index.entries()].find(([, lines]) => lines.includes(line));
	if (!entry) throw new Error(`no anchor window starts at line ${line}`);
	return entry[0];
}

/**
 * Regression for #16: edit_v2 must refresh the shared FileMtimeStore after its
 * own write, exactly like edit/write do. Otherwise the store keeps the stale
 * pre-write mtime and the next edit of the same path emits a false
 * "changed on disk since you last read it" warning.
 */
describe("edit_v2 refreshes the shared FileMtimeStore after writing", () => {
	it("records the post-write mtime so the store is no longer stale", async () => {
		const file = join(dir, "f.ts");
		const content = Array.from({ length: 10 }, (_, i) => `line_${i}`).join("\n");
		writeFileSync(file, `${content}\n`, "utf8");

		const store = new FileMtimeStore();
		// Simulate a recorded read mtime that is deliberately stale/arbitrary.
		store.set(file, 1000);

		const before = hashAtLine(content, 0);
		const after = hashAtLine(content, 5);
		const def = createEditHashlineToolDefinition(dir, { mtimeStore: store });
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute(
			"c",
			{ path: file, edits: [{ before_hash: before, after_hash: after, new_text: "INSERTED" }] },
			undefined,
			undefined,
			ctx,
		)) as { content: Array<{ type: string; text?: string }> };

		expect(result.content[0]?.text).toMatch(/Successfully applied/);
		// After edit_v2's own write, the store must hold the file's real mtime.
		expect(store.get(file)).toBe(statSync(file).mtimeMs);
	});
});

type TextResult = { content: Array<{ type: string; text?: string }> };

/**
 * Regression for finding 4.3 in REVISAO-TOOLS-PIT.md: edit_v2 mirrored edit's
 * write path but dropped both of its safety notes. This covers the stale-read
 * note (mtimeStore-based) ported into edit_v2's direct-write path.
 */
describe("edit_v2 stale-read note", () => {
	it("flags a NOTE when the file changed on disk since the recorded mtime", async () => {
		const file = join(dir, "stale.ts");
		const content = Array.from({ length: 10 }, (_, i) => `line_${i}`).join("\n");
		writeFileSync(file, `${content}\n`, "utf8");

		const store = new FileMtimeStore();
		store.set(file, 1000); // deliberately stale baseline

		const before = hashAtLine(content, 0);
		const after = hashAtLine(content, 5);
		const def = createEditHashlineToolDefinition(dir, { mtimeStore: store });
		const ctx = {} as ExtensionContext;
		const result = (await def.execute(
			"c",
			{ path: file, edits: [{ before_hash: before, after_hash: after, new_text: "INSERTED" }] },
			undefined,
			undefined,
			ctx,
		)) as TextResult;

		expect(result.content[0]?.text).toMatch(/changed on disk since you last read it/);
	});

	it("does not flag a NOTE when the recorded mtime matches the file's current mtime", async () => {
		const file = join(dir, "fresh.ts");
		const content = Array.from({ length: 10 }, (_, i) => `line_${i}`).join("\n");
		writeFileSync(file, `${content}\n`, "utf8");

		const store = new FileMtimeStore();
		store.set(file, statSync(file).mtimeMs);

		const before = hashAtLine(content, 0);
		const after = hashAtLine(content, 5);
		const def = createEditHashlineToolDefinition(dir, { mtimeStore: store });
		const ctx = {} as ExtensionContext;
		const result = (await def.execute(
			"c",
			{ path: file, edits: [{ before_hash: before, after_hash: after, new_text: "INSERTED" }] },
			undefined,
			undefined,
			ctx,
		)) as TextResult;

		expect(result.content[0]?.text).not.toMatch(/changed on disk/);
	});
});

/**
 * Regression for finding 4.3: edit_v2 also dropped edit's post-write byte-count
 * integrity check. `defaultEditOperations` is required for this check to run,
 * so a real disk write is exercised and only the diagnostic `fs/promises.stat`
 * call is intercepted to simulate a silent partial write.
 */
describe("edit_v2 post-write integrity check", () => {
	it("warns when the on-disk byte count doesn't match what was written", async () => {
		const file = join(dir, "partial.ts");
		const content = Array.from({ length: 10 }, (_, i) => `line_${i}`).join("\n");
		writeFileSync(file, `${content}\n`, "utf8");

		const before = hashAtLine(content, 0);
		const after = hashAtLine(content, 5);
		const def = createEditHashlineToolDefinition(dir, {});
		const ctx = {} as ExtensionContext;

		const actualStat = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).stat;
		const statMock = vi.mocked(fsPromises.stat);
		statMock.mockImplementationOnce(async (...args: Parameters<typeof actualStat>) => {
			const st = await actualStat(...args);
			return Object.assign(Object.create(Object.getPrototypeOf(st) as object), st, {
				// `st.size` is typed `number | bigint` (the actualStat overload set
				// includes the bigint-stats variant); coerce before arithmetic.
				size: Number(st.size) + 999,
			}) as typeof st;
		});
		try {
			const result = (await def.execute(
				"c",
				{ path: file, edits: [{ before_hash: before, after_hash: after, new_text: "INSERTED" }] },
				undefined,
				undefined,
				ctx,
			)) as TextResult;

			expect(result.content[0]?.text).toMatch(/WARNING: post-write size mismatch/);
		} finally {
			statMock.mockRestore();
		}
	});
});
