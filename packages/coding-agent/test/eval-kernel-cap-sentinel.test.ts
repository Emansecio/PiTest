/**
 * Regression for #23: the Python kernel's output cap (enforceOutputCap) measured
 * the RAW buffers (stdout+stderr) before the end-of-call sentinel was sliced out.
 * The sentinel (~46 bytes + newline) is appended to those same buffers when the
 * call COMPLETES. So a call whose legitimate output lands just under the cap
 * could be falsely killed by the chunk carrying the sentinel — reporting
 * "output exceeded ... (killed)" and respawning the kernel (wiping all state)
 * for a call that actually finished within budget.
 *
 * The fix measures only the pre-sentinel payload. A genuine runaway never reaches
 * the finally that emits the sentinel, so the cap still trips for it
 * (covered by eval-kernel-runaway.test.ts).
 *
 * Determinism: cap = 200 bytes. A warm-up call first flushes Python's one-time
 * REPL banner (~178 bytes on stderr) so it does not contaminate the boundary
 * measurement. The boundary payload is 190 bytes (<= cap, must succeed) but raw
 * payload + sentinel(46) + newline > 200 (which tripped the old cap). We verify
 * the call succeeds with exact output AND the kernel stays alive with persisted
 * state.
 */

import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("eval kernel: output cap ignores the end-of-call sentinel (#23)", () => {
	const prevCap = process.env.PIT_EVAL_MAX_OUTPUT_BYTES;
	let kernel: EvalKernel | undefined;

	beforeEach(() => {
		// Tight cap. Payload below it but payload+sentinel above it.
		process.env.PIT_EVAL_MAX_OUTPUT_BYTES = "200";
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
		"a completed call whose payload is within budget is NOT killed by the sentinel overshoot",
		async () => {
			kernel = createPyKernel(process.cwd());
			// Warm-up flushes Python's one-time REPL banner off stderr (it would
			// otherwise count toward the cap on the first real call). The boundary
			// assertion below must be free of that one-time overhead.
			await kernel.exec({ lang: "python", code: "pass\n", timeoutMs: 20_000 });
			// 190 bytes payload <= 200 cap; with the ~48-byte sentinel appended to the
			// same buffer the RAW length is ~238 > 200, which tripped the old cap.
			const r = await kernel.exec({
				lang: "python",
				code: "import sys\nsys.stdout.write('x' * 190)\nx = 7\n",
				timeoutMs: 20_000,
			});
			expect(r.error).toBeUndefined();
			expect(r.stdout).toBe("x".repeat(190));
			// The kernel survived (no false kill + respawn): state persists.
			expect(kernel.isAlive()).toBe(true);
			const r2 = await kernel.exec({ lang: "python", code: "print(x + 1)\n", timeoutMs: 20_000 });
			expect(r2.error).toBeUndefined();
			expect(r2.stdout.trim()).toBe("8");
		},
		20_000,
	);

	it.skipIf(!PY_AVAILABLE)(
		"a genuine runaway whose payload exceeds the cap is still killed",
		async () => {
			kernel = createPyKernel(process.cwd());
			await expect(
				kernel.exec({
					lang: "python",
					code: "import sys\nwhile True:\n  sys.stdout.write('x' * 1000)\n  sys.stdout.flush()\n",
					timeoutMs: 20_000,
				}),
			).rejects.toThrow(/exceeded \d+ bytes \(killed\)/);
			expect(kernel.isAlive()).toBe(false);
		},
		20_000,
	);
});
