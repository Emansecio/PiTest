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
		const input = ["line 1", "line 2", "line 3"].join("\n");
		expect(collapseRepeatedLines(input)).toBe(input);
	});
});
