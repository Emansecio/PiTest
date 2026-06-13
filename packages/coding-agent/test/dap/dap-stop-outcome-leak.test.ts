// Regression test for the listener/timer leak in DapSessionManager.#prepareStopOutcome.
//
// #prepareStopOutcome races three waitForEvent waiters ('stopped' / 'terminated' /
// 'exited'). When one wins (e.g. 'stopped' under fast stepping), the other two used
// to stay alive — each holding an event listener on the client AND a 30s timeout —
// until they individually expired. Under rapid stepIn/next/continue this accumulated
// orphan listeners + timers. The fix cancels the losers immediately via an internal
// AbortController, so each step leaves zero pending loser waiters/timers.
//
// We drive the real e2e path against the fake adapter and assert that after each
// step the 'terminated'/'exited' waiters created for that step have already settled
// (cleaned up), and that no loser waiter is left pending after a burst of steps.

import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DapClient } from "../../src/core/dap/client.ts";
import { type DapResolvedAdapter, dapSessionManager } from "../../src/core/dap/index.ts";

const FAKE = fileURLToPath(new URL("./fake-dap-adapter.mjs", import.meta.url));

function fakeAdapter(): DapResolvedAdapter {
	return {
		name: "fake",
		command: "node",
		args: [FAKE],
		resolvedCommand: process.execPath,
		languages: ["c"],
		fileTypes: [".c"],
		rootMarkers: [],
		launchDefaults: { stopOnEntry: true },
		attachDefaults: {},
		connectMode: "stdio",
	};
}

type WaiterRecord = { event: string; settled: boolean };

describe("DapSessionManager.#prepareStopOutcome — race losers are cancelled (no leak)", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await dapSessionManager.disposeAll();
	});

	it("cancels 'terminated'/'exited' waiters once 'stopped' wins the race", async () => {
		// Track every waitForEvent waiter and whether it has settled (resolved/rejected).
		const waiters: WaiterRecord[] = [];
		const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
		const original = DapClient.prototype.waitForEvent;
		const spy = vi.spyOn(DapClient.prototype, "waitForEvent").mockImplementation(function (
			this: DapClient,
			...args: Parameters<typeof original>
		) {
			const record: WaiterRecord = { event: args[0], settled: false };
			waiters.push(record);
			const promise = original.apply(this, args);
			promise.then(
				() => {
					record.settled = true;
				},
				() => {
					record.settled = true;
				},
			);
			return promise;
		});

		const adapter = fakeAdapter();
		const launched = await dapSessionManager.launch(
			{ adapter, program: "/x/main.c", cwd: tmpdir() },
			undefined,
			10_000,
		);
		expect(launched.status).toBe("stopped");

		// A burst of fast steps: each emits 'stopped' (the winner) from the fake adapter.
		const STEPS = 6;
		for (let i = 0; i < STEPS; i++) {
			const out = await dapSessionManager.stepIn(undefined, 10_000);
			expect(out.state).toBe("stopped");
		}

		// Let any post-settle microtasks/finally callbacks flush.
		await new Promise((r) => setTimeout(r, 20));

		// Every 'terminated' and 'exited' waiter (the race losers) must be settled —
		// i.e. cancelled by the fix rather than lingering until their 30s timeout.
		const loserWaiters = waiters.filter((w) => w.event === "terminated" || w.event === "exited");
		expect(loserWaiters.length).toBeGreaterThanOrEqual(STEPS * 2);
		const stillPending = loserWaiters.filter((w) => !w.settled);
		expect(stillPending).toHaveLength(0);

		// And the per-step race created 'stopped' waiters too; all must be settled.
		const stoppedWaiters = waiters.filter((w) => w.event === "stopped");
		expect(stoppedWaiters.every((w) => w.settled)).toBe(true);

		// clearTimeout must have fired for the cancelled loser timers (no orphan timers).
		expect(clearTimeoutSpy).toHaveBeenCalled();

		spy.mockRestore();
		await dapSessionManager.terminate();
	}, 60_000);
});
