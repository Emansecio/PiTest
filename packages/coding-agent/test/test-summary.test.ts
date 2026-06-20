import { describe, expect, it } from "vitest";
import { summarizeTestRun } from "../src/core/verification/test-summary.js";

describe("summarizeTestRun", () => {
	it("compiles a vitest totals line", () => {
		const out = [
			" RUN  v1.0.0",
			" ✓ src/a.test.ts (12)",
			"",
			" Test Files  1 passed (1)",
			"      Tests  3 failed | 142 passed | 2 skipped (147)",
			"   Start at  10:00:00",
		].join("\n");
		const s = summarizeTestRun(out);
		expect(s).toEqual({ failed: 3, passed: 142, skipped: 2, headline: "✗ 3 failed · 142 passed · 2 skipped" });
	});

	it("uses a ✓ headline when all vitest tests pass", () => {
		const out = "Test Files  6 passed (6)\n      Tests  147 passed (147)";
		expect(summarizeTestRun(out)?.headline).toBe("✓ 147 passed");
	});

	it("compiles a jest totals line", () => {
		const out = ["Test Suites: 1 failed, 5 passed, 6 total", "Tests:       3 failed, 142 passed, 145 total"].join(
			"\n",
		);
		expect(summarizeTestRun(out)).toEqual({
			failed: 3,
			passed: 142,
			skipped: 0,
			headline: "✗ 3 failed · 142 passed",
		});
	});

	it("compiles mocha passing/failing/pending", () => {
		const out = ["  142 passing (2s)", "  1 pending", "  3 failing"].join("\n");
		expect(summarizeTestRun(out)?.headline).toBe("✗ 3 failed · 142 passed · 1 skipped");
	});

	it("compiles node:test reporter counts", () => {
		const out = ["ℹ tests 145", "ℹ pass 142", "ℹ fail 3", "ℹ skipped 1"].join("\n");
		expect(summarizeTestRun(out)?.headline).toBe("✗ 3 failed · 142 passed · 1 skipped");
	});

	it("strips ANSI before matching", () => {
		const out = "\u001B[1mTests\u001B[0m  \u001B[31m1 failed\u001B[0m | \u001B[32m9 passed\u001B[0m (10)";
		expect(summarizeTestRun(out)?.headline).toBe("✗ 1 failed · 9 passed");
	});

	it("returns undefined for non-test output", () => {
		expect(summarizeTestRun("Compiled successfully in 1.2s")).toBeUndefined();
		expect(summarizeTestRun("")).toBeUndefined();
	});

	it("does not match the 'Test Files' line as a Tests totals line", () => {
		// "Test Files" alone (no "Tests" line) is not a per-test total → undefined.
		expect(summarizeTestRun("Test Files  1 failed | 5 passed (6)")).toBeUndefined();
	});
});
