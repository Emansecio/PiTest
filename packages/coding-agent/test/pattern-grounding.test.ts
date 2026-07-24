import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createPatternGroundingExtension } from "../src/core/built-ins/pattern-grounding-extension.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { groundPattern, isPatternGroundingDisabled } from "../src/core/pattern-grounding.ts";

const grep = (args: Record<string, unknown>) => groundPattern({ toolName: "grep", args });
const find = (args: Record<string, unknown>) => groundPattern({ toolName: "find", args });

describe("groundPattern — grep regex (well-formed -> allow)", () => {
	it("allows balanced regexes incl. groups, classes, alternation, quantifiers", () => {
		for (const pattern of ["foo.*bar", "(a|b)+", "[a-z]+", "a(b(c)d)e", "\\d{1,3}", "^foo$"]) {
			expect(grep({ pattern })).toEqual({ action: "allow" });
		}
	});

	it("allows a ripgrep-valid Python-style named group (zero false-positive — JS would reject it)", () => {
		// new RegExp("(?P<n>x)") THROWS in JS, but rg accepts it. A balance check passes it.
		expect(grep({ pattern: "(?P<name>foo)bar" })).toEqual({ action: "allow" });
	});

	it("allows group/class delimiters that are ESCAPED or inside a [...] class", () => {
		expect(grep({ pattern: "foo\\(bar" })).toEqual({ action: "allow" }); // escaped (
		expect(grep({ pattern: "[()]" })).toEqual({ action: "allow" }); // parens literal inside class
		expect(grep({ pattern: "a[\\]]b" })).toEqual({ action: "allow" }); // escaped ] inside class
	});
});

describe("groundPattern — grep regex (malformed -> block)", () => {
	it("blocks an unterminated group", () => {
		const d = grep({ pattern: "foo(bar" });
		expect(d.action).toBe("block");
		if (d.action === "block") {
			expect(d.message).toContain("foo(bar");
			expect(d.message).toContain("set literal:true");
			expect(d.message).toContain("re-issue the identical call");
		}
	});

	it("blocks an unterminated character class", () => {
		expect(grep({ pattern: "a[i" }).action).toBe("block");
	});

	it("blocks an unmatched ')'", () => {
		expect(grep({ pattern: "foo)" }).action).toBe("block");
	});

	it("does NOT validate the pattern when literal:true (it's not a regex then)", () => {
		expect(grep({ pattern: "foo(", literal: true })).toEqual({ action: "allow" });
	});
});

describe("groundPattern — glob (grep.glob + find.pattern)", () => {
	it("allows well-formed globs", () => {
		for (const glob of ["*.ts", "**/*.json", "src/**/*.spec.ts", "src/[a-z]/*.ts", "**/{a,b}/*.ts"]) {
			expect(grep({ pattern: "x", glob })).toEqual({ action: "allow" });
			expect(find({ pattern: glob })).toEqual({ action: "allow" });
		}
	});

	it("blocks an unterminated brace expansion in grep.glob", () => {
		const d = grep({ pattern: "x", glob: "**/{a,b" });
		expect(d.action).toBe("block");
		if (d.action === "block") {
			expect(d.message).toContain("**/{a,b");
			expect(d.message).toContain("silently matches NOTHING");
		}
	});

	it("blocks an unterminated character class in find.pattern (silent 0-match otherwise)", () => {
		expect(find({ pattern: "src/[a-" }).action).toBe("block");
		expect(find({ pattern: "**/{a,b" }).action).toBe("block");
	});

	it("blocks an unmatched '}' in a glob", () => {
		expect(find({ pattern: "a}b/*.ts" }).action).toBe("block");
	});
});

describe("groundPattern — FAIL-OPEN / out of scope", () => {
	it("ignores tools other than grep/find", () => {
		for (const toolName of ["read", "edit", "write", "bash", "ls"]) {
			expect(groundPattern({ toolName, args: { pattern: "foo(" } })).toEqual({ action: "allow" });
		}
	});

	it("allows when the pattern/glob is missing or not a string", () => {
		expect(grep({})).toEqual({ action: "allow" });
		expect(grep({ pattern: 42 })).toEqual({ action: "allow" });
		expect(grep({ pattern: "" })).toEqual({ action: "allow" });
		expect(find({})).toEqual({ action: "allow" });
	});

	it("a malformed glob does not mask a valid regex pattern (grep checks both)", () => {
		// valid regex + malformed glob -> block (on the glob); valid both -> allow.
		expect(grep({ pattern: "valid.*", glob: "**/{a,b" }).action).toBe("block");
		expect(grep({ pattern: "valid.*", glob: "*.ts" })).toEqual({ action: "allow" });
	});
});

