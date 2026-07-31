/**
 * Push notification of `textDocument/publishDiagnostics` arrivals.
 *
 * `publishDiagnostics` reaches us as a server-initiated notification (see
 * `routeMessage` in client.ts), yet every diagnostics wait used to discover it by
 * polling on a 100ms sleep — paying ~50ms of dead time on average per wait even
 * when the publish had already landed. Writethrough performs two such waits per
 * edit, so the tax was paid twice on the critical path of every write.
 *
 * This registry lets a waiter subscribe to the client's publish stream and be
 * woken the instant the reader thread stores a publish. It lives in its own
 * module (rather than as an `LspClient` field) so `utils.ts` — which owns the
 * wait — and `client.ts` — which owns the reader — can share it without an
 * import cycle, and so no fake client in a test needs a new field.
 *
 * Keyed by a WeakMap: a shut-down client drops its listener set with the object.
 */

import type { LspClient } from "./types.ts";

type DiagnosticsListener = () => void;

const listeners = new WeakMap<LspClient, Set<DiagnosticsListener>>();

// Servers publish in bursts: gopls and friends answer one didChange with the
// edited file's diagnostics AND its package siblings', as separate notifications
// in the same read. Waking on the first frame would resolve the edited-file wait
// before the sibling frames are routed — and the cross-file appendix reads
// "whatever is in the map at collection time", so it would silently go empty.
// The old 100ms poll hid this by never looking until long after the burst. So
// the reader opens a batch around a drain pass and the wake is deferred to its
// end: still same-tick, but the waiter always observes a whole read's worth.
const openBatches = new WeakSet<LspClient>();
const deferredWakes = new WeakSet<LspClient>();

/** Called by the message reader before routing a parsed batch of frames. */
export function beginDiagnosticsBatch(client: LspClient): void {
	openBatches.add(client);
}

/** Called by the message reader once the batch is fully routed; flushes any wake. */
export function endDiagnosticsBatch(client: LspClient): void {
	openBatches.delete(client);
	if (deferredWakes.delete(client)) wakeListeners(client);
}

function wakeListeners(client: LspClient): void {
	const set = listeners.get(client);
	if (!set || set.size === 0) return;
	for (const listener of Array.from(set)) {
		try {
			listener();
		} catch {
			// A waiter's callback must never break the LSP reader loop.
		}
	}
}

/**
 * Subscribe to `client`'s publishDiagnostics arrivals. Returns an unsubscribe
 * function; callers MUST invoke it (timeout, abort, and success paths alike) or
 * the listener leaks for the client's lifetime. Idempotent.
 */
export function onDiagnosticsPublished(client: LspClient, listener: DiagnosticsListener): () => void {
	let set = listeners.get(client);
	if (!set) {
		set = new Set();
		listeners.set(client, set);
	}
	const owner = set;
	owner.add(listener);
	let removed = false;
	return () => {
		if (removed) return;
		removed = true;
		owner.delete(listener);
		if (owner.size === 0) listeners.delete(client);
	};
}

/**
 * Wake every waiter registered for `client`. Called from the message router
 * AFTER the publish has been stored and `diagnosticsVersion` bumped, so a woken
 * waiter always observes the new state. Inside an open reader batch the wake is
 * deferred to the end of the batch (see above); outside one — a router call made
 * directly, e.g. from a test — it fires immediately.
 */
export function notifyDiagnosticsPublished(client: LspClient): void {
	if (openBatches.has(client)) {
		deferredWakes.add(client);
		return;
	}
	wakeListeners(client);
}

/** Test-only: number of live waiters for `client` (leak assertions). */
export function _diagnosticsWaiterCountForTest(client: LspClient): number {
	return listeners.get(client)?.size ?? 0;
}
