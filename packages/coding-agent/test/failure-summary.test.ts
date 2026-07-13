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

	it("clamps long unmatched output head+tail with a dominant, marked tail", () => {
		const out = `HEAD-MARKER${"x".repeat(5000)}TAIL-MARKER`;
		const s = summarizeCheckFailure(out, "make");
		// Both ends survive: a small head sample plus the (dominant) tail where a
		// runner would print its failure summary.
		expect(s).toContain("HEAD-MARKER");
		expect(s).toContain("TAIL-MARKER");
		// The dropped middle is called out explicitly rather than silently cut.
		expect(s).toMatch(/\[\.\.\. \d+ chars truncated \.\.\.\]/);
		// Total retained stays within the char budget (+ marker/newlines slack).
		expect(s.length).toBeLessThan(4200);
	});

	it("keeps a dominant tail of failure lines when there are more than the budget", () => {
		const lines: string[] = [];
		for (let i = 0; i < 40; i++) lines.push(`src/f${i}.ts(${i + 1},1): error TS2322: bad ${i}`);
		const s = summarizeCheckFailure(lines.join("\n"), "npm run check");
		// The LAST failures (tail) are retained...
		expect(s).toContain("bad 39");
		expect(s).toContain("bad 38");
		// ...a small head sample is kept...
		expect(s).toContain("bad 0");
		// ...and the elided middle is counted, not silently dropped.
		expect(s).toMatch(/\+\d+ more failing lines omitted/);
	});

	it("returns short raw output unchanged when nothing matches", () => {
		expect(summarizeCheckFailure("weird blob", "make")).toBe("weird blob");
	});
});
