import { afterEach, describe, expect, test, vi } from "vitest";
import { compileRules, createMatcher, parseRollingBufferChars, type TTSRRule } from "../src/core/ttsr.js";

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

	test("coalesced feeds are equivalent: one concatenated chunk hits exactly like many small chunks", () => {
		// Property the agent-loop 16ms coalesced feed relies on (5.2): the rolling
		// buffer is concatenative, so feeding N raw deltas or their concatenation
		// yields the same detection — only the number of regex passes differs.
		const rules = compileRules([{ name: "span", regex: "abcdef", message: "x" }]);
		const perDelta = createMatcher(rules);
		let perDeltaHit: ReturnType<typeof perDelta.feed>;
		for (const chunk of ["ab", "cd", "ef"]) {
			perDeltaHit = perDeltaHit ?? perDelta.feed(chunk, "assistant_text");
		}
		const coalesced = createMatcher(rules);
		const coalescedHit = coalesced.feed("abcdef", "assistant_text");
		expect(perDeltaHit?.name).toBe("span");
		expect(coalescedHit?.name).toBe("span");
	});

	test("a trailing remainder chunk (final flush) completes a match spanning earlier feeds", () => {
		// Mirrors the agent-loop end-of-message/abort drain: text pending in the
		// coalescing window is fed as one last chunk and must still complete a
		// match started by earlier feeds.
		const rules = compileRules([{ name: "tail", regex: "do not force-push", message: "x" }]);
		const m = createMatcher(rules);
		expect(m.feed("please do not ", "assistant_text")).toBeUndefined();
		expect(m.feed("force-push", "assistant_text")?.name).toBe("tail");
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

describe("parseRollingBufferChars (A2)", () => {
	test("undefined / empty fall back to the 2048 default", () => {
		expect(parseRollingBufferChars(undefined)).toBe(2048);
		expect(parseRollingBufferChars("")).toBe(2048);
	});

	test("non-numeric falls back to the default", () => {
		expect(parseRollingBufferChars("abc")).toBe(2048);
		expect(parseRollingBufferChars("NaN")).toBe(2048);
	});

	test("clamps into [512, 65536]", () => {
		expect(parseRollingBufferChars("100")).toBe(512);
		expect(parseRollingBufferChars("999999")).toBe(65536);
		expect(parseRollingBufferChars("512")).toBe(512);
		expect(parseRollingBufferChars("65536")).toBe(65536);
	});

	test("accepts an in-range value and floors fractions", () => {
		expect(parseRollingBufferChars("4096")).toBe(4096);
		expect(parseRollingBufferChars("4096.9")).toBe(4096);
	});
});

describe("createMatcher buffer-span guard (A2)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("warns at most once when a rule pattern is longer than the rolling buffer", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// Pattern source longer than the default 2048-char buffer: the rule can
		// never match against the rolling window, so a dev-facing warning fires.
		const longSource = "a".repeat(3000);
		const rules = compileRules([{ name: "too-long", regex: longSource, message: "x" }]);
		createMatcher(rules);
		createMatcher(rules);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]![0]).toMatch(/too-long/);
		expect(warn.mock.calls[0]![0]).toMatch(/PIT_TTSR_BUFFER_CHARS/);
	});
});
