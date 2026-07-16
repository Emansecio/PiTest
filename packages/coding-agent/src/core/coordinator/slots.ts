/**
 * Process-wide run-slot budget for live subagent Agents.
 *
 * Every live subagent run — blocking `task` runs, detached `op:"spawn"`s,
 * `parallel`/`fanout` children, acceptance judges, and resume/continue
 * re-drives — costs exactly ONE slot for as long as its Agent is actually
 * running. The single chokepoint is `withRunSlot` (used by `spawnSubagent` and
 * the coordinator's resume/continue paths), so the budget can no longer be
 * bypassed by tools that fan out internally (the old per-tool-call semaphore
 * counted a whole `parallel` batch as one slot).
 *
 * Nested-spawn deadlock (the reason leases exist): with `PIT_SUBAGENT_MAX_DEPTH
 * >= 2`, a child subagent's own `task` tool spawns a grandchild while the child
 * still holds a slot. If every slot were held by parents blocked awaiting
 * children, no grandchild could ever start — a classic nested-semaphore
 * deadlock. So the current holder's lease is tracked in AsyncLocalStorage: a
 * nested `withRunSlot` YIELDS the enclosing lease (gives its slot back) while
 * the descendant runs, and REACQUIRES it before returning to the enclosing
 * agent's loop. Nobody waits while holding, so the system always progresses.
 *
 * Lease operations are serialized per lease (an internal promise chain), so
 * concurrent nested children of the same agent (e.g. a `parallel` batch inside
 * a child) can't race yield/reacquire into a double release or a leaked slot.
 *
 * Env knobs (read lazily so tests can vary them):
 * - `PIT_SUBAGENT_MAX_CONCURRENCY` — max live Agents (default 4).
 * - `PIT_SUBAGENT_MAX_QUEUE` — max queued acquires past the cap (default 8×cap).
 */

import { AsyncLocalStorage } from "node:async_hooks";

const DEFAULT_MAX_CONCURRENCY = 4;

function maxConcurrency(): number {
	const raw = Number(process.env.PIT_SUBAGENT_MAX_CONCURRENCY);
	return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_CONCURRENCY;
}

function maxQueue(): number {
	const raw = Number(process.env.PIT_SUBAGENT_MAX_QUEUE);
	return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : maxConcurrency() * 8;
}

/** A queued acquire. `wake()` grants the slot; `settled` guards double-settling. */
interface SlotWaiter {
	settled: boolean;
	wake(): void;
}

let active = 0;
const waiters: SlotWaiter[] = [];

/** Coerce an AbortSignal reason into an Error (signals may carry a string or arbitrary value). */
function toAbortError(reason: unknown): Error {
	if (reason instanceof Error) return reason;
	return new Error(typeof reason === "string" && reason.length > 0 ? reason : "aborted");
}

/**
 * Take one slot, awaiting a free one past the cap. Abort-aware while queued.
 * `bypassQueueCap` is reserved for lease REACQUIRES — a parent re-taking the
 * slot it yielded is not new work and must never be rejected by a full queue
 * (that would leave the parent permanently unaccounted).
 */
function acquireOne(signal?: AbortSignal, opts?: { bypassQueueCap?: boolean }): Promise<void> {
	if (signal?.aborted) return Promise.reject(toAbortError(signal.reason));
	if (active < maxConcurrency()) {
		active++;
		return Promise.resolve();
	}
	if (!opts?.bypassQueueCap && waiters.length >= maxQueue()) {
		return Promise.reject(
			new Error(`subagent queue full (${waiters.length} waiting); try again after running tasks settle`),
		);
	}
	const w: SlotWaiter = { settled: false, wake: () => {} };
	return new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			if (w.settled) return;
			w.settled = true;
			const i = waiters.indexOf(w);
			if (i >= 0) waiters.splice(i, 1);
			cleanup();
			reject(toAbortError((signal as AbortSignal).reason));
		};
		w.wake = () => {
			if (w.settled) return;
			w.settled = true;
			active++;
			cleanup();
			resolve();
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
		waiters.push(w);
	});
}

/** Give one slot back and wake the oldest live waiter, if any. */
function releaseOne(): void {
	if (active > 0) active--;
	let next = waiters.shift();
	while (next?.settled) next = waiters.shift();
	if (next) next.wake();
}

/**
 * A held run slot. `yieldSlot()` temporarily returns the slot while awaiting a
 * descendant; `reacquire()` re-takes it (no-op when still held or closed);
 * `close()` releases it for good. All three are serialized per lease and safe
 * to call from concurrent nested children of the same agent.
 */
