import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.js";
import { createReadTool, ReadDedupeStore } from "../src/core/tools/read.js";
import { BASH_MAX_BYTES, BASH_MAX_LINES, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../src/core/tools/truncate.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

describe("bash output budget (item 1)", () => {
	test("bash limits are tighter than the default file-read limits", () => {
		expect(BASH_MAX_BYTES).toBeLessThan(DEFAULT_MAX_BYTES);
		expect(BASH_MAX_LINES).toBeLessThan(DEFAULT_MAX_LINES);
	});

	test("OutputAccumulator truncates bash output at the bash byte budget", () => {
		const acc = new OutputAccumulator({ maxLines: BASH_MAX_LINES, maxBytes: BASH_MAX_BYTES });
		acc.append(Buffer.from("x".repeat(BASH_MAX_BYTES * 2)));
		acc.finish();
		const snap = acc.snapshot();
		expect(snap.truncation.truncated).toBe(true);
		expect(snap.truncation.maxBytes).toBe(BASH_MAX_BYTES);
		expect(Buffer.byteLength(snap.content, "utf-8")).toBeLessThanOrEqual(BASH_MAX_BYTES);
	});
});

describe("ReadDedupeStore (item 2)", () => {
	test("flags an identical repeat as duplicate, changed content as not", () => {
		const store = new ReadDedupeStore();
		expect(store.record("a", "h1", "body1")).toBe(false); // first sighting
		expect(store.record("a", "h1", "body1")).toBe(true); // identical repeat
		expect(store.record("a", "h2", "body2")).toBe(false); // content changed → re-sent
		expect(store.record("a", "h2", "body2")).toBe(true); // identical again
	});

	test("evicts least-recently-used keys beyond the window (older reads re-send)", () => {
		const store = new ReadDedupeStore(2);
		expect(store.record("a", "x", "ba")).toBe(false);
		expect(store.record("b", "y", "bb")).toBe(false);
		expect(store.record("c", "z", "bc")).toBe(false); // evicts "a"
		expect(store.record("a", "x", "ba")).toBe(false); // "a" was forgotten → re-sent, not suppressed
	});
});

describe("read tool de-dup (item 2, end-to-end)", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pit-read-dedupe-"));
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("suppresses an identical repeat read and re-sends after the file changes", async () => {
		const file = join(dir, "sample.txt");
		writeFileSync(file, "line one\nline two\nline three\n");
		const tool = createReadTool(dir, {
			readDedupeStore: new ReadDedupeStore(),
			embedHashlineAnchors: false,
		});

		const first = textOf(await tool.execute("1", { path: file }));
		expect(first).toContain("line two");
		expect(first).not.toContain("identical to an earlier read");

		const second = textOf(await tool.execute("2", { path: file }));
		expect(second).toContain("identical to an earlier read this session");
		expect(second).not.toContain("line two");

		writeFileSync(file, "line one\nCHANGED\nline three\n");
		const third = textOf(await tool.execute("3", { path: file }));
		expect(third).toContain("CHANGED");
		expect(third).not.toContain("identical to an earlier read");
	});

	test("no de-dup when no store is provided (default behavior unchanged)", async () => {
		const file = join(dir, "nostore.txt");
		writeFileSync(file, "alpha\nbeta\n");
		const tool = createReadTool(dir, { embedHashlineAnchors: false });
		const a = textOf(await tool.execute("1", { path: file }));
		const b = textOf(await tool.execute("2", { path: file }));
		expect(a).toContain("beta");
		expect(b).toContain("beta");
		expect(b).not.toContain("identical to an earlier read");
	});
});

describe("head+tail bash truncation (improvement 1)", () => {
	function feed(acc: OutputAccumulator, text: string) {
		acc.append(Buffer.from(text, "utf-8"));
		acc.finish();
	}

	const hundredLines = Array.from({ length: 100 }, (_, i) => `linha${String(i + 1).padStart(3, "0")}`).join("\n");

	test("composes head + elided middle + tail when truncated by lines", () => {
		const acc = new OutputAccumulator({ maxLines: 20, maxBytes: 100_000, headLines: 5, headBytes: 2_000 });
		feed(acc, hundredLines);
		const snap = acc.snapshot();

		expect(snap.truncation.truncated).toBe(true);
		expect(snap.composed).toBeDefined();
		expect(snap.content).toContain("linha001"); // head (command/start)
		expect(snap.content).toContain("linha100"); // tail (error/end)
		expect(snap.content).toContain("elided"); // middle marker
		expect(snap.content).not.toContain("linha050"); // middle is gone
		// Head and tail are disjoint — together they cover less than the whole output.
		const { headLines, tailLines } = snap.composed as { headLines: number; tailLines: number };
		expect(headLines + tailLines).toBeLessThan(snap.truncation.totalLines);
	});

	test("tail-only (no composition) when head retention is disabled", () => {
		const acc = new OutputAccumulator({ maxLines: 20, maxBytes: 100_000 });
		feed(acc, hundredLines);
		const snap = acc.snapshot();

		expect(snap.truncation.truncated).toBe(true);
		expect(snap.composed).toBeUndefined();
		expect(snap.content).not.toContain("linha001"); // start dropped (tail-only)
		expect(snap.content).toContain("linha100");
	});

	test("no composition when output fits the budget", () => {
		const acc = new OutputAccumulator({ maxLines: 1000, maxBytes: 100_000, headLines: 5, headBytes: 2_000 });
		feed(acc, "only\na\nfew\nlines");
		const snap = acc.snapshot();

		expect(snap.truncation.truncated).toBe(false);
		expect(snap.composed).toBeUndefined();
		expect(snap.content).toContain("only");
		expect(snap.content).toContain("lines");
	});
});
