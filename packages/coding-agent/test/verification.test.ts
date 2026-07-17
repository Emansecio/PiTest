import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	classifyCrossFileEscape,
	detectCheckCommand,
	detectLocalTypecheckCommand,
	detectSyntaxFallbackCommand,
	extractFailingFiles,
	runCheckCommand,
} from "../src/core/verification/verification.js";

describe("verification module", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pit-verify-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	describe("detectLocalTypecheckCommand", () => {
		it("returns the cwd-relative tsc path (no absolute/quoted path that cmd.exe mis-parses)", async () => {
			await writeFile(join(dir, "tsconfig.json"), "{}");
			const binName = process.platform === "win32" ? "tsc.cmd" : "tsc";
			await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
			await writeFile(join(dir, "node_modules", ".bin", binName), "");
			const cmd = detectLocalTypecheckCommand(dir);
			expect(cmd).toBe(`${join("node_modules", ".bin", binName)} --noEmit`);
			expect(cmd).not.toContain(dir);
		});

		it("returns null without tsconfig.json", () => {
			expect(detectLocalTypecheckCommand(dir)).toBeNull();
		});
	});

	describe("detectCheckCommand", () => {
		it("prefers `check` and defaults to npm", async () => {
			await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { check: "tsc", test: "vitest" } }));
			expect(detectCheckCommand(dir)).toBe("npm run check");
		});

		it("falls back through typecheck/lint/test", async () => {
			await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
			expect(detectCheckCommand(dir)).toBe("npm run test");
		});

		it("uses the lockfile to pick the package manager", async () => {
			await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }));
			await writeFile(join(dir, "pnpm-lock.yaml"), "");
			expect(detectCheckCommand(dir)).toBe("pnpm run typecheck");
		});

		it("returns null without a package.json or recognizable script", async () => {
			expect(detectCheckCommand(dir)).toBeNull();
			await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { start: "node ." } }));
			expect(detectCheckCommand(dir)).toBeNull();
		});
	});

	describe("runCheckCommand", () => {
		it("reports ok on a zero exit", async () => {
			const r = await runCheckCommand(`node -e "process.exit(0)"`, dir, { timeoutMs: 10_000 });
			expect(r.ok).toBe(true);
			expect(r.exitCode).toBe(0);
		});

		it("reports failure with the exit code and captured output", async () => {
			const r = await runCheckCommand(`node -e "console.log('boom'); process.exit(2)"`, dir, { timeoutMs: 10_000 });
			expect(r.ok).toBe(false);
			expect(r.exitCode).toBe(2);
			expect(r.output).toContain("boom");
		});

		it("times out a hung command", async () => {
			// Run from a stable cwd (not the temp dir) so the killed child's brief
			// handle-release race can't EBUSY the afterEach cleanup on Windows.
			const r = await runCheckCommand(`node -e "setTimeout(() => {}, 10000)"`, process.cwd(), { timeoutMs: 400 });
			expect(r.ok).toBe(false);
			expect(r.timedOut).toBe(true);
		});
	});

	describe("detectSyntaxFallbackCommand", () => {
		it("returns null for no touched files", () => {
			expect(detectSyntaxFallbackCommand(dir, [])).toBeNull();
		});

		it("builds a per-file `node --check` for touched JS files", async () => {
			await writeFile(join(dir, "a.js"), "const x = 1;\n");
			await writeFile(join(dir, "b.mjs"), "export const y = 2;\n");
			await writeFile(join(dir, "c.cjs"), "module.exports = 3;\n");
			const cmd = detectSyntaxFallbackCommand(dir, [join(dir, "a.js"), join(dir, "b.mjs"), join(dir, "c.cjs")]);
			expect(cmd).toBe("node --check a.js && node --check b.mjs && node --check c.cjs");
		});

		it("normalizes subdirectory paths to forward slashes", async () => {
			await mkdir(join(dir, "src"), { recursive: true });
			await writeFile(join(dir, "src", "f.js"), "const x = 1;\n");
			expect(detectSyntaxFallbackCommand(dir, [join(dir, "src", "f.js")])).toBe("node --check src/f.js");
		});

		it("ignores .ts files (node --check rejects type syntax)", async () => {
			await writeFile(join(dir, "a.ts"), "const x: number = 1;\n");
			expect(detectSyntaxFallbackCommand(dir, [join(dir, "a.ts")])).toBeNull();
		});

		it("skips non-existent files (fail-open)", () => {
			expect(detectSyntaxFallbackCommand(dir, [join(dir, "ghost.js")])).toBeNull();
		});

		it("skips files outside cwd", async () => {
			const outside = await mkdtemp(join(tmpdir(), "pit-verify-out-"));
			try {
				await writeFile(join(outside, "x.js"), "const x = 1;\n");
				expect(detectSyntaxFallbackCommand(dir, [join(outside, "x.js")])).toBeNull();
			} finally {
				await rm(outside, { recursive: true, force: true });
			}
		});

		it("skips paths with spaces or shell metacharacters (avoids fragile quoting)", async () => {
			await writeFile(join(dir, "has space.js"), "const x = 1;\n");
			expect(detectSyntaxFallbackCommand(dir, [join(dir, "has space.js")])).toBeNull();
		});

		it("only emits a Python check when an interpreter resolves on PATH", async () => {
			await writeFile(join(dir, "a.py"), "x = 1\n");
			const cmd = detectSyntaxFallbackCommand(dir, [join(dir, "a.py")]);
			// Environment-tolerant: null when no python, else a py_compile invocation.
			if (cmd !== null) expect(cmd).toContain("-m py_compile a.py");
		});

		it("emits per-language syntax checks only when the interpreter resolves on PATH", async () => {
			// Each is environment-tolerant: null when the toolchain is absent (the
			// language is skipped, fail-open), else the documented invocation.
			await writeFile(join(dir, "a.rb"), "x = 1\n");
			const rb = detectSyntaxFallbackCommand(dir, [join(dir, "a.rb")]);
			if (rb !== null) expect(rb).toContain("-c a.rb");

			await writeFile(join(dir, "a.php"), "<?php $x = 1;\n");
			const php = detectSyntaxFallbackCommand(dir, [join(dir, "a.php")]);
			if (php !== null) expect(php).toContain("-l a.php");

			await writeFile(join(dir, "a.go"), "package main\n");
			const go = detectSyntaxFallbackCommand(dir, [join(dir, "a.go")]);
			if (go !== null) expect(go).toContain("-e a.go");

			await writeFile(join(dir, "a.sh"), "echo hi\n");
			const sh = detectSyntaxFallbackCommand(dir, [join(dir, "a.sh")]);
			if (sh !== null) expect(sh).toContain("-n a.sh");
		});

		it("returns null for an extension no checker covers", async () => {
			await writeFile(join(dir, "a.txt"), "hello\n");
			await writeFile(join(dir, "a.rs"), "fn main() {}\n");
			expect(detectSyntaxFallbackCommand(dir, [join(dir, "a.txt"), join(dir, "a.rs")])).toBeNull();
		});

		it("keeps JS first and chains multiple languages in deterministic table order", async () => {
			await writeFile(join(dir, "a.js"), "const x = 1;\n");
			await writeFile(join(dir, "b.py"), "x = 1\n");
			const cmd = detectSyntaxFallbackCommand(dir, [join(dir, "b.py"), join(dir, "a.js")]);
			expect(cmd).not.toBeNull();
			// JS always precedes Python regardless of input order (table order).
			expect(cmd).toContain("node --check a.js");
			if ((cmd as string).includes("py_compile")) {
				expect((cmd as string).indexOf("node --check a.js")).toBeLessThan((cmd as string).indexOf("py_compile"));
			}
		});

		it("produces a command that actually passes for valid JS and fails for broken JS", async () => {
			await writeFile(join(dir, "good.js"), "const x = 1;\nconsole.log(x);\n");
			const okCmd = detectSyntaxFallbackCommand(dir, [join(dir, "good.js")]);
			expect(okCmd).not.toBeNull();
			const okRun = await runCheckCommand(okCmd as string, dir, { timeoutMs: 10_000 });
			expect(okRun.ok).toBe(true);

			await writeFile(join(dir, "bad.js"), "const x = ;\n");
			const badCmd = detectSyntaxFallbackCommand(dir, [join(dir, "bad.js")]);
			expect(badCmd).not.toBeNull();
			const badRun = await runCheckCommand(badCmd as string, dir, { timeoutMs: 10_000 });
			expect(badRun.ok).toBe(false);
		});
	});

	describe("extractFailingFiles", () => {
		it("parses tsc/tsgo paren and pretty formats", async () => {
			await mkdir(join(dir, "src"), { recursive: true });
			await writeFile(join(dir, "src", "a.ts"), "export const x = 1;\n");
			await writeFile(join(dir, "src", "b.ts"), "export const y = 2;\n");
			const output = [
				"src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
				"src/b.ts:8:3 - error TS2304: Cannot find name 'foo'.",
				"Found 2 errors.",
			].join("\n");
			expect(extractFailingFiles(output, dir).sort()).toEqual(["src/a.ts", "src/b.ts"]);
		});

		it("parses biome path:line:col headers", async () => {
			await writeFile(join(dir, "file.ts"), "const a == b;\n");
			const output = [
				"file.ts:1:1 lint/suspicious/noDoubleEquals  FIXABLE  ━━━━━━━━━━",
				"  × Use === instead of ==",
				"Checked 1 file in 3ms. Found 1 error.",
			].join("\n");
			expect(extractFailingFiles(output, dir)).toEqual(["file.ts"]);
		});

		it("parses vitest FAIL lines", async () => {
			await mkdir(join(dir, "test"), { recursive: true });
			await writeFile(join(dir, "test", "math.test.ts"), "// test\n");
			const output = [
				" FAIL  test/math.test.ts > add > adds numbers",
				"AssertionError: expected 3 to be 4",
				" Test Files  1 failed (1)",
			].join("\n");
			expect(extractFailingFiles(output, dir)).toEqual(["test/math.test.ts"]);
		});

		it("dedupes repeated files and drops paths that do not exist", async () => {
			await writeFile(join(dir, "real.ts"), "x\n");
			const output = [
				"real.ts:1:1 - error TS1: a",
				"real.ts:2:1 - error TS2: b",
				"ghost.ts:1:1 - error TS3: c",
			].join("\n");
			expect(extractFailingFiles(output, dir)).toEqual(["real.ts"]);
		});

		it("returns nothing for output with no recognizable file paths", () => {
			expect(extractFailingFiles("all good, 0 errors", dir)).toEqual([]);
			expect(extractFailingFiles("", dir)).toEqual([]);
		});
	});

	describe("classifyCrossFileEscape", () => {
		it("classifies all-touched when every failing file was edited", () => {
			const r = classifyCrossFileEscape(["src/a.ts"], [join(dir, "src", "a.ts")], dir);
			expect(r.classification).toBe("all-touched");
			expect(r.crossFileCount).toBe(0);
		});

		it("classifies some-cross-file when only part was edited", () => {
			const r = classifyCrossFileEscape(["src/a.ts", "src/b.ts"], [join(dir, "src", "a.ts")], dir);
			expect(r.classification).toBe("some-cross-file");
			expect(r.failingCount).toBe(2);
			expect(r.crossFileCount).toBe(1);
			expect(r.crossFiles).toEqual(["src/b.ts"]);
		});

		it("classifies all-cross-file when nothing failing was edited", () => {
			const r = classifyCrossFileEscape(["src/a.ts", "src/b.ts"], [join(dir, "src", "other.ts")], dir);
			expect(r.classification).toBe("all-cross-file");
			expect(r.crossFileCount).toBe(2);
		});

		it("classifies unattributed when the parser found nothing", () => {
			const r = classifyCrossFileEscape([], [join(dir, "src", "a.ts")], dir);
			expect(r.classification).toBe("unattributed");
			expect(r.failingCount).toBe(0);
		});

		it("matches abs vs rel spellings (and is case-insensitive on Windows)", () => {
			const touched = process.platform === "win32" ? [join(dir, "SRC", "A.ts")] : [join(dir, "src", "a.ts")];
			const r = classifyCrossFileEscape(["src/a.ts"], touched, dir);
			expect(r.classification).toBe("all-touched");
		});
	});
});
