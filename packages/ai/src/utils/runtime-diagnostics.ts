// Unified runtime-diagnostics channel.
//
// The agent harness has ~30 guards scattered across @pit/ai, @pit/coding-agent
// and @pit/tui that react to abnormal runtime conditions — idle-stream
// timeouts, output caps, process kills, retries, error isolation. Each used to
// report (if at all) in its own way: console.warn, a thrown error, an
// extension-only emitError, a result flag, or a silent swallow. In an
// autonomous run (goal / coordinator / RPC headless) none of those are
// visible: stderr is lost, flags die in the result, swallows vanish.
//
// This module is a process-global singleton — the one shape a guard in
// @pit/ai or @pit/tui can call WITHOUT receiving a bus by parameter through
// ~80 call-sites and WITHOUT @pit/ai taking a layering dependency on
// @pit/coding-agent. It lives in @pit/ai/utils because that is the lowest layer
// all three packages already import. It keeps per-category counters plus a
// bounded ring buffer of recent events, so a `/diagnostics` command (or a
// headless JSONL dump) has concrete state to read. Recording is O(1) and never
// throws — a guard's existing behavior is untouched; it just adds one call.

/** Severity of a diagnostic. `error` is a real fault contained by a guard. */
export type DiagnosticLevel = "info" | "warn" | "error";

/**
 * Stable category keys. Kept as a union so call-sites can't drift into typos
 * and `/diagnostics` can group deterministically. Add new keys here as guards
 * adopt the channel.
 */
export type DiagnosticCategory =
	| "stream.idle-timeout"
	| "stream.backpressure"
	| "net.connect-timeout"
	| "net.command-timeout"
	| "output.cap"
	| "process.kill"
	| "io.retry"
	| "error.isolated"
	| "limit.evicted"
	| "input.truncated"
	| "prune.proactive"
	| "compaction.presend-overflow-guard"
	| "fusion.member-failed"
	| "fusion.judge-retry"
	| "fusion.degraded"
	| "guard.grounding"
	| "guard.import-grounding"
	| "guard.path-grounding"
	| "guard.pattern-grounding"
	| "guard.bash-grounding"
	| "guard.edit-precondition"
	| "guard.read"
	| "guard.learned-error";

export interface DiagnosticContext {
	/** Byte size involved (cap hit, payload, buffer depth). */
	bytes?: number;
	/** Path or resource identifier. */
	path?: string;
	/** Process id when a child is involved. */
	pid?: number;
	/** Retry attempt number, 1-based. */
	attempt?: number;
	/** Milliseconds (timeout window, idle window). */
	ms?: number;
	/**
	 * Whether a guard BLOCKED a tool call or the model OVERRODE the block by
	 * re-issuing it (fire-once escape). Lets acceptance/override rate be measured
	 * per guard from the diagnostics ring buffer.
	 */
	outcome?: "blocked" | "overridden";
	/** Free-form short note; keep it small, it is retained in the ring buffer. */
	note?: string;
}

export interface DiagnosticEvent {
	category: DiagnosticCategory;
	level: DiagnosticLevel;
	/** Where it fired, e.g. "anthropic.iterateSseMessages" — stable, not a line. */
	source: string;
	context?: DiagnosticContext;
}

export interface DiagnosticCounter {
	count: number;
	level: DiagnosticLevel;
	/** Monotonic sequence number of the last occurrence (for ordering, not wall time). */
	lastSeq: number;
	/** Last context seen for this category, for a one-line sample in /diagnostics. */
	lastContext?: DiagnosticContext;
}

export interface DiagnosticSnapshot {
	counters: Record<string, DiagnosticCounter>;
	recent: Array<DiagnosticEvent & { seq: number }>;
	total: number;
}

/** Optional subscriber, e.g. a bridge that re-emits onto the agent-session bus. */
export type DiagnosticListener = (event: DiagnosticEvent & { seq: number }) => void;

// Bounded so a long autonomous session can't grow this without limit. Mirrors
// the kill-ring/learned-error cap style used elsewhere in the codebase.
const MAX_RECENT_EVENTS = 200;

interface DiagnosticsState {
	counters: Map<string, DiagnosticCounter>;
	recent: Array<DiagnosticEvent & { seq: number }>;
	listeners: Set<DiagnosticListener>;
	seq: number;
}

// Process-global singleton, stored on globalThis so multiple bundled copies of
// @pit/ai (dist vs src under test, or duplicate installs) still share one sink
// rather than each keeping a private, invisible one.
const GLOBAL_KEY = "__pitRuntimeDiagnostics__";

function getState(): DiagnosticsState {
	const holder = globalThis as typeof globalThis & { [GLOBAL_KEY]?: DiagnosticsState };
	let state = holder[GLOBAL_KEY];
	if (!state) {
		state = { counters: new Map(), recent: [], listeners: new Set(), seq: 0 };
		holder[GLOBAL_KEY] = state;
	}
	return state;
}

/**
 * Record one diagnostic. O(1), never throws — a guard calls this in addition to
 * (not instead of) whatever it already does, so behavior and perf are unchanged.
 */
export function recordDiagnostic(event: DiagnosticEvent): void {
	const state = getState();
	state.seq += 1;
	const stamped = { ...event, seq: state.seq };

	const existing = state.counters.get(event.category);
	if (existing) {
		existing.count += 1;
		existing.level = event.level;
		existing.lastSeq = state.seq;
		existing.lastContext = event.context;
	} else {
		state.counters.set(event.category, {
			count: 1,
			level: event.level,
			lastSeq: state.seq,
			lastContext: event.context,
		});
	}

	state.recent.push(stamped);
	if (state.recent.length > MAX_RECENT_EVENTS) {
		// Drop the oldest. Splice in a batch when we overshoot so this is amortized
		// O(1) rather than a shift() per record.
		state.recent.splice(0, state.recent.length - MAX_RECENT_EVENTS);
	}

	if (state.listeners.size > 0) {
		for (const listener of state.listeners) {
			try {
				listener(stamped);
			} catch {
				// A faulty bridge must never break the guard that recorded.
			}
		}
	}
}

/** Read the current counters + recent ring for /diagnostics or a headless dump. */
export function getRuntimeDiagnostics(): DiagnosticSnapshot {
	const state = getState();
	const counters: Record<string, DiagnosticCounter> = {};
	for (const [category, counter] of state.counters) {
		counters[category] = { ...counter };
	}
	let total = 0;
	for (const counter of state.counters.values()) {
		total += counter.count;
	}
	return { counters, recent: state.recent.slice(), total };
}

/**
 * Subscribe to diagnostics (e.g. a coding-agent bridge that re-emits onto the
 * session event bus so the TUI/extensions see them). Returns an unsubscribe fn.
 */
export function onDiagnostic(listener: DiagnosticListener): () => void {
	const state = getState();
	state.listeners.add(listener);
	return () => {
		state.listeners.delete(listener);
	};
}

/** Clear all diagnostics. Test-only; production has no reason to reset. */
export function resetRuntimeDiagnostics(): void {
	const state = getState();
	state.counters.clear();
	state.recent.length = 0;
	state.seq = 0;
}
