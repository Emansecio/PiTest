// Connect-phase guard for streaming providers that await
// `client.…create(params).withResponse()` before the first chunk is pushed.
//
// That await covers time-to-headers PLUS the SDK's internal retry/backoff. The
// SDK gets the user's AbortSignal, but a half-open connect (a local proxy that
// accepts the socket then freezes, a load balancer that drops without FIN) or a
// retry-backoff sleep can keep it pending far longer than a frame — and during
// that window ESC is a no-op: nothing is pushed to the event stream, so the
// agent loop's `for await` over the provider stream never unwinds, isStreaming
// stays true, the spinner counts up, and the TUI interrupt-watchdog fires
// ("Interrupt didn't take effect"). The body loop is already covered by
// iterateWithIdleTimeout; this closes the symmetric hole on the connect await.
//
// The guard does two things, independent of SDK internals:
//   1. Passes a COMBINED signal (user-abort ∪ connect-timer) to the SDK so the
//      real socket is torn down on either trigger.
//   2. Races the connect await against the user abort so OUR await rejects the
//      instant the user interrupts — even if the SDK is mid-backoff and slow to
//      observe the signal. The orphaned create() is detached and its later
//      rejection swallowed.

/** Default connect-phase ceiling. Matches the Codex provider's connect timeout.
 * High enough to never false-positive a healthy-but-slow handshake, low enough
 * to bound a dead connect in background work (compaction/goal) with no ESC. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

export interface ConnectGuard {
	/** Combined signal to hand the SDK as `requestOptions.signal`. Aborts on user
	 * interrupt or connect timeout. Valid for the whole request (connect + body). */
	readonly signal: AbortSignal;
	/**
	 * Await the connect promise under the guard. Resolves with its value, or
	 * rejects promptly on user abort (generic abort error) / connect timeout (a
	 * retryable "timed out" error). Clears the connect timer on settle; the
	 * user-abort forwarding stays armed for the body phase until {@link dispose}.
	 */
	settle<T>(promise: Promise<T>): Promise<T>;
	/**
	 * Re-arm the single-shot connect timer for a FOLLOW-UP connect on the same
	 * guard (e.g. a provider retry after a 400). The first {@link settle} clears
	 * the timer in its finally, so a second connect would otherwise run with no
	 * ceiling and fall back to the SDK's multi-minute default — a frozen retry
	 * connect would wedge the turn just like the first. No-op once the guard has
	 * already aborted (user interrupt or a prior connect timeout), so a re-armed
	 * timer can never resurrect a torn-down request. Does not change the
	 * non-retry path: callers that never re-arm behave exactly as before.
	 */
	rearm(): void;
	/** Remove all listeners + timers. Call once when the stream fully ends. */
	dispose(): void;
}

function abortError(): Error {
	return new Error("Request was aborted");
}

function connectTimeoutError(ms: number): Error {
	return new Error(`Provider connect timed out after ${ms}ms (connection timed out, likely a dead socket)`);
}

/**
 * Create a connect guard for a single streaming request. `connectTimeoutMs`
 * falls back to {@link DEFAULT_CONNECT_TIMEOUT_MS}.
 */
export function createConnectGuard(
	userSignal: AbortSignal | undefined,
	connectTimeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
): ConnectGuard {
	const controller = new AbortController();
	let timedOut = false;

	const onUserAbort = (): void => {
		controller.abort(userSignal?.reason ?? abortError());
	};
	if (userSignal?.aborted) {
		controller.abort(userSignal.reason ?? abortError());
	} else {
		userSignal?.addEventListener("abort", onUserAbort, { once: true });
	}

	let connectTimer: ReturnType<typeof setTimeout> | undefined;
	const armConnectTimer = (): void => {
		connectTimer = setTimeout(() => {
			timedOut = true;
			controller.abort(new Error(`Provider connect timed out after ${connectTimeoutMs}ms`));
		}, connectTimeoutMs);
	};
	const clearConnectTimer = (): void => {
		if (connectTimer !== undefined) {
			clearTimeout(connectTimer);
			connectTimer = undefined;
		}
	};
	armConnectTimer();

	return {
		signal: controller.signal,
		async settle<T>(promise: Promise<T>): Promise<T> {
			// Race the connect await against the COMBINED signal (user abort ∪ connect
			// timer). Reacting to the controller directly — not just the user signal —
			// means a timeout unblocks us even if the SDK is slow to observe its
			// signal, and an ESC unblocks us instantly mid-retry-backoff.
			let onRaceAbort: (() => void) | undefined;
			const abortRace = new Promise<never>((_resolve, reject) => {
				if (controller.signal.aborted) {
					reject(timedOut ? connectTimeoutError(connectTimeoutMs) : abortError());
					return;
				}
				onRaceAbort = () => reject(timedOut ? connectTimeoutError(connectTimeoutMs) : abortError());
				controller.signal.addEventListener("abort", onRaceAbort, { once: true });
			});
			try {
				return await Promise.race([promise, abortRace]);
			} catch (err) {
				// Detach the in-flight create so a later rejection on the orphaned
				// request never surfaces as an unhandledRejection.
				promise.then(undefined, () => {});
				if (timedOut) throw connectTimeoutError(connectTimeoutMs);
				throw err;
			} finally {
				clearConnectTimer();
				if (onRaceAbort) controller.signal.removeEventListener("abort", onRaceAbort);
			}
		},
		rearm(): void {
			// A torn-down request (user ESC or a prior connect timeout already
			// aborted the combined signal) must stay torn down.
			if (controller.signal.aborted) return;
			clearConnectTimer();
			armConnectTimer();
		},
		dispose(): void {
			clearConnectTimer();
			if (userSignal) userSignal.removeEventListener("abort", onUserAbort);
		},
	};
}
