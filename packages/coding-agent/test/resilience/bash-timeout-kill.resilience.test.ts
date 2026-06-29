/**
 * Resilience (fault-injection) — BASH TOOL layer, end-to-end under a real child.
 *
 * Scenario 3: a bash command blocks (here `sleep 60`) past its timeout. The tool
 * must (a) kill the process tree and reject with a `timeout:<n>` error instead of
 * hanging the turn, and (b) surface the forced kill on the observable
 * `runtime-diagnostics` channel as `process.kill` — otherwise an autonomous run
 * has no record that a hung command was reaped.
 *
 * Anti-flaky: the timeout is injected MINUSCULE (0.05s = 50ms) via the tool's
 * own `timeout` param. The watched command would sleep for 60s, so the ONLY way
 * exec settles in time is the kill path firing — the test can't pass by the
 * command finishing on its own. Recovery is observed on the process-exit event
 * (waitForChildProcess), not by a real sleep or poll in the test. The 50ms timer
 * is the kill mechanism, not a wait. Guarded by a bash-availability check so a
 * machine without Git Bash skips rather than flakes.
 */

import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalBashOperations } from "../../src/core/tools/bash.ts";
import { getShellConfig } from "../../src/utils/shell.ts";

function hasBash(): boolean {
	try {
		getShellConfig();
		return true;
	} catch {
		return false;
	}
}

const BASH_AVAILABLE = hasBash();

describe("resilience: bash timeout → process.kill + observable diagnostic", () => {
	beforeEach(() => {
		resetRuntimeDiagnostics();
	});

	afterEach(() => {
		resetRuntimeDiagnostics();
	});

	it.skipIf(!BASH_AVAILABLE)(
		"(3) a command that blocks past its timeout is killed and records process.kill",
		async () => {
			const ops = createLocalBashOperations();
			const start = Date.now();
			let sawData = false;

			// `sleep 60` would exceed the test budget; the 50ms timeout must reap it first.
			await expect(
				ops.exec("sleep 60", process.cwd(), {
					timeout: 0.05,
					onData: () => {
						sawData = true;
					},
				}),
			).rejects.toThrow(/timeout/i);

			// (a) recovery beat the watched command; it did not run to 60s.
			expect(Date.now() - start).toBeLessThan(15_000);
			// The watched command produced no output before being killed.
			expect(sawData).toBe(false);

			// (b) the forced kill is observable on the runtime-diagnostics channel.
			const snap = getRuntimeDiagnostics();
			expect(snap.counters["process.kill"]?.count ?? 0).toBeGreaterThanOrEqual(1);
			expect(snap.counters["process.kill"]?.level).toBe("warn");
			// The recorded event names the bash-timeout source and carries the pid.
			const killEvent = snap.recent.find((e) => e.category === "process.kill" && e.source === "bash.timeout");
			expect(killEvent).toBeDefined();
			expect(typeof killEvent?.context?.pid).toBe("number");
		},
		20_000,
	);

	it.skipIf(!BASH_AVAILABLE)(
		"(3b) a fast command under the timeout completes normally and records no kill",
		async () => {
			const ops = createLocalBashOperations();
			const { exitCode } = await ops.exec("echo hi", process.cwd(), {
				timeout: 10,
				onData: () => undefined,
			});
			expect(exitCode).toBe(0);
			expect(getRuntimeDiagnostics().counters["process.kill"]?.count ?? 0).toBe(0);
		},
		15_000,
	);
});