describe("pattern-grounding extension — adapter wiring", () => {
	type Handler = (event: { toolName: string; toolCallId: string; input: Record<string, unknown> }) => unknown;

	function makeFakePi() {
		const handlers: Handler[] = [];
		const api = {
			on(event: string, handler: Handler) {
				if (event === "tool_call") handlers.push(handler);
			},
		} as unknown as ExtensionAPI;
		createPatternGroundingExtension()(api);
		const fire = (toolName: string, input: Record<string, unknown>, toolCallId = "p1") => {
			let result: unknown;
			for (const handler of handlers) {
				const r = handler({ toolName, toolCallId, input });
				if (r !== undefined && result === undefined) result = r;
			}
			return result as { block?: boolean; reason?: string } | undefined;
		};
		return fire;
	}

	afterEach(() => {
		process.env.PIT_NO_PATTERN_GROUNDING = "";
	});

	it("allows a well-formed grep pattern", () => {
		const fire = makeFakePi();
		expect(fire("grep", { pattern: "foo.*bar" })).toBeUndefined();
	});

	it("blocks a malformed grep regex with the pure module's message", () => {
		const fire = makeFakePi();
		const blocked = fire("grep", { pattern: "foo(bar" });
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain("foo(bar");
	});

	it("blocks a malformed find glob (silent 0-match otherwise)", () => {
		const fire = makeFakePi();
		expect(fire("find", { pattern: "**/{a,b" })?.block).toBe(true);
	});

	it("ignores tools other than grep/find", () => {
		const fire = makeFakePi();
		for (const toolName of ["read", "edit", "write", "bash", "ls"]) {
			expect(fire(toolName, { pattern: "foo(" })).toBeUndefined();
		}
	});

	it("records blocked then overridden diagnostics tagged with the malformed-pattern ruleId", () => {
		resetRuntimeDiagnostics();
		const fire = makeFakePi();
		expect(fire("grep", { pattern: "a[i" }, "g1")?.block).toBe(true);
		// Identical re-issue escapes the fire-once guard (override), and is recorded.
		expect(fire("grep", { pattern: "a[i" }, "g2")).toBeUndefined();

		const events = getRuntimeDiagnostics().recent.filter((e) => e.category === "guard.pattern-grounding");
		expect(events.map((e) => e.context?.outcome)).toEqual(["blocked", "overridden"]);
		expect(events.every((e) => e.context?.ruleId === "malformed-pattern")).toBe(true);
		expect(events.every((e) => e.source === "pattern-grounding-extension")).toBe(true);
	});

	it("blocks a DIFFERENT malformed pattern again (fire-once is per (tool, args))", () => {
		const fire = makeFakePi();
		expect(fire("grep", { pattern: "a[i" })?.block).toBe(true);
		expect(fire("grep", { pattern: "foo)" })?.block).toBe(true);
	});

	it("goes silent under PIT_NO_PATTERN_GROUNDING", () => {
		const fire = makeFakePi();
		process.env.PIT_NO_PATTERN_GROUNDING = "1";
		expect(fire("grep", { pattern: "foo(bar" })).toBeUndefined();
	});
});

describe("isPatternGroundingDisabled — opt-out", () => {
	it("false when unset, true for 1/true/yes (case-insensitive)", () => {
		expect(isPatternGroundingDisabled({})).toBe(false);
		expect(isPatternGroundingDisabled({ PIT_NO_PATTERN_GROUNDING: "1" })).toBe(true);
		expect(isPatternGroundingDisabled({ PIT_NO_PATTERN_GROUNDING: "TRUE" })).toBe(true);
		expect(isPatternGroundingDisabled({ PIT_NO_PATTERN_GROUNDING: "yes" })).toBe(true);
		expect(isPatternGroundingDisabled({ PIT_NO_PATTERN_GROUNDING: "0" })).toBe(false);
	});
});
