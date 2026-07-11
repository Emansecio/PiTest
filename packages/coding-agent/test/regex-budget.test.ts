import { describe, expect, it } from "vitest";
import {
	createRegexTestDeadline,
	isRegexBudgetExpired,
	SAFE_REGEX_MAX_LENGTH,
	searchRegexWithinBudget,
	testRegexWithinBudget,
	validateSafeRegex,
} from "../src/core/regex-budget.ts";

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

	it("searchRegexWithinBudget returns index or null when budget expired", () => {
		const re = /brave/i;
		expect(searchRegexWithinBudget(re, "say brave", Date.now() - 1)).toBeNull();
		const deadline = createRegexTestDeadline();
		expect(searchRegexWithinBudget(re, "xx brave yy", deadline)).toBe(3);
		expect(searchRegexWithinBudget(re, "no match", deadline)).toBe(-1);
	});
});

describe("validateSafeRegex", () => {
	it("accepts ordinary patterns", () => {
		expect(() => validateSafeRegex("foo.*bar")).not.toThrow();
		expect(() => validateSafeRegex("rm\\s+-rf")).not.toThrow();
		expect(() => validateSafeRegex("a{1,3}b")).not.toThrow();
	});

	it("rejects overlong patterns", () => {
		expect(() => validateSafeRegex("a".repeat(SAFE_REGEX_MAX_LENGTH + 1))).toThrow(/too long/i);
	});

	it("rejects nested quantifiers", () => {
		expect(() => validateSafeRegex("(a+)+")).toThrow(/nested/i);
		expect(() => validateSafeRegex("(.*)*")).toThrow(/nested/i);
		expect(() => validateSafeRegex("(?:foo+)*")).toThrow(/nested/i);
	});

	it("rejects consecutive unbounded quantifiers", () => {
		expect(() => validateSafeRegex(".*.*")).toThrow(/consecutive/i);
		expect(() => validateSafeRegex("a+b+")).toThrow(/consecutive/i);
		expect(() => validateSafeRegex("\\w*\\w*")).toThrow(/consecutive/i);
	});
});
