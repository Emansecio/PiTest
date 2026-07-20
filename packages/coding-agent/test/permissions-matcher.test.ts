/**
 * Tests for permissions matcher utilities — glob compilation, path matching,
 * and command regex matching.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	findMatchingCommandRule,
	findMatchingGlob,
	globToRegExp,
	matchGlob,
	normalizeTargetPath,
} from "../src/core/permissions/matcher.js";
import { BUILTIN_SENSITIVE_PATHS } from "../src/core/permissions/types.js";

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

	it("rejects more than three ** segments", () => {
		expect(() => globToRegExp("**/a/**/b/**/c/**/d")).toThrow(/\*\*/);
		expect(matchGlob("**/a/**/b/**/c/**/d", "a/b/c/d")).toBe(false);
	});

	it("`**/foo` matches both nested and top-level foo", () => {
		expect(matchGlob("**/foo", "foo")).toBe(true);
		expect(matchGlob("**/foo", "a/b/foo")).toBe(true);
	});

	it("escapes regex metacharacters", () => {
		expect(matchGlob("a+b/c.ts", "a+b/c.ts")).toBe(true);
		expect(matchGlob("a+b/c.ts", "axb/cxts")).toBe(false);
	});

	it.runIf(process.platform === "win32" || process.platform === "darwin")(
		"matches case-insensitively on Windows and macOS",
		() => {
			expect(matchGlob("**/.env", "/proj/.ENV")).toBe(true);
		},
	);

	it.runIf(process.platform === "linux")("matches case-sensitively on Linux", () => {
		expect(matchGlob("**/.env", "/proj/.ENV")).toBe(false);
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

describe("permissions/matcher: deny-floor sensitive-glob canonical-path hardening (plan 022)", () => {
	const cwd = process.platform === "win32" ? "C:/proj" : "/proj";

	it("a plain non-sensitive path does not match the built-in sensitive globs", () => {
		expect(findMatchingGlob(BUILTIN_SENSITIVE_PATHS, `${cwd}/src/index.ts`)).toBeUndefined();
	});

	it("still matches an ordinary, unmangled .env path (no regression)", () => {
		expect(findMatchingGlob(BUILTIN_SENSITIVE_PATHS, `${cwd}/.env`)?.reason).toBe("Secrets file");
	});

	// ADS and trailing-space/dot are Windows (NTFS) filesystem quirks — only meaningful
	// as a bypass attempt on win32, so these mirror the win32-only guard already used
	// above (`it.runIf(process.platform === "win32" || ...)`) to keep the suite green
	// cross-platform.
	it.runIf(process.platform === "win32")(
		"matches .env through a trailing space (Windows silently drops it on file access)",
		() => {
			expect(findMatchingGlob(BUILTIN_SENSITIVE_PATHS, `${cwd}/.env `)?.reason).toBe("Secrets file");
		},
	);

	it.runIf(process.platform === "win32")(
		"matches .env through an NTFS alternate-data-stream suffix (::$DATA is the same file's default stream)",
		() => {
			expect(findMatchingGlob(BUILTIN_SENSITIVE_PATHS, `${cwd}/.env::$DATA`)?.reason).toBe("Secrets file");
		},
	);

	it("matches a read THROUGH an in-repo symlink whose real target lives under .ssh (canonical key)", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-matcher-sensitive-"));
		try {
			const realSshDir = join(tempDir, ".ssh");
			mkdirSync(realSshDir);
			writeFileSync(join(realSshDir, "id_rsa"), "fake-key", "utf-8");
			const link = join(tempDir, "creds-link");
			// Symlink creation can fail without privilege on Windows — skip if so
			// (mirrors the try/catch-skip pattern in read-guard-extension.test.ts).
			try {
				symlinkSync(realSshDir, link, "dir");
			} catch {
				return;
			}
			const target = normalizeTargetPath(join(link, "id_rsa"), tempDir);
			// The raw resolved path (through the symlink) does not literally contain
			// "/.ssh/", so only the canonical (realpath-resolved) key matches.
			expect(findMatchingGlob(BUILTIN_SENSITIVE_PATHS, target)?.reason).toBe("SSH keys");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not apply the canonical-path hardening to a user-authored rule with the same glob text (identity-scoped)", () => {
		// A rule object that is NOT one of BUILTIN_SENSITIVE_PATHS' own instances, even
		// though it reuses the same glob string — must NOT get the trailing-space
		// tolerance (or any other sensitive-only hardening). Regular denyPaths/allowPaths
		// matching behavior must stay exactly as before this plan.
		const userRule = { glob: "**/.env", reason: "user secrets rule" };
		expect(findMatchingGlob([userRule], `${cwd}/.env `)).toBeUndefined();
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

	it("ignores unsafe ReDoS patterns", () => {
		expect(findMatchingCommandRule([{ pattern: "(a+)+" }], "aaaaaaaa")).toBeUndefined();
		expect(findMatchingCommandRule([{ pattern: ".*.*" }], "xx")).toBeUndefined();
	});
});
