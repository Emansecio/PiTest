/**
 * Resilience (fault-injection) — STREAM layer.
 *
 * Scenario 1: a provider SSE body goes half-open mid-stream (a load balancer
 * drops the socket without FIN/RST, a proxy freezes). `reader.read()` then never
 * settles and the turn would pend forever. The `raceReadWithIdle` watchdog must
 * (a) trip after the idle window with a *retryable* IdleStreamTimeoutError,
 * (b) cancel the reader so the dead socket is released, and (c) surface the
 * fault on the observable `runtime-diagnostics` channel as `stream.idle-timeout`
 * so an autonomous run (goal / coordinator / RPC headless, no ESC, no stderr)
 * can still see it.
 *
 * Anti-flaky: fake timers drive the idle window — `advanceTimersByTimeAsync`
 * fires the watchdog deterministically with zero wall-clock dependence. The
 * reader's `read()` returns a Promise that NEVER resolves, so the ONLY way the
 * race settles is the timer we control. No real sleep, no polling.
 */

import { getRuntimeDiagnostics, IdleStreamTimeoutError, raceReadWithIdle, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ReadResult<T> = { done: boolean; value?: T };

// A reader whose read() never settles — models a frozen half-open socket. The
// watchdog timer is the only thing that can end the race.
function hangingReader(): {
	read(): Promise<ReadResult<Uint8Array>>;
	cancel(reason?: unknown): Promise<void>;
	canceled: boolean;
	cancelReason: unknown;
} {
	const reader = {
		canceled: false,
		cancelReason: undefined as unknown,
		read(): Promise<ReadResult<Uint8Array>> {
			return new Promise<ReadResult<Uint8Array>>(() => {});
		},
		cancel(reason?: unknown): Promise<void> {
			reader.canceled = true;
			reader.cancelReason = reason;
			return Promise.resolve();
		},
	};
	return reader;
}

describe("resilience: stream idle-timeout → retryable error + observable diagnostic", () => {
	beforeEach(() => {
		resetRuntimeDiagnostics();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("(1) a stalled body read trips the watchdog, cancels the socket, and records stream.idle-timeout", async () => {
		const reader = hangingReader();
		const idleMs = 20;

		// Kick off the race; assert on its rejection. We attach the expectation
		// before advancing timers so the rejection is awaited, not unhandled.
		const settled = raceReadWithIdle(reader, { idleMs });
		const assertion = expect(settled).rejects.toBeInstanceOf(IdleStreamTimeoutError);

		// Drive the idle window deterministically — this fires the watchdog.
		await vi.advanceTimersByTimeAsync(idleMs);
		await assertion;

		// (a) retryable error whose message matches the AgentSession retry matcher.
		let err: Error | undefined;
		try {
			const r2 = raceReadWithIdle(hangingReader(), { idleMs });
			const a2 = expect(r2).rejects.toBeInstanceOf(IdleStreamTimeoutError);
			await vi.advanceTimersByTimeAsync(idleMs);
			await a2;
			await r2;
		} catch (e) {
			err = e as Error;
		}
		expect(err).toBeInstanceOf(IdleStreamTimeoutError);
		expect(err?.message ?? "").toMatch(/timeout|timed out/i);

		// (b) the reader was canceled → the dead socket is released, not leaked.
		expect(reader.canceled).toBe(true);
		expect(reader.cancelReason).toBeInstanceOf(IdleStreamTimeoutError);

		// (c) the fault is observable on the runtime-diagnostics channel.
		const snap = getRuntimeDiagnostics();
		expect(snap.counters["stream.idle-timeout"]?.count ?? 0).toBeGreaterThanOrEqual(1);
		expect(snap.counters["stream.idle-timeout"]?.level).toBe("warn");
		// The recorded context carries the idle window for a /diagnostics one-liner.
		expect(snap.counters["stream.idle-timeout"]?.lastContext?.ms).toBe(idleMs);
		// And it lands in the recent ring as a concrete, inspectable event.
		expect(snap.recent.some((e) => e.category === "stream.idle-timeout")).toBe(true);
	});

	it("(1b) a healthy slow-but-alive stream NEVER trips the watchdog and emits no diagnostic", async () => {
		// read() resolves a chunk well within the idle window on every call — the
		// watchdog must be rearmed and cleared each time, never firing.
		const chunks = [new Uint8Array([1]), new Uint8Array([2])];
		let i = 0;
		const reader = {
			canceled: false,
			read(): Promise<ReadResult<Uint8Array>> {
				const value = chunks[i];
				i += 1;
				if (!value) return Promise.resolve({ done: true });
				return Promise.resolve({ done: false, value });
			},
			cancel(): Promise<void> {
				reader.canceled = true;
				return Promise.resolve();
			},
		};
		const idleMs = 50;

		const got: number[] = [];
		for (;;) {
			const { done, value } = await raceReadWithIdle(reader, { idleMs });
			if (done) break;
			if (value) got.push(value[0] as number);
		}

		expect(got).toEqual([1, 2]);
		expect(reader.canceled).toBe(false);
		// No fault recorded on the healthy path.
		expect(getRuntimeDiagnostics().counters["stream.idle-timeout"]?.count ?? 0).toBe(0);
	});
});
