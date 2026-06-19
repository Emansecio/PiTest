import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBashCwd } from "../src/core/tools/bash.ts";

/**
 * A `cwd: "~/proj"` must expand to the home directory. Without expansion `~` is
 * not absolute (especially on Windows) and resolves under the session root as a
 * literal directory named "~", which the executor then rejects as non-existent.
 */
describe("resolveBashCwd tilde expansion", () => {
	const base = process.cwd();

	it("expands a bare ~ to the home directory", () => {
		expect(resolveBashCwd(base, "~")).toBe(homedir());
	});

	it("expands ~/sub to a path under the home directory", () => {
		expect(resolveBashCwd(base, "~/proj")).toBe(resolvePath(homedir(), "proj"));
	});

	it("leaves absolute paths untouched", () => {
		const abs = resolvePath(base, "somewhere");
		expect(resolveBashCwd(base, abs)).toBe(abs);
	});

	it("resolves a relative path against the base cwd", () => {
		const out = resolveBashCwd(base, "sub/dir");
		expect(isAbsolute(out)).toBe(true);
		expect(out).toBe(resolvePath(base, "sub/dir"));
	});

	it("falls back to the base cwd when empty/missing", () => {
		expect(resolveBashCwd(base, undefined)).toBe(base);
		expect(resolveBashCwd(base, "   ")).toBe(base);
	});
});
