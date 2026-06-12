/**
 * Regression tests for OOM/hang in the eval kernels:
 *  - Python: unbounded stdout/stderr buffering from a runaway print loop.
 *  - JavaScript: synchronous `while(true){}` blocking the driver event loop.
 *
 * The output cap is tightened to a few KB via PIT_EVAL_MAX_OUTPUT_BYTES so the
 * "exceeds cap" path trips almost immediately and the tests stay fast. We set
 * the env BEFORE constructing each kernel because the cap is read in the
 * constructor.
 */

import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJsKernel } from "../src/core/eval-kernel/javascript.js";
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

describe("eval kernel runaway guards", () => {
	const prevCap = process.env.PIT_EVAL_MAX_OUTPUT_BYTES;
	let kernel: EvalKernel | undefined;

	beforeEach(() => {
		// Tiny cap so a runaway loop trips it within a few writes.
		process.env.PIT_EVAL_MAX_OUTPUT_BYTES = "4096";
	});

	afterEach(async () => {
		if (kernel) {
			await kernel.close().catch(() => undefined);
			kernel = undefined;
		}
		if (prevCap === undefined) delete process.env.PIT_EVAL_MAX_OUTPUT_BYTES;
		else process.env.PIT_EVAL_MAX_OUTPUT_BYTES = prevCap;
	});

	it.skipIf(!PY_AVAILABLE)(
		"python: runaway print loop is killed with an 'exceeded' error, no hang/OOM",
		async () => {
			kernel = createPyKernel(process.cwd());
			const start = Date.now();
			// A near-infinite print loop. With no cap this fills memory until the
			// 30s timeout; with the cap it must die fast.
			await expect(
				kernel.exec({
					lang: "python",
					code: "import sys\nwhile True:\n  sys.stdout.write('x' * 1000)\n  sys.stdout.flush()\n",
					timeoutMs: 20_000,
				}),
			).rejects.toThrow(/exceeded \d+ bytes \(killed\)/);
			// Proves it didn't ride the full timeout.
			expect(Date.now() - start).toBeLessThan(10_000);
			expect(kernel.isAlive()).toBe(false);
		},
		15_000,
	);

	it.skipIf(!PY_AVAILABLE)(
		"python: normal small output is unaffected (sentinel detected, exact output)",
		async () => {
			// Default (large) cap for the happy path so nothing trips.
			process.env.PIT_EVAL_MAX_OUTPUT_BYTES = "";
			kernel = createPyKernel(process.cwd());
			const r1 = await kernel.exec({
				lang: "python",
				code: "print('hello world')\nx = 41\n",
				timeoutMs: 20_000,
			});
			expect(r1.error).toBeUndefined();
			expect(r1.stdout.trim()).toBe("hello world");

			// State persists across calls (var x), and the search-offset path still
			// detects the sentinel for a second exec.
			const r2 = await kernel.exec({
				lang: "python",
				code: "print(x + 1)\n",
				timeoutMs: 20_000,
			});
			expect(r2.error).toBeUndefined();
			expect(r2.stdout.trim()).toBe("42");
		},
		15_000,
	);

	it.skipIf(!PY_AVAILABLE)(
		"python: large-but-bounded multi-chunk output keeps the sentinel intact across chunk splits",
		async () => {
			process.env.PIT_EVAL_MAX_OUTPUT_BYTES = "";
			kernel = createPyKernel(process.cwd());
			// ~200KB across many writes forces the OS to deliver several stdout
			// chunks, exercising the (sentinel.length - 1) search-offset overlap.
			const r = await kernel.exec({
				lang: "python",
				code: "for i in range(2000):\n  print('line', i)\n",
				timeoutMs: 20_000,
			});
			expect(r.error).toBeUndefined();
			const lines = r.stdout.trim().split("\n");
			expect(lines.length).toBe(2000);
			expect(lines[0]).toBe("line 0");
			expect(lines[1999]).toBe("line 1999");
		},
		15_000,
	);

	it("javascript: synchronous while(true){} is aborted by the vm timeout, not hung", async () => {
		kernel = createJsKernel(process.cwd());
		const start = Date.now();
		const r = await kernel.exec({
			lang: "javascript",
			code: "while (true) {}",
			timeoutMs: 1_500,
		});
		// vm timeout surfaces as an error on the result, kernel stays usable.
		expect(r.error).toBeTruthy();
		expect(r.error ?? "").toMatch(/timed out/i);
		expect(Date.now() - start).toBeLessThan(8_000);
	}, 12_000);

	it("javascript: runaway console.log flood is capped, kernel survives", async () => {
		kernel = createJsKernel(process.cwd());
		const r = await kernel.exec({
			lang: "javascript",
			code: "for (let i = 0; i < 100000; i++) { console.log('x'.repeat(100)); }",
			timeoutMs: 10_000,
		});
		// Child caps the captured output and marks it truncated; no error, no OOM.
		expect(r.stdout).toContain("[output truncated]");
		expect(r.stdout.length).toBeLessThan(64 * 1024);
	}, 15_000);

	it("javascript: normal small output is unaffected", async () => {
		kernel = createJsKernel(process.cwd());
		const r = await kernel.exec({
			lang: "javascript",
			code: "console.log('hi'); globalThis.k = 7;",
			timeoutMs: 10_000,
		});
		expect(r.error).toBeFalsy();
		expect(r.stdout.trim()).toBe("hi");
		const r2 = await kernel.exec({ lang: "javascript", code: "console.log(k + 1);", timeoutMs: 10_000 });
		expect(r2.stdout.trim()).toBe("8");
	}, 15_000);
});
