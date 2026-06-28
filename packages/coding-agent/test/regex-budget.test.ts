import { describe, expect, it } from "vitest";
import { createRegexTestDeadline, isRegexBudgetExpired, testRegexWithinBudget } from "../src/core/regex-budget.ts";

describe("regex-budget", () => {
	it("returns null when deadline already passed", () => {
		const re = /foo/;
		expect(testRegexWithinBudget(re, "foo bar", Date.now() - 1)).toBeNull();
	});

	it("matches within budget", () => {
		const deadline = createRegexTestDeadline();
		const re = /hello/;
		expect(testRegexWithinBudget(re, "say hello", deadline)).toBe(true);
		expect(isRegexBudgetExpired(deadline)).toBe(false);
	});
});
