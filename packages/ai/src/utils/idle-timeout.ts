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
	const idleMs = options?.idleMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	const signal = options?.signal;
	const makeAbortError = options?.abortError ?? defaultAbortError;

	// Fast path: already aborted before we even start the read.
	if (signal?.aborted) {
		throw makeAbortError();
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;

	try {
		const readPromise = reader.read();

		const idlePromise = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				// Release the socket so the dead connection doesn't leak, then
				// surface a retryable error. Cancel rejection is ignored: the
				// reader may already be torn down.
				reader.cancel(new IdleStreamTimeoutError(idleMs)).catch(() => {});
				reject(new IdleStreamTimeoutError(idleMs));
			}, idleMs);
		});

		// Mirror the pre-existing abort semantics: aborting rejects the race with
		// the caller-supplied error, NOT the idle error, so the ESC path is
		// unchanged. We do not cancel the reader here; the caller's finally
		// (releaseLock / cancel) already owns abort teardown as it did before.
		const abortPromise = new Promise<never>((_resolve, reject) => {
			if (!signal) {
				return;
			}
			onAbort = () => reject(makeAbortError());
			signal.addEventListener("abort", onAbort, { once: true });
		});

		const racers: Array<Promise<{ done: boolean; value?: T }>> = [readPromise, idlePromise];
		if (signal) {
			racers.push(abortPromise);
		}

		return await Promise.race(racers);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		if (signal && onAbort) {
			signal.removeEventListener("abort", onAbort);
		}
	}
}
