import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectCheckCommand, runCheckCommand } from "../src/core/verification/verification.js";

describe("verification module", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pit-verify-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
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
});
