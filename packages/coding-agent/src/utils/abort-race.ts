/**
 * Race a promise against an abort signal so a user interrupt (Esc / Ctrl+C) can
 * always unblock the run loop — even when the awaited work ignores the signal.
 *
 * The agent loop awaits several extension-hook boundaries (`transformContext`,
 * `beforeToolCall`, `afterToolCall`). Those hooks fan out to arbitrary handlers
 * (grounding firewall, verification, patch audit, coordinator, third-party
 * extensions) that do NOT receive the run signal, so a handler parked on a slow
 * IO / network / subprocess await would wedge the whole turn: the loop never
 * settles, `isStreaming` stays true, the spinner counts up forever, and ESC
 * becomes a no-op (the run signal is already aborted). Racing the boundary
 * guarantees the loop proceeds the instant the user aborts.
 *
 * On abort we DETACH the hook (it keeps running in the background) rather than
 * trying to cancel it — the turn is being torn down anyway, so its result is
 * irrelevant. The abandoned promise's eventual rejection is swallowed so it can
 * never surface as an unhandledRejection.
 *
 * When `signal` is undefined or never fires, behavior is identical to awaiting
 * `promise` directly.
 */
export function settleOrAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	makeAbortError: () => Error = () => new Error("Request was aborted"),
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		// Detach the in-flight hook and swallow any later rejection.
		promise.then(undefined, () => {});
		return Promise.reject(makeAbortError());
	}

	let onAbort: (() => void) | undefined;
	const abortPromise = new Promise<never>((_resolve, reject) => {
		onAbort = () => {
			// The hook keeps running detached; swallow a later rejection.
			promise.then(undefined, () => {});
			reject(makeAbortError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});

	return Promise.race([promise, abortPromise]).finally(() => {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	});
}
