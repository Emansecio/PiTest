import { recordDiagnostic } from "./runtime-diagnostics.ts";

// Idle-timeout watchdog for raw network stream readers.
//
// Provider SSE loops call `reader.read()` in a `while (true)` and only check
// `signal?.aborted` *before* the read. If the TCP connection goes half-open
// mid-stream (a load balancer drops it without FIN/RST, a proxy freezes, a
// local instance hangs), `reader.read()` blocks forever: the turn pends with
// no error and no retry, because the SDK's request timeout only covers
// time-to-headers, not body inactivity. This is worst in background work
// (compaction / goal / coordinator / RPC) where there is no ESC to bail out.
//
// `raceReadWithIdle` wraps a single `reader.read()` in a watchdog: each call
// races the read against a `setTimeout(idleMs)` that is rearmed on every chunk,
// so a slow-but-alive stream never trips it. If the timer wins, we cancel the
// reader (releasing the socket) and throw an error whose message matches the
// AgentSession RETRYABLE_ERROR_RE (it contains "timeout"/"timed out"), so the
// pending turn fails fast and the normal retry/fallback path takes over.

/**
 * Default idle window before a stalled body read is treated as a dead
 * connection. Deliberately high (120s) so it never false-positives on a healthy
 * but slow stream, while still bounding a truly hung socket. The slowest path is
 * a long reasoning gap with no token emitted; 120s is well past that.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/**
 * Thrown when no chunk (or `done`) arrives within the idle window. Distinct type
 * so callers/tests can tell an idle stall apart from a user abort. The message
 * intentionally contains "idle" and "timed out" so it satisfies the retryable
 * matcher in AgentSession.
 */
export class IdleStreamTimeoutError extends Error {
	readonly idleMs: number;

	constructor(idleMs: number) {
		super(`Stream idle timeout: no data received for ${idleMs}ms (connection timed out, likely a dead socket)`);
		this.name = "IdleStreamTimeoutError";
		this.idleMs = idleMs;
	}
}

export interface RaceReadWithIdleOptions {
	/** Idle window in milliseconds. Falls back to DEFAULT_IDLE_TIMEOUT_MS. */
	idleMs?: number;
	/** User abort signal. Preserves existing abort semantics (same throw). */
	signal?: AbortSignal;
	/** Error thrown when `signal` aborts. Defaults to a generic abort error. */
	abortError?: () => Error;
}

export interface RaceWithIdleAndAbortOptions extends RaceReadWithIdleOptions {
	/** Diagnostic source label for idle-timeout records. */
	idleDiagnosticSource?: string;
	/** Invoked when the idle timer wins, before rejecting. */
	onIdle?: (idleMs: number) => void;
}

// Minimal structural type so this helper works with any ReadableStream reader
// (Uint8Array bodies, mocks in tests) without importing DOM lib types.
interface IdleTimeoutReader<T> {
	read(): Promise<{ done: boolean; value?: T }>;
	cancel(reason?: unknown): Promise<void>;
}

function defaultAbortError(): Error {
	return new Error("Request was aborted");
}

/**
 * Race `promise` against an idle watchdog and an optional user abort signal.
 * Shared primitive for {@link raceReadWithIdle} and {@link iterateWithIdleTimeout}.
 */
const abortRaceBySignal = new WeakMap<AbortSignal, Promise<never>>();

function sharedAbortRace(signal: AbortSignal, makeAbortError: () => Error): Promise<never> {
	let race = abortRaceBySignal.get(signal);
	if (!race) {
		race = new Promise<never>((_resolve, reject) => {
			const onAbort = () => reject(makeAbortError());
			signal.addEventListener("abort", onAbort, { once: true });
		});
		abortRaceBySignal.set(signal, race);
	}
	return race;
}

