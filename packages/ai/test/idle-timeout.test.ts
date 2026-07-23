import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_IDLE_TIMEOUT_MS,
	IdleStreamTimeoutError,
	iterateWithIdleTimeout,
	iterateWithWallClock,
	RoundWallClockTimeoutError,
	raceReadWithIdle,
} from "../src/utils/idle-timeout.js";

// A controllable fake reader over a queue of chunks. Each read() resolves with
// the next chunk; once the queue is drained it can either hang forever (to
// simulate a half-open socket) or resolve done.
type ReadResult<T> = { done: boolean; value?: T };

function hangingReader(): {
	read(): Promise<ReadResult<Uint8Array>>;
	cancel(reason?: unknown): Promise<void>;
	canceled: boolean;
} {
	const reader = {
		canceled: false,
		read(): Promise<ReadResult<Uint8Array>> {
			// Never resolves: models a frozen connection.
			return new Promise<ReadResult<Uint8Array>>(() => {});
		},
		cancel(_reason?: unknown): Promise<void> {
			reader.canceled = true;
			return Promise.resolve();
		},
	};
	return reader;
}

function scriptedReader(steps: Array<{ delayMs: number; value?: Uint8Array; done?: boolean }>): {
	read(): Promise<ReadResult<Uint8Array>>;
	cancel(reason?: unknown): Promise<void>;
	canceled: boolean;
} {
	let i = 0;
	const reader = {
		canceled: false,
		read(): Promise<ReadResult<Uint8Array>> {
			const step = steps[i];
			i += 1;
			if (!step) {
				return Promise.resolve({ done: true });
			}
			return new Promise<ReadResult<Uint8Array>>((resolve) => {
				setTimeout(() => {
					if (step.done) {
						resolve({ done: true });
					} else {
						resolve({ done: false, value: step.value });
					}
				}, step.delayMs);
			});
		},
		cancel(_reason?: unknown): Promise<void> {
			reader.canceled = true;
			return Promise.resolve();
		},
	};
	return reader;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("raceReadWithIdle", () => {
	it("default idle window is 120s", () => {
		expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(120_000);
	});

	it("(1) throws a retryable idle error when the read stalls past idleMs", async () => {
		const reader = hangingReader();
		const start = Date.now();

		await expect(raceReadWithIdle(reader, { idleMs: 50 })).rejects.toBeInstanceOf(IdleStreamTimeoutError);

		const elapsed = Date.now() - start;
		// Fired roughly at idleMs, not hanging forever.
		expect(elapsed).toBeLessThan(2000);
		// Socket was released.
		expect(reader.canceled).toBe(true);
	});

	it("(1b) idle error message matches the AgentSession RETRYABLE_ERROR_RE", async () => {
		const reader = hangingReader();
		// Same regex as packages/coding-agent/src/core/agent-session.ts.
		const RETRYABLE_ERROR_RE =
			/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

		let err: Error | undefined;
		try {
			await raceReadWithIdle(reader, { idleMs: 30 });
		} catch (e) {
			err = e as Error;
		}
		expect(err).toBeInstanceOf(IdleStreamTimeoutError);
		expect(RETRYABLE_ERROR_RE.test(err?.message ?? "")).toBe(true);
	});

	it("(2) does NOT fire for a slow but alive stream and delivers every chunk", async () => {
		const idleMs = 60;
		// Chunks arrive every idleMs/2 — alive, must never trip the watchdog.
		const reader = scriptedReader([
			{ delayMs: idleMs / 2, value: new Uint8Array([1]) },
			{ delayMs: idleMs / 2, value: new Uint8Array([2]) },
			{ delayMs: idleMs / 2, value: new Uint8Array([3]) },
			{ delayMs: idleMs / 2, done: true },
		]);

		const received: number[] = [];
		for (;;) {
			const { done, value } = await raceReadWithIdle(reader, { idleMs });
			if (done) break;
			if (value) received.push(value[0]!);
		}

		expect(received).toEqual([1, 2, 3]);
		expect(reader.canceled).toBe(false);
	});

	it("(3) throws the abort error (not the idle error) and clears the timer", async () => {
		const reader = hangingReader();
		const controller = new AbortController();
		const clearSpy = vi.spyOn(globalThis, "clearTimeout");
		const setSpy = vi.spyOn(globalThis, "setTimeout");

		const abortMarker = new Error("aborted-by-user-sentinel");
		const promise = raceReadWithIdle(reader, {
			idleMs: 10_000, // long, so idle never wins the race
			signal: controller.signal,
			abortError: () => abortMarker,
		});

		// Abort mid-read.
		controller.abort();

		await expect(promise).rejects.toBe(abortMarker);
		// Every timer the helper armed was cleared (no dangling handle).
		expect(clearSpy).toHaveBeenCalledTimes(setSpy.mock.results.length);
		// Idle path did not cancel the reader; abort teardown belongs to the caller.
		expect(reader.canceled).toBe(false);
	});

	it("(3b) pre-aborted signal throws abort error without arming a timer", async () => {
		const reader = hangingReader();
		const controller = new AbortController();
		controller.abort();
		const setSpy = vi.spyOn(globalThis, "setTimeout");

		const abortMarker = new Error("pre-aborted-sentinel");
		await expect(
			raceReadWithIdle(reader, { idleMs: 50, signal: controller.signal, abortError: () => abortMarker }),
		).rejects.toBe(abortMarker);
		expect(setSpy).not.toHaveBeenCalled();
	});

	it("(4) a normal completing read leaves no idle timer pending", async () => {
		const reader = scriptedReader([
			{ delayMs: 1, value: new Uint8Array([42]) },
			{ delayMs: 1, done: true },
		]);
		const idleMs = 5000;
		const setSpy = vi.spyOn(globalThis, "setTimeout");
		const clearSpy = vi.spyOn(globalThis, "clearTimeout");

		const first = await raceReadWithIdle(reader, { idleMs });
		expect(first.value?.[0]).toBe(42);
		const second = await raceReadWithIdle(reader, { idleMs });
		expect(second.done).toBe(true);

		// Count only the watchdog timers (delay === idleMs); the scriptedReader
		// arms its own short delay timers which are not the helper's concern.
		const idleArmed = setSpy.mock.calls.filter((call) => call[1] === idleMs);
		const idleHandles = new Set(
			setSpy.mock.results.filter((_r, i) => setSpy.mock.calls[i]?.[1] === idleMs).map((r) => r.value),
		);
		const idleCleared = clearSpy.mock.calls.filter((call) => idleHandles.has(call[0]));
		// One watchdog armed per read, and every one was cleared (no leak).
		expect(idleArmed.length).toBe(2);
		expect(idleCleared.length).toBe(idleArmed.length);
		expect(reader.canceled).toBe(false);
	});
});

describe("iterateWithIdleTimeout", () => {
	// Models a real SDK stream (an async generator) whose body is parked on a
	// never-resolving await: next() hangs forever, and — by the async-iterator
	// protocol — return() is QUEUED behind that pending next(), so it never settles
	// either. This is the exact shape of a frozen-socket OpenAI/GLM/Google stream.
	function frozenAsyncIterable(): { iterable: AsyncIterable<number>; returnCalled: () => boolean } {
		let returnCalled = false;
		async function* gen(): AsyncGenerator<number> {
			try {
				// Park forever: the SDK is blocked on a dead-socket read.
				await new Promise<void>(() => {});
				yield 1;
			} finally {
				returnCalled = true;
			}
		}
		const it = gen();
		return { iterable: it, returnCalled: () => returnCalled };
	}

	it("(5) idle stall rejects promptly even when iterator.return() is wedged behind a frozen next()", async () => {
		const { iterable } = frozenAsyncIterable();
		const start = Date.now();

		await expect(
			(async () => {
				for await (const _ of iterateWithIdleTimeout(iterable, { idleMs: 40 })) {
					// no chunk ever arrives
				}
			})(),
		).rejects.toBeInstanceOf(IdleStreamTimeoutError);

		// Must NOT hang on the queued return(); fires roughly at idleMs.
		expect(Date.now() - start).toBeLessThan(2000);
	});

	it("(6) abort rejects promptly even when iterator.return() is wedged behind a frozen next()", async () => {
		const { iterable } = frozenAsyncIterable();
		const controller = new AbortController();
		const abortMarker = new Error("aborted-by-user-sentinel");

		const consume = (async () => {
			for await (const _ of iterateWithIdleTimeout(iterable, {
				idleMs: 10_000, // long, so only the abort can win
				signal: controller.signal,
				abortError: () => abortMarker,
			})) {
				// no chunk ever arrives
			}
		})();

		controller.abort();

		const start = Date.now();
		await expect(consume).rejects.toBe(abortMarker);
		// The ESC path: aborts immediately, not stuck behind the dead next()/return().
		expect(Date.now() - start).toBeLessThan(2000);
	});

	it("(7) delivers every chunk for a slow-but-alive stream and never trips", async () => {
		async function* gen(): AsyncGenerator<number> {
			for (const v of [1, 2, 3]) {
				await new Promise((r) => setTimeout(r, 20));
				yield v;
			}
		}
		const received: number[] = [];
		for await (const v of iterateWithIdleTimeout(gen(), { idleMs: 200 })) {
			received.push(v);
		}
		expect(received).toEqual([1, 2, 3]);
	});
});

describe("iterateWithWallClock", () => {
	it("(8) fires even when chunks keep arriving — the keepalive-forever case idle can't catch", async () => {
		// Yields every 10ms forever: rearming idle would never trip, the wall
		// clock must.
		async function* keepalive(): AsyncGenerator<number> {
			let n = 0;
			while (true) {
				await new Promise((r) => setTimeout(r, 10));
				yield n++;
			}
		}
		let timedOutMs: number | undefined;
		const received: number[] = [];
		const start = Date.now();

		await expect(
			(async () => {
				for await (const v of iterateWithWallClock(keepalive(), {
					wallClockMs: 80,
					onTimeout: (ms) => {
						timedOutMs = ms;
					},
				})) {
					received.push(v);
				}
			})(),
		).rejects.toBeInstanceOf(RoundWallClockTimeoutError);

		expect(Date.now() - start).toBeLessThan(2000);
		// Chunks flowed until the deadline (the guard is a ceiling, not a gate).
		expect(received.length).toBeGreaterThan(0);
		expect(timedOutMs).toBe(80);
	});

	it("(8b) wall-clock error message matches the AgentSession RETRYABLE_ERROR_RE", () => {
		const RETRYABLE_ERROR_RE =
			/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;
		expect(RETRYABLE_ERROR_RE.test(new RoundWallClockTimeoutError(600_000).message)).toBe(true);
	});

	it("(9) rejects promptly on a frozen stream even with return() wedged behind next()", async () => {
		async function* frozen(): AsyncGenerator<number> {
			await new Promise<void>(() => {});
			yield 1;
		}
		const start = Date.now();
		await expect(
			(async () => {
				for await (const _ of iterateWithWallClock(frozen(), { wallClockMs: 40 })) {
					// no chunk ever arrives
				}
			})(),
		).rejects.toBeInstanceOf(RoundWallClockTimeoutError);
		expect(Date.now() - start).toBeLessThan(2000);
	});

	it("(10) a stream that completes within budget passes through untouched and clears its timer", async () => {
		async function* gen(): AsyncGenerator<number> {
			for (const v of [1, 2, 3]) {
				await new Promise((r) => setTimeout(r, 5));
				yield v;
			}
		}
		const wallClockMs = 5000;
		const setSpy = vi.spyOn(globalThis, "setTimeout");
		const clearSpy = vi.spyOn(globalThis, "clearTimeout");

		const received: number[] = [];
		for await (const v of iterateWithWallClock(gen(), { wallClockMs })) {
			received.push(v);
		}
		expect(received).toEqual([1, 2, 3]);

		// Exactly one wall-clock timer armed for the whole iteration (non-rearming),
		// and it was cleared (no dangling handle).
		const armed = setSpy.mock.calls.filter((call) => call[1] === wallClockMs);
		expect(armed.length).toBe(1);
		const handles = new Set(
			setSpy.mock.results.filter((_r, i) => setSpy.mock.calls[i]?.[1] === wallClockMs).map((r) => r.value),
		);
		const cleared = clearSpy.mock.calls.filter((call) => handles.has(call[0]));
		expect(cleared.length).toBe(1);
	});
});