export class SlotLease {
	private held = true;
	private closed = false;
	/** Number of concurrent descendants this lease yielded for and still awaits. */
	private suspendedByDescendants = 0;
	private chain: Promise<void> = Promise.resolve();

	/** Serialize an operation behind every previously enqueued one. Never rejects. */
	private enqueue(op: () => void | Promise<void>): Promise<void> {
		const next = this.chain.then(op).catch(() => {});
		this.chain = next;
		return next;
	}

	/**
	 * Temporarily give the slot back for one descendant. Every call increments a
	 * suspension ref-count; only the 0→1 transition releases the physical slot.
	 * This matters when a parent starts multiple children concurrently: the
	 * parent's slot must not be reacquired when the FIRST child finishes while a
	 * sibling is still active (that sibling may delegate again).
	 */
	yieldSlot(): Promise<void> {
		return this.enqueue(() => {
			if (this.closed) return;
			this.suspendedByDescendants++;
			if (this.held) {
				this.held = false;
				releaseOne();
			}
		});
	}

	/**
	 * Mark one descendant settled. Only the final 1→0 transition re-takes the
	 * physical slot. Bypasses the queue cap (not new work) and swallows an abort —
	 * an aborting agent that fails to re-take simply finishes unaccounted rather
	 * than throwing from a finally.
	 */
	reacquire(signal?: AbortSignal): Promise<void> {
		return this.enqueue(async () => {
			if (this.closed) return;
			if (this.suspendedByDescendants > 0) this.suspendedByDescendants--;
			if (this.suspendedByDescendants > 0 || this.held) return;
			try {
				await acquireOne(signal, { bypassQueueCap: true });
				this.held = true;
			} catch {
				// Aborted while re-taking: stay unheld; close() stays a no-op for us.
			}
		});
	}

	/** Final release. The lease cannot be reacquired afterwards. Idempotent. */
	close(): Promise<void> {
		return this.enqueue(() => {
			this.closed = true;
			if (this.held) {
				this.held = false;
				releaseOne();
			}
		});
	}
}

const leaseContext = new AsyncLocalStorage<SlotLease | undefined>();

/** The lease held by the agent loop this code is running under, if any. */
export function currentLease(): SlotLease | undefined {
	return leaseContext.getStore();
}

/**
 * Run `fn` outside any enclosing lease context. Detached (`op:"spawn"`) runs
 * launched from inside a subagent's turn MUST use this: they outlive the
 * spawning turn, so yielding/reacquiring the spawner's lease from the detached
 * promise would leak or double-free a slot long after the spawner settled.
 */
export function withoutLease<T>(fn: () => Promise<T>): Promise<T> {
	return leaseContext.run(undefined, fn);
}

/** Read-only view of the budget, for `task({op:"list"})`. */
export function slotStats(): { active: number; queued: number } {
	return { active, queued: waiters.filter((w) => !w.settled).length };
}

/**
 * Await passive descendant work (e.g. `task({op:"join"})`) without holding the
 * current Agent's slot. Detached spawns deliberately sever lease inheritance,
 * so a nested child at concurrency=1 would otherwise queue behind its parent
 * while that parent blocks in join — another nested-semaphore deadlock.
 */
export async function yieldRunSlotWhile<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
	const lease = currentLease();
	if (!lease) return await fn();
	await lease.yieldSlot();
	try {
		return await fn();
	} finally {
		await lease.reacquire(signal);
	}
}

/**
 * THE chokepoint: run `fn` (a live Agent run) while holding exactly one slot.
 *
 * If the caller is itself running under a lease (a nested spawn inside a child
 * subagent's turn), that enclosing lease is yielded for the duration and
 * reacquired before returning — see the module doc for why (deadlock).
 * `fn` executes with ITS lease as the current context, so spawns nested inside
 * it yield the right lease in turn.
 *
 * Queue time (waiting for a slot) happens before `fn` starts, so callers that
 * arm wall-clock timeouts inside `fn` never count queue time against the task.
 */
export async function withRunSlot<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
	const enclosing = currentLease();
	if (enclosing) await enclosing.yieldSlot();
	let lease: SlotLease | undefined;
	try {
		lease = await acquireOne(signal).then(() => new SlotLease());
		return await leaseContext.run(lease, fn);
	} finally {
		if (lease) await lease.close();
		// reacquire never rejects (aborts are swallowed inside the lease op).
		if (enclosing) await enclosing.reacquire(signal);
	}
}
