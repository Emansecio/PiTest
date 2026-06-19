/**
 * Regression for #6: when a python eval call times out (or is aborted), the
 * kernel must tear down the WHOLE process tree (killProcessTree), not just the
 * interpreter (proc.kill). Otherwise a child process spawned by the user code
 * is orphaned and keeps running after the timeout.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPyKernel } from "../src/core/eval-kernel/python.js";
import type { EvalKernel } from "../src/core/eval-kernel/types.js";

function hasPython(): boolean {
	for (const cmd of ["python", "python3"]) {
		try {
			execFileSync(cmd, ["--version"], { stdio: "ignore" });
			return true;
		} catch {
			// try next
		}
	}
	return false;
}

const PY_AVAILABLE = hasPython();

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("eval kernel orphan child teardown", () => {
	let kernel: EvalKernel | undefined;
	let dir: string | undefined;

	afterEach(async () => {
		if (kernel) {
			await kernel.close().catch(() => undefined);
			kernel = undefined;
		}
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = undefined;
		}
	});

	it.skipIf(!PY_AVAILABLE)(
		"python: timeout kills child processes spawned by user code (no orphans)",
		async () => {
			dir = mkdtempSync(join(tmpdir(), "pit-orphan-"));
			const pidFile = join(dir, "child.pid").replace(/\\/g, "/");
			kernel = createPyKernel(process.cwd());
			// Spawn a long-lived grandchild, record its pid, then block. The kernel
			// times out and must take the grandchild down with it.
			const code = [
				"import subprocess, sys, time",
				"p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])",
				`open(${JSON.stringify(pidFile)}, 'w').write(str(p.pid))`,
				"time.sleep(60)",
			].join("\n");
			await expect(kernel.exec({ lang: "python", code: `${code}\n`, timeoutMs: 2_500 })).rejects.toThrow(
				/timed out/,
			);

			// Give the OS a moment to reap the tree.
			await sleep(1_500);
			const childPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
			expect(Number.isFinite(childPid)).toBe(true);
			expect(isAlive(childPid)).toBe(false);
		},
		20_000,
	);
});
