import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.js";
import { FileMtimeStore } from "../src/core/tools/file-mtime-store.js";
import { createReadToolDefinition } from "../src/core/tools/read.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-stale-read-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

type TextResult = { content: Array<{ type: string; text?: string }> };

async function runEdit(store: FileMtimeStore, file: string, oldText: string, newText: string): Promise<TextResult> {
	const def = createEditToolDefinition(dir, { mtimeStore: store });
	const ctx = {} as Parameters<typeof def.execute>[4];
	return (await def.execute(
		"c",
		{ path: file, edits: [{ oldText, newText }] },
		undefined,
		undefined,
		ctx,
	)) as TextResult;
}

describe("FileMtimeStore", () => {
	it("get returns what was set, undefined otherwise", () => {
		const s = new FileMtimeStore();
		s.set("/a", 123);
		expect(s.get("/a")).toBe(123);
		expect(s.get("/b")).toBeUndefined();
	});

	it("evicts the oldest entry past the LRU window", () => {
		const s = new FileMtimeStore(2);
		s.set("/a", 1);
		s.set("/b", 2);
		s.set("/c", 3);
		expect(s.get("/a")).toBeUndefined();
		expect(s.get("/b")).toBe(2);
		expect(s.get("/c")).toBe(3);
	});

	it("re-setting a key refreshes recency so it survives eviction", () => {
		const s = new FileMtimeStore(2);
		s.set("/a", 1);
		s.set("/b", 2);
		s.set("/a", 10); // refresh /a
		s.set("/c", 3); // evicts the now-oldest (/b)
		expect(s.get("/a")).toBe(10);
		expect(s.get("/b")).toBeUndefined();
		expect(s.get("/c")).toBe(3);
	});
});

describe("read records the file mtime into the shared store", () => {
	it("the recorded value equals the file's mtime after a read", async () => {
		const file = join(dir, "f.ts");
		writeFileSync(file, "alpha\nbeta\n", "utf8");
		const store = new FileMtimeStore();
		const def = createReadToolDefinition(dir, { mtimeStore: store });
		const ctx = {} as Parameters<typeof def.execute>[4];
		await def.execute("c", { path: file }, undefined, undefined, ctx);
		expect(store.get(file)).toBe(statSync(file).mtimeMs);
	});
});

describe("edit stale-read warning", () => {
	it("warns when the file changed on disk since the recorded read", async () => {
		const file = join(dir, "f.ts");
		writeFileSync(file, "const x = 1;\nconst y = 2;\n", "utf8");
		const store = new FileMtimeStore();
		// Simulate a read taken when the on-disk mtime was far in the past.
		store.set(file, 1000);
		const result = await runEdit(store, file, "const x = 1;", "const x = 42;");
		expect(result.content[0]?.text).toMatch(/Successfully replaced/);
		expect(result.content[0]?.text).toMatch(/changed on disk since you last read it/);
		expect(readFileSync(file, "utf8")).toBe("const x = 42;\nconst y = 2;\n");
	});

	it("does not warn when the recorded mtime matches the current file", async () => {
		const file = join(dir, "f.ts");
		writeFileSync(file, "const x = 1;\n", "utf8");
		const store = new FileMtimeStore();
		store.set(file, statSync(file).mtimeMs);
		const result = await runEdit(store, file, "const x = 1;", "const x = 9;");
		expect(result.content[0]?.text).toMatch(/Successfully replaced/);
		expect(result.content[0]?.text).not.toMatch(/changed on disk/);
	});

	it("does not warn when no prior read was recorded for the path", async () => {
		const file = join(dir, "f.ts");
		writeFileSync(file, "const x = 1;\n", "utf8");
		const store = new FileMtimeStore();
		const result = await runEdit(store, file, "const x = 1;", "const x = 7;");
		expect(result.content[0]?.text).not.toMatch(/changed on disk/);
	});

	it("refreshes the store after its own write so a follow-up edit does not warn", async () => {
		const file = join(dir, "f.ts");
		writeFileSync(file, "a = 1;\nb = 2;\n", "utf8");
		const store = new FileMtimeStore();
		store.set(file, 1000); // stale baseline
		const r1 = await runEdit(store, file, "a = 1;", "a = 11;");
		expect(r1.content[0]?.text).toMatch(/changed on disk/);
		// The first edit refreshed the store to its own post-write mtime, so the
		// second edit of the same path must not be flagged as a stale external change.
		const r2 = await runEdit(store, file, "b = 2;", "b = 22;");
		expect(r2.content[0]?.text).not.toMatch(/changed on disk/);
	});
});
