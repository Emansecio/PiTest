import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditHashlineToolDefinition } from "../src/core/tools/edit-hashline.ts";
import { computeAnchorIndex } from "../src/core/tools/edit-hashline-diff.ts";
import { FileMtimeStore } from "../src/core/tools/file-mtime-store.ts";

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
