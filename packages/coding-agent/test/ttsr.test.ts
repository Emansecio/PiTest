import { describe, expect, test } from "vitest";
import { compileRules, createMatcher, type TTSRRule } from "../src/core/ttsr.js";

describe("compileRules", () => {
	test("throws naming the bad rule when regex is invalid", () => {
		const rules: TTSRRule[] = [{ name: "bad-rule", regex: "(unclosed", message: "fix it" }];
		expect(() => compileRules(rules)).toThrow(/bad-rule/);
	});

	test("skips disabled rules", () => {
		const rules: TTSRRule[] = [
			{ name: "off", regex: "foo", message: "x", disabled: true },
			{ name: "on", regex: "bar", message: "y" },
		];
		const compiled = compileRules(rules);
		expect(compiled).toHaveLength(1);
		expect(compiled[0]!.name).toBe("on");
	});

	test("defaults scope to assistant_text", () => {
		const compiled = compileRules([{ name: "r", regex: "x", message: "m" }]);
		expect(compiled[0]!.scope).toBe("assistant_text");
	});
});

describe("createMatcher", () => {
	test("feed safe content returns undefined", () => {
		const rules = compileRules([{ name: "no-leak", regex: "Box::leak", message: "no leak" }]);
		const m = createMatcher(rules);
		expect(m.feed("safe content here", "assistant_text")).toBeUndefined();
	});

	test("feed matching content returns the rule", () => {
		const rules = compileRules([{ name: "no-leak", regex: "Box::leak", message: "no leak" }]);
		const m = createMatcher(rules);
		const hit = m.feed("oh no Box::leak(thing) is bad", "assistant_text");
		expect(hit?.name).toBe("no-leak");
	});

	test("returns the FIRST matching rule when multiple could match", () => {
		const rules = compileRules([
			{ name: "first", regex: "ba.", message: "first" },
			{ name: "second", regex: "bar", message: "second" },
		]);
		const m = createMatcher(rules);
		const hit = m.feed("here is bar text", "assistant_text");
		expect(hit?.name).toBe("first");
	});

	test("scope tool_args does NOT fire on assistant_text feed", () => {
		const rules = compileRules([{ name: "args-only", regex: "secret", message: "blocked", scope: "tool_args" }]);
		const m = createMatcher(rules);
		expect(m.feed("this is a secret text", "assistant_text")).toBeUndefined();
		expect(m.feed("this is a secret text", "tool_args")?.name).toBe("args-only");
	});

	test("scope assistant_text does NOT fire on tool_args feed", () => {
		const rules = compileRules([{ name: "text-only", regex: "marker", message: "x", scope: "assistant_text" }]);
		const m = createMatcher(rules);
		expect(m.feed("marker appears", "tool_args")).toBeUndefined();
	});

	test("rolling buffer matches a pattern spanning two feed calls", () => {
		const rules = compileRules([{ name: "split", regex: "abcdef", message: "x" }]);
		const m = createMatcher(rules);
		expect(m.feed("abc", "assistant_text")).toBeUndefined();
		const hit = m.feed("def tail", "assistant_text");
		expect(hit?.name).toBe("split");
	});

	test("any-scope rule fires on both feed types", () => {
		const rules = compileRules([{ name: "any", regex: "ZZZ", message: "x", scope: "any" }]);
		const m1 = createMatcher(rules);
		expect(m1.feed("ZZZ here", "assistant_text")?.name).toBe("any");
		const m2 = createMatcher(rules);
		expect(m2.feed("ZZZ here", "tool_args")?.name).toBe("any");
	});

	test("reset clears buffers without losing rule state", () => {
		const rules = compileRules([{ name: "split", regex: "abcdef", message: "x" }]);
		const m = createMatcher(rules);
		m.feed("abc", "assistant_text");
		m.reset();
		expect(m.feed("def", "assistant_text")).toBeUndefined();
		// New full match still works
		expect(m.feed("abcdef now", "assistant_text")?.name).toBe("split");
	});
});
