/**
 * Tests for permissions matcher utilities — glob compilation, path matching,
 * and command regex matching.
 */

import { describe, expect, it } from "vitest";
import {
	findMatchingCommandRule,
	findMatchingGlob,
	globToRegExp,
	matchGlob,
	normalizeTargetPath,
} from "../src/core/permissions/matcher.js";

describe("permissions/matcher: globToRegExp", () => {
	it("matches simple literal segments", () => {
		const re = globToRegExp("src/foo.ts");
		expect(re.test("src/foo.ts")).toBe(true);
		expect(re.test("src/foo.tsx")).toBe(false);
		expect(re.test("other/src/foo.ts")).toBe(false);
	});

	it("`*` matches a single segment", () => {
		expect(matchGlob("src/*.ts", "src/index.ts")).toBe(true);
		expect(matchGlob("src/*.ts", "src/sub/index.ts")).toBe(false);
	});

	it("`**` crosses path separators", () => {
		expect(matchGlob("src/**/*.ts", "src/a/b/c/index.ts")).toBe(true);
		expect(matchGlob("**/.env", "/home/user/proj/.env")).toBe(true);
		expect(matchGlob("**/.env*", "/proj/.env.production")).toBe(true);
	});

	it("`**/foo` matches both nested and top-level foo", () => {
		expect(matchGlob("**/foo", "foo")).toBe(true);
		expect(matchGlob("**/foo", "a/b/foo")).toBe(true);
	});

	it("escapes regex metacharacters", () => {
		expect(matchGlob("a+b/c.ts", "a+b/c.ts")).toBe(true);
		expect(matchGlob("a+b/c.ts", "axb/cxts")).toBe(false);
	});
});

describe("permissions/matcher: findMatchingGlob", () => {
	it("returns the first matching rule with its reason", () => {
		const rules = [
			{ glob: "**/.env*", reason: "secrets" },
			{ glob: "**/build/**", reason: "build dir" },
		];
		const m = findMatchingGlob(rules, "/proj/.env.local");
		expect(m?.reason).toBe("secrets");
		const b = findMatchingGlob(rules, "/proj/build/output");
		expect(b?.reason).toBe("build dir");
		expect(findMatchingGlob(rules, "/proj/src/index.ts")).toBeUndefined();
	});

	it("respects per-rule tool restriction", () => {
		const rules = [{ glob: "**/dist/**", tools: ["write"], reason: "dist" }];
		expect(findMatchingGlob(rules, "/proj/dist/a.js", "read")).toBeUndefined();
		expect(findMatchingGlob(rules, "/proj/dist/a.js", "write")?.reason).toBe("dist");
	});
});

describe("permissions/matcher: normalizeTargetPath", () => {
	it("resolves relative paths against cwd", () => {
		const cwd = process.platform === "win32" ? "C:/proj" : "/proj";
		expect(normalizeTargetPath("src/index.ts", cwd)).toBe(`${cwd}/src/index.ts`);
	});

	it("passes absolute paths through (normalized to forward slashes)", () => {
		const cwd = process.platform === "win32" ? "C:/proj" : "/proj";
		const abs = process.platform === "win32" ? "C:/other/file.ts" : "/other/file.ts";
		expect(normalizeTargetPath(abs, cwd)).toBe(abs);
	});
});

describe("permissions/matcher: findMatchingCommandRule", () => {
	it("matches case-insensitive by default", () => {
		const rules = [{ pattern: "rm\\s+-rf", reason: "danger" }];
		expect(findMatchingCommandRule(rules, "RM -RF /tmp/foo")?.reason).toBe("danger");
	});

	it("returns undefined when no rule matches", () => {
		expect(findMatchingCommandRule([{ pattern: "git\\s+push" }], "ls -la")).toBeUndefined();
	});

	it("ignores invalid regex without crashing", () => {
		expect(findMatchingCommandRule([{ pattern: "(" }], "anything")).toBeUndefined();
	});
});
