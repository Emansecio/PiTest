import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	detectCheckCommand,
	detectLocalTypecheckCommand,
	detectSyntaxFallbackCommand,
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
});