export async function raceWithIdleAndAbort<T>(promise: Promise<T>, options?: RaceWithIdleAndAbortOptions): Promise<T> {
	const idleMs = options?.idleMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	const signal = options?.signal;
	const makeAbortError = options?.abortError ?? defaultAbortError;

	if (signal?.aborted) {
		throw makeAbortError();
	}

	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		promise.catch(() => {});

		const idlePromise = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				options?.onIdle?.(idleMs);
				recordDiagnostic({
					category: "stream.idle-timeout",
					level: "warn",
					source: options?.idleDiagnosticSource ?? "idle-timeout.raceWithIdleAndAbort",
					context: { ms: idleMs },
				});
				reject(new IdleStreamTimeoutError(idleMs));
			}, idleMs);
		});

		const racers: Array<Promise<T>> = [promise, idlePromise];
		if (signal) {
			racers.push(sharedAbortRace(signal, makeAbortError));
		}

		return await Promise.race(racers);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

/**
 * Run a single `reader.read()` under an idle watchdog.
 *
 * Behavior on a healthy stream is identical to a bare `await reader.read()`:
 * the timer is cleared the instant a chunk (or `done`) resolves, so it never
 * fires. The watchdog only changes the pathological path where the read never
 * settles.
 *
 * - Timer wins  -> cancel the reader (free the socket) and throw IdleStreamTimeoutError.
 * - signal fires -> throw `abortError()` (same error the caller threw before).
 * - read settles -> return the chunk; the timer is always cleared (try/finally).
 *
 * The setTimeout handle is cleared on every exit path (chunk, done, error,
 * abort). A dangling timer would keep the Node event loop alive and hang
 * headless runs / tests, so cleanup is mandatory, not best-effort.
 */
export async function raceReadWithIdle<T>(
	reader: IdleTimeoutReader<T>,
	options?: RaceReadWithIdleOptions,
): Promise<{ done: boolean; value?: T }> {
	try {
		return await raceWithIdleAndAbort(reader.read(), {
			...options,
			idleDiagnosticSource: "idle-timeout.raceReadWithIdle",
		});
	} catch (err) {
		if (err instanceof IdleStreamTimeoutError) {
			await reader.cancel(err).catch(() => {});
		}
		throw err;
	}
}

/**
 * Thrown when a whole model round exceeds its wall-clock budget. Distinct from
 * {@link IdleStreamTimeoutError}: the idle watchdog rearms on every chunk, so a
 * stream kept alive by pings/keepalives (or sparse deltas) can pend for many
 * minutes without ever tripping it — this error is the non-rearming upper bound.
 * The message intentionally contains "timed out" so it satisfies the retryable
 * matcher in AgentSession and takes the normal retry/fallback path.
 */
export class RoundWallClockTimeoutError extends Error {
	readonly wallClockMs: number;

	constructor(wallClockMs: number) {
		super(
			`Model round wall-clock timeout: stream did not complete within ${wallClockMs}ms (round timed out; the stream was cancelled)`,
		);
		this.name = "RoundWallClockTimeoutError";
		this.wallClockMs = wallClockMs;
	}
}

export interface IterateWithWallClockOptions {
	/** Wall-clock budget for the whole iteration, in milliseconds. */
	wallClockMs: number;
	/** Invoked once when the deadline fires, before the error is thrown (e.g. abort the stream). */
	onTimeout?: (wallClockMs: number) => void;
}

/**
 * Wall-clock watchdog for a `for await` over an async iterable. Unlike
 * {@link iterateWithIdleTimeout}, the timer is armed ONCE for the entire
 * iteration and never rearmed: a healthy-but-endless stream (keepalives, sparse
 * deltas) still hits the deadline. When it fires, `onTimeout` runs (callers
 * abort the underlying request there), the iterator is torn down fire-and-forget
 * (same rationale as iterateWithIdleTimeout's finally), and a retryable
 * {@link RoundWallClockTimeoutError} is thrown.
 *
 * The timer is unref'd so it never keeps the event loop alive, and cleared on
 * every exit path.
 */
