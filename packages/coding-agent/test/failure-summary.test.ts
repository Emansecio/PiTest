import { describe, expect, it } from "vitest";
import { summarizeCheckFailure } from "../src/core/verification/failure-summary.js";

describe("summarizeCheckFailure", () => {
	it("extracts tsc errors and drops PASS noise", () => {
		const out = [
			"✓ src/a.test.ts (12)",
			"✓ src/b.test.ts (8)",
			"src/foo.ts(42,5): error TS2322: Type 'string' is not assignable to type 'number'.",
			"✓ src/c.test.ts (3)",
		].join("\n");
		const s = summarizeCheckFailure(out, "npm run check");
		expect(s).toContain("error TS2322");
		expect(s).not.toContain("src/a.test.ts");
	});

	it("extracts vitest failure headers", () => {
		const out = "● suite > does the thing\n  AssertionError: expected 1 to be 2\n PASS ok";
		const s = summarizeCheckFailure(out, "vitest");
		expect(s).toContain("does the thing");
	});

	it("falls back to the tail when no pattern matches", () => {
		const out = "x".repeat(5000);
		const s = summarizeCheckFailure(out, "make");
		expect(s.startsWith("…")).toBe(true);
		expect(s.length).toBeLessThan(4100);
	});

	it("returns short raw output unchanged when nothing matches", () => {
		expect(summarizeCheckFailure("weird blob", "make")).toBe("weird blob");
	});
});
