import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/utils/atomic-write.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-atomic-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
});

describe("writeFileAtomic", () => {
	it("writes the content and leaves no temp file behind", async () => {
		const dir = tmp();
		const file = join(dir, "out.txt");
		await writeFileAtomic(file, "hello");
		expect(readFileSync(file, "utf-8")).toBe("hello");
		// Only the target remains — the sibling .tmp-* was renamed away.
		expect(readdirSync(dir)).toEqual(["out.txt"]);
	});

	it("overwrites an existing file atomically", async () => {
		const dir = tmp();
		const file = join(dir, "out.txt");
		writeFileSync(file, "old");
		await writeFileAtomic(file, "new");
		expect(readFileSync(file, "utf-8")).toBe("new");
		expect(readdirSync(dir)).toEqual(["out.txt"]);
	});

	it("aborts before the rename: original untouched, no temp leaked", async () => {
		const dir = tmp();
		const file = join(dir, "out.txt");
		writeFileSync(file, "original");
		const controller = new AbortController();
		controller.abort();
		await expect(writeFileAtomic(file, "should-not-land", controller.signal)).rejects.toThrow("Operation aborted");
		// The pre-existing file must be intact and no .tmp-* should remain.
		expect(readFileSync(file, "utf-8")).toBe("original");
		expect(readdirSync(dir)).toEqual(["out.txt"]);
	});

	it("concurrent writes to the same path don't collide on the temp name", async () => {
		const dir = tmp();
		const file = join(dir, "out.txt");
		await Promise.all([
			writeFileAtomic(file, "a".repeat(1000)),
			writeFileAtomic(file, "b".repeat(1000)),
			writeFileAtomic(file, "c".repeat(1000)),
		]);
		// One of the writes wins; the file is one of the full contents (never a mix)
		// and no stray temp files survive.
		const content = readFileSync(file, "utf-8");
		expect([..."abc"].some((ch) => content === ch.repeat(1000))).toBe(true);
		expect(readdirSync(dir)).toEqual(["out.txt"]);
	});
});