export async function* iterateWithWallClock<T>(
	iterable: AsyncIterable<T>,
	options: IterateWithWallClockOptions,
): AsyncGenerator<T> {
	const { wallClockMs, onTimeout } = options;
	const iterator = iterable[Symbol.asyncIterator]();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			onTimeout?.(wallClockMs);
			recordDiagnostic({
				category: "stream.wall-clock-timeout",
				level: "warn",
				source: "idle-timeout.iterateWithWallClock",
				context: { ms: wallClockMs },
			});
			reject(new RoundWallClockTimeoutError(wallClockMs));
		}, wallClockMs);
		(timer as { unref?: () => void }).unref?.();
	});
	// The race below may finish (stream done) before the deadline ever fires; a
	// later rejection with no listener would be an unhandled rejection. clearTimeout
	// in the finally prevents the late fire, and this no-op handler covers the
	// window where the timer fires while the consumer is between next() calls.
	deadline.catch(() => {});

	try {
		while (true) {
			const next = iterator.next();
			// Swallow a late rejection from a next() the deadline outraced (the
			// aborted request may reject it after we have already thrown).
			next.catch(() => {});
			const result = await Promise.race([next, deadline]);
			if (result.done) {
				return;
			}
			yield result.value;
		}
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		// Same protocol hazard as iterateWithIdleTimeout: return() queues behind a
		// pending next(), so awaiting it here could block forever. Fire-and-forget.
		try {
			const ret = iterator.return?.();
			if (ret && typeof (ret as Promise<unknown>).then === "function") {
				(ret as Promise<unknown>).then(undefined, () => {});
			}
		} catch {
			// iterator may already be torn down
		}
	}
}

/**
 * Idle watchdog for a `for await` over an async iterable (e.g. an SDK stream like
 * the OpenAI/Google clients return, which expose `[Symbol.asyncIterator]` rather
 * than a raw `reader.read()`). Same guarantee as {@link raceReadWithIdle}: each
 * `iterator.next()` is raced against a per-step timer rearmed on every item, so a
 * slow-but-alive stream never trips it, but a half-open socket that stalls
 * `.next()` forever throws a retryable {@link IdleStreamTimeoutError} instead of
 * hanging the turn. On idle/abort it calls the iterator's `return()` to abort the
 * underlying request and free the socket.
 *
 * Behavior on a healthy stream is identical to a bare `for await` (the timer is
 * cleared the instant each item resolves).
 */
export async function* iterateWithIdleTimeout<T>(
	iterable: AsyncIterable<T>,
	options?: RaceReadWithIdleOptions,
): AsyncGenerator<T> {
	const idleMs = options?.idleMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	const signal = options?.signal;
	const makeAbortError = options?.abortError ?? defaultAbortError;
	const iterator = iterable[Symbol.asyncIterator]();

	try {
		while (true) {
			if (signal?.aborted) {
				throw makeAbortError();
			}
			const result = await raceWithIdleAndAbort(iterator.next(), {
				idleMs,
				signal,
				abortError: makeAbortError,
				idleDiagnosticSource: "idle-timeout.iterateWithIdleTimeout",
			});
			if (result.done) {
				return;
			}
			yield result.value;
		}
	} finally {
		// Idle stall, abort, or an early `break` in the consumer: ask the underlying
		// iterator to tear down (the SDK streams' return() aborts the request and frees
		// the socket). Best-effort — never throw out of cleanup.
		//
		// CRITICAL: do NOT `await` return() here. By the async-iterator protocol,
		// return() is queued behind any still-pending next(); on a frozen socket that
		// next() never settles, so an awaited return() would block this finally
		// forever — swallowing the idle/abort error before it reaches the caller and
		// wedging the whole turn (the spinner counts up, ESC/Ctrl+C become no-ops
		// because the run signal is already aborted). Fire-and-forget instead so the
		// idle/abort rejection propagates immediately; the underlying request is torn
		// down via its own abort signal regardless.
		try {
			const ret = iterator.return?.();
			if (ret && typeof (ret as Promise<unknown>).then === "function") {
				(ret as Promise<unknown>).then(undefined, () => {});
			}
		} catch {
			// iterator may already be torn down
		}
	}
}
