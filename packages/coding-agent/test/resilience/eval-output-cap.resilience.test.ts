/**
 * Resilience (fault-injection) — EVAL TOOL layer, end-to-end under a real child.
 *
 * Scenario 2: user code floods stdout in a tight loop. Without a cap the kernel
 * buffers until the timeout (or OOM). The output cap must (a) reject the exec
 * with an "exceeded … (killed)" error, (b) leave the kernel marked dead (the
 * runaway child is torn down, not leaked), and (c) surface the fault on the
 * observable `runtime-diagnostics` channel as `output.cap`.
 *
 * Anti-flaky: NO fake timers here — these spawn a real interpreter, but the cap
 * is injected MINUSCULE via PIT_EVAL_MAX_OUTPUT_BYTES=4096 (read in the kernel
 * constructor), so a `print` loop overshoots 4 KB and is killed within a handful
 * of writes — milliseconds, not the multi-second timeout. The exec rejects on an
 * event (the cap check on a stdout `data` chunk), not on a clock. Generous
 * per-test timeouts are a safety net for a thermally-throttled box, never the
 * mechanism. Python carries the cap-diagnostic assertion because its cap path
 * records `output.cap` directly; the JS case asserts the survive-and-truncate
 * contract.
 */

import { execFileSync } from "node:child_process";
import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJsKernel } from "../../src/core/eval-kernel/javascript.ts";
import { createPyKernel } from "../../src/core/eval-kernel/python.ts";
import type { EvalKernel } from "../../src/core/eval-kernel/types.ts";

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
const TINY_CAP = "4096";

describe("resilience: eval output cap → kill + observable diagnostic", () => {
	const prevCap = process.env.PIT_EVAL_MAX_OUTPUT_BYTES;
	let kernel: EvalKernel | undefined;

	beforeEach(() => {
		resetRuntimeDiagnostics();
		// Minuscule cap so a runaway flood trips within a few writes (fast + safe).
		process.env.PIT_EVAL_MAX_OUTPUT_BYTES = TINY_CAP;
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
		"(2) python runaway flood is killed with an 'exceeded' error and records output.cap",
		async () => {
			kernel = createPyKernel(process.cwd());
			const start = Date.now();

			// A near-infinite print loop. With the tiny cap it must die almost
			// immediately rather than ride the 20s timeout.
			await expect(
				kernel.exec({
					lang: "python",
					code: "for i in range(100000):\n  print(i)\n",
					timeoutMs: 20_000,
				}),
			).rejects.toThrow(/exceeded \d+ bytes \(killed\)/);

			// (a) recovery was fast — it did NOT ride the full timeout.
			expect(Date.now() - start).toBeLessThan(8_000);

			// (b) the runaway child was torn down; the kernel is marked dead.
			expect(kernel.isAlive()).toBe(false);

			// (c) the fault is observable on the runtime-diagnostics channel.
			const snap = getRuntimeDiagnostics();
			expect(snap.counters["output.cap"]?.count ?? 0).toBeGreaterThanOrEqual(1);
			expect(snap.counters["output.cap"]?.level).toBe("error");
			// Source pinpoints the python kernel; context carries the overflow size.
			expect(snap.counters["output.cap"]?.lastContext?.bytes ?? 0).toBeGreaterThan(Number(TINY_CAP));
			expect(snap.recent.some((e) => e.category === "output.cap" && e.source === "eval-kernel.python")).toBe(true);
		},
		15_000,
	);

	it.skipIf(!PY_AVAILABLE)(
		"(2b) python small output below the cap is unaffected and records no fault",
		async () => {
			kernel = createPyKernel(process.cwd());
			const r = await kernel.exec({ lang: "python", code: "print('ok')\n", timeoutMs: 20_000 });
			expect(r.error).toBeUndefined();
			expect(r.stdout.trim()).toBe("ok");
			expect(kernel.isAlive()).toBe(true);
			expect(getRuntimeDiagnostics().counters["output.cap"]?.count ?? 0).toBe(0);
		},
		15_000,
	);

	it("(2c) javascript runaway console flood is capped in-child; kernel survives, no OOM", async () => {
		kernel = createJsKernel(process.cwd());
		const start = Date.now();
		const r = await kernel.exec({
			lang: "javascript",
			code: "for (let i = 0; i < 100000; i++) { console.log('x'.repeat(200)); }",
			timeoutMs: 10_000,
		});

		// The child caps its own captured output and marks it truncated; the
		// driver returns a bounded result with no error and no OOM, and the
		// kernel remains usable for the next exec.
		expect(r.stdout).toContain("[output truncated]");
		expect(r.stdout.length).toBeLessThan(64 * 1024);
		expect(Date.now() - start).toBeLessThan(8_000);
		expect(kernel.isAlive()).toBe(true);

		// Kernel still works after the flood.
		const r2 = await kernel.exec({ lang: "javascript", code: "console.log(1 + 1);", timeoutMs: 10_000 });
		expect(r2.stdout.trim()).toBe("2");
	}, 15_000);
});
