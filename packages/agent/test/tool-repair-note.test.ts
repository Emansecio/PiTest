import { describe, expect, it } from "vitest";
import { appendRepairNoteToContent, buildRepairNote, summarizeArgRepairs } from "../src/tool-repair-note.js";

describe("summarizeArgRepairs", () => {
	it("reports a renamed key when the value reappears under a new key", () => {
		expect(summarizeArgRepairs({ file_path: "a.ts" }, { path: "a.ts" })).toEqual(["renamed `file_path` → `path`"]);
	});

	it("reports a type coercion on a key present on both sides", () => {
		expect(summarizeArgRepairs({ offset: "10" }, { offset: 10 })).toEqual(["coerced `offset` (string → number)"]);
	});

	it("reports an array-from-string coercion", () => {
		expect(summarizeArgRepairs({ edits: '[{"a":1}]' }, { edits: [{ a: 1 }] })).toEqual([
			"coerced `edits` (string → array)",
		]);
	});

	it("reports nothing when args are unchanged", () => {
		expect(summarizeArgRepairs({ path: "a", offset: 1 }, { path: "a", offset: 1 })).toEqual([]);
	});

	it("ignores same-kind value tweaks (e.g. path normalization)", () => {
		expect(summarizeArgRepairs({ path: "C:\\x" }, { path: "C:/x" })).toEqual([]);
	});

	it("does not pair two distinct renames to the same value ambiguously", () => {
		// Each renamed key consumes one removed key; identical values still pair 1:1.
		const out = summarizeArgRepairs({ a: "x", b: "y" }, { p: "x", q: "y" });
		expect(out).toContain("renamed `a` → `p`");
		expect(out).toContain("renamed `b` → `q`");
		expect(out).toHaveLength(2);
	});

	it("returns [] for non-object input", () => {
		expect(summarizeArgRepairs("nope", { a: 1 })).toEqual([]);
		expect(summarizeArgRepairs({ a: 1 }, null)).toEqual([]);
	});
});

describe("buildRepairNote", () => {
	it("returns undefined when there is nothing to report", () => {
		expect(buildRepairNote({ path: "a" }, { path: "a" })).toBeUndefined();
	});

	it("produces a single-line note listing the repairs", () => {
		const note = buildRepairNote({ file_path: "a", offset: "3" }, { path: "a", offset: 3 });
		expect(note).toContain("renamed `file_path` → `path`");
		expect(note).toContain("coerced `offset` (string → number)");
		expect(note).toContain("emit the corrected shape");
	});
});

describe("appendRepairNoteToContent", () => {
	it("appends a [repair] line to the trailing text block", () => {
		const content = [{ type: "text" as const, text: "ok" }];
		const out = appendRepairNoteToContent(content, "fix it") as Array<{ type: string; text: string }>;
		expect(out[0].text).toBe("ok\n\n[repair] fix it");
	});

	it("is idempotent — a repeated identical note is not appended twice", () => {
		const first = appendRepairNoteToContent([{ type: "text" as const, text: "ok" }], "fix it");
		const second = appendRepairNoteToContent(first, "fix it") as Array<{ type: string; text: string }>;
		expect(second).toStrictEqual(first);
		expect(second[0].text.match(/\[repair\]/g)).toHaveLength(1);
	});

	it("pushes a fresh text block when there is no text block to append to", () => {
		const content = [{ type: "image" as const, data: "..." }] as never;
		const out = appendRepairNoteToContent(content, "fix it") as Array<{ type: string; text?: string }>;
		expect(out[out.length - 1]).toEqual({ type: "text", text: "[repair] fix it" });
	});
});
