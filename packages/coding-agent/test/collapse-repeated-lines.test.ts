import { describe, expect, it } from "vitest";
import { collapseRepeatedLines } from "../src/core/tools/truncate.js";

describe("collapseRepeatedLines", () => {
	it("collapses a run of >= minRun identical consecutive lines with a count", () => {
		const input = ["start", "warn: x", "warn: x", "warn: x", "warn: x", "end"].join("\n");
		const out = collapseRepeatedLines(input);
		expect(out).toBe(["start", "warn: x … (×4)", "end"].join("\n"));
	});

	it("leaves short runs (< minRun) untouched", () => {
		const input = ["a", "dup", "dup", "b"].join("\n"); // run of 2, default minRun 3
		expect(collapseRepeatedLines(input)).toBe(input);
	});

	it("only merges CONSECUTIVE identical lines (preserves order and non-adjacent repeats)", () => {
		const input = ["x", "x", "x", "y", "x", "x", "x"].join("\n");
		expect(collapseRepeatedLines(input)).toBe(["x … (×3)", "y", "x … (×3)"].join("\n"));
	});

	it("collapses a run of blank lines to a single blank line (no count marker)", () => {
		const input = ["a", "", "", "", "", "b"].join("\n");
		expect(collapseRepeatedLines(input)).toBe(["a", "", "b"].join("\n"));
	});

	it("respects a custom minRun", () => {
		const input = ["d", "d"].join("\n");
		expect(collapseRepeatedLines(input, 2)).toBe("d … (×2)");
	});

	it("is a no-op for empty input or minRun < 2", () => {
		expect(collapseRepeatedLines("")).toBe("");
		expect(collapseRepeatedLines("a\na\na", 1)).toBe("a\na\na");
	});

	it("shrinks a large repetitive output substantially", () => {
		const input = `${Array(1000).fill("PASS test_case").join("\n")}\nDONE`;
		const out = collapseRepeatedLines(input);
		expect(out).toBe("PASS test_case … (×1000)\nDONE");
		expect(out.length).toBeLessThan(input.length / 100);
	});

	it("does not merge lines that differ only at the end", () => {
		// "line " has only 5 literal chars after masking (< FUZZY_MIN_LITERAL_CHARS),
		// so the number-only difference does NOT trigger a fuzzy collapse.
		const input = ["line 1", "line 2", "line 3"].join("\n");
		expect(collapseRepeatedLines(input)).toBe(input);
	});
});

describe("collapseRepeatedLines fuzzy masking (N2)", () => {
	it("collapses lines that differ only in counters/timestamps, keeping the first verbatim", () => {
		const input = [
			"start",
			"[12:00:01] processed batch 1 of 900 (0%)",
			"[12:00:02] processed batch 2 of 900 (1%)",
			"[12:00:03] processed batch 3 of 900 (2%)",
			"[12:00:04] processed batch 4 of 900 (3%)",
			"done",
		].join("\n");
		const out = collapseRepeatedLines(input);
		expect(out).toBe(["start", "[12:00:01] processed batch 1 of 900 (0%) … (×4 similar)", "done"].join("\n"));
	});

	it("uses the exact (×N) marker when the collapsed lines were byte-identical", () => {
		const input = ["compiling…", "compiling…", "compiling…"].join("\n");
		// No digits → masking is a no-op; identical lines keep the exact marker.
		expect(collapseRepeatedLines(input)).toBe("compiling… … (×3)");
	});

	it("collapses long hex/uuid-only differences (hashes)", () => {
		const input = [
			"resolved dependency at a1b2c3d4e5f6a7b8",
			"resolved dependency at 00ff00ff00ff00ff",
			"resolved dependency at deadbeefdeadbeef",
		].join("\n");
		expect(collapseRepeatedLines(input)).toBe("resolved dependency at a1b2c3d4e5f6a7b8 … (×3 similar)");
	});

	it("does NOT fuzzy-collapse number-dominated lines with too little literal content (opt-out)", () => {
		// Each masks to "#|#" — only 1 literal char, below FUZZY_MIN_LITERAL_CHARS.
		const input = ["100|200", "300|400", "500|600"].join("\n");
		expect(collapseRepeatedLines(input)).toBe(input);
	});

	it("is byte-identical for text with no exact or fuzzy repetition", () => {
		const input = ["alpha started", "beta finished", "gamma pending", "delta queued"].join("\n");
		expect(collapseRepeatedLines(input)).toBe(input);
	});

	it("does not fuzzy-merge short hex words (< 8 chars stay literal)", () => {
		// "cafe"/"babe" are hex-looking but under the 8-char hex-token threshold, so
		// they are compared literally and remain distinct.
		const input = ["load cafe module here", "load babe module here", "load feed module here"].join("\n");
		expect(collapseRepeatedLines(input)).toBe(input);
	});

	it("collapses a CI-runner wall (thousands → one line)", () => {
		const rows: string[] = [];
		for (let i = 0; i < 2000; i++) rows.push(`PASS suite/test_${i} (${i * 2}ms)`);
		const out = collapseRepeatedLines(rows.join("\n"));
		expect(out).toBe("PASS suite/test_0 (0ms) … (×2000 similar)");
	});
});
