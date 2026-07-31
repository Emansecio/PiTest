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
	| "stream.wall-clock-timeout"
	| "stream.missing-terminal"
	| "stream.overthink-guard"
	| "stream.backpressure"
	| "net.connect-timeout"
	| "net.command-timeout"
	// A reasoning_effort field was dropped from a tools request (provider rejects
	// effort+tools). `mechanism` says why: compat flag / memoized value / live retry.
	| "provider.reasoning-effort-stripped"
	| "output.cap"
	| "process.kill"
	| "io.retry"
	// A session persist-write (JSONL append or atomic rewrite) failed and was
	// swallowed fail-open, so in-memory history and the on-disk session diverged.
	// `count` carries the consecutive-failure run; the session escalates to a
	// visible warning once it crosses a small threshold.
	| "session.persist_failed"
	// A compaction entry's `firstKeptEntryId` matched no entry on the session path,
	// so the kept-history anchor was lost (migrated session, dropped entry, edited
	// file). The context builder fails SAFE — it keeps the full pre-compaction
	// history rather than emitting none — and records this so the divergence is
	// visible instead of showing up as context that quietly went missing.
	| "session.compaction_anchor_missing"
	| "error.isolated"
	| "limit.evicted"
	| "input.truncated"
	| "prune.proactive"
	// Below real pressure, a proactive size-prune was DEFERRED because the reclaimed
	// tokens don't earn back the one-time cost of invalidating the cached tail within
	// the amortization horizon (see coding-agent prune-economics.ts). `note` carries
	// reclaimed/tail tokens and the estimated one-time vs recurring USD figures.
	| "prune.economics-defer"
	| "prune.supersede-only"
	| "prune.thinking-cap"
	| "prune.live"
	| "prune.mid-turn-pressure"
	| "quality.rigor"
	| "quality.recovery"
	| "quality.supervision"
	| "compaction.presend-overflow-guard"
	// P2 speculative compaction: a background summary was pre-computed mid-turn
	// (start), applied apply-only when the real threshold hit (hit), or discarded
	// (stale by growth / invalid anchor / error). `note` carries which and why.
	| "compaction.speculative"
	| "fusion.member-failed"
	| "fusion.judge-retry"
	| "fusion.degraded"
	| "fusion.verify-skipped"
	| "fusion.panel-char-estimate"
	| "fusion.both-throttled-retry"
	| "compaction.summary-json-fallback"
	| "compaction.summary-ungrounded"
	| "guard.grounding"
	| "guard.import-grounding"
	| "guard.path-grounding"
	| "guard.pattern-grounding"
	| "guard.bash-grounding"
	| "guard.destructive-command"
	| "guard.patch-audit"
	| "guard.edit-precondition"
	| "guard.erasable-syntax"
	| "guard.read"
	| "guard.learned-error"
	| "guard.intent-gate"
	// A pre-exec guard THREW and was contained fail-open, so the call it was
	// supposed to vet ran unvetted. Silent fail-open is indistinguishable from
	// "guard had nothing to say", so every containment is recorded with the
	// guard's `source`/`ruleId`, the `phase` that threw (kill-switch, gate,
	// decide, settle) and the error message.
	| "guard.failed"
	// Band C grounding for the DEFAULT in-turn verification mode: a cycle modified
	// files and ran no verification-class command. `ruleId` distinguishes the
	// correction (`in-turn-check-missing`) from the bounded give-up
	// (`in-turn-check-gave-up`); `count` carries the unheeded streak.
	| "quality.in-turn-check"
	// Corrective (Band C): a Tier-4 tool-error-hint rule fired, carrying the
	// rule id + tool name so dead/noisy hint rules can be found from the tally.
	| "hint.fired"
	| "conditioning.context"
	| "quality.contract"
	| "quality.self-review"
	| "quality.cache-marker"
	// Code-graph Fase 2 (import-edge blast radius): a post-edit advisory fired
	// (or the goal_complete R10 gate blocked completion) because dependents of
	// the changed file were surfaced by `built-ins/impact-extension.ts`.
	| "quality.impact-guard"
	// An under-specified mutating prompt got the ask-before-you-wander
	// `<clarify_first>` directive appended for this turn (clarify nudge).
	| "quality.clarify"
	// The todo list drifted from the work: either a sync reminder fired, or the
	// reminder was ignored enough times that it gave up (ruleId distinguishes).
	| "quality.todo-cadence"
	| "lsp.manager-overwrite"
	// A verification-gate failure was classified by whether its failing files were
	// edited this turn (cross-file escape). `mechanism` carries the classification,
	// `count`/`crossFileCount` the attribution counts.
	| "verification.cross_file_escape"
	// A prompt-cache keepalive ping fired while the session was idle (P3):
	// a minimal max_tokens:1 request against the session's own wire prefix,
	// meant to renew Anthropic's short cache-retention TTL before it lapses.
	| "cache.keepalive"
	// Cache-aware compaction: the summarizer chose between serializing the window
	// as fresh text to the cheap sibling vs re-reading the session's hot prefix on
	// the session model (~0.1x cacheRead). `note` carries route/reason and the two
	// estimated USD figures.
	| "compaction.cache-aware"
	// A tool call's arguments were silently coerced before execution by the shared
	// coercion table (`utils/arg-coercion.ts`) — from the agent's repair layer or
	// from validateToolArguments' single fallback pass. `mechanism` carries the
	// coercion kind, `toolName` the tool; `getToolArgCoercionStats()` is the typed
	// aggregate view of the same events.
	| "tool.arg-repair";

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
	 * Whether a guard BLOCKED a tool call, the model OVERRODE the block by
	 * re-issuing it (fire-once escape), or the guard itself FAILED and was
	 * contained fail-open (the call ran unvetted). Lets acceptance/override rate
	 * be measured per guard from the diagnostics ring buffer — `failed` is kept
	 * out of that pair on purpose, so a broken guard does not read as a verdict.
	 */
	outcome?: "blocked" | "overridden" | "failed";
	/**
	 * For `outcome:"failed"`: which step of the guard ritual threw — `check`
	 * (kill-switch, tool gate, or the guard's own decision) or `settle` (applying
	 * an already-made verdict). Narrows a contained fault to a code path.
	 */
	phase?: "check" | "settle";
	/**
	 * Stable identifier of the specific rule/check inside the guard that fired
	 * (e.g. an error-hint rule id, a grounding check name). Enables per-rule
	 * efficacy accounting downstream; the category alone only identifies the guard.
	 */
	ruleId?: string;
	/** Free-form short note; keep it small, it is retained in the ring buffer. */
	note?: string;
	/** Tool name when the diagnostic is scoped to one tool call (e.g. prune.live). */
	toolName?: string;
	/** Opaque id for the exact tool call that produced this diagnostic. */
	toolCallId?: string;
	/**
	 * Mechanism that produced the diagnostic (e.g. `supersede`, `arg_elision`,
	 * `supersede+arg_elision`, `turn-end`). Kept as a short stable string.
	 */
	mechanism?: string;
	/**
	 * Tokens/bytes reclaimed by a prune path. Same numeric semantics as `bytes`
	 * for live prune today; typed so aggregators need not parse `note`.
	 */
	reclaimedTokens?: number;
	/** Generic count for a classified event (e.g. failing-file total). */
	count?: number;
	/** How many of `count` were cross-file (failing files the turn never touched). */
	crossFileCount?: number;
	/**
	 * On a `verification.cross_file_escape` diagnostic: whether the import graph
	 * (`built-ins/impact-extension.ts`) had already flagged at least one of the
	 * cross-file failures as an impacted dependent before the check caught it —
	 * i.e. the escape was predictable from the graph, not a total surprise.
	 */
	predictedByGraph?: boolean;
	/**
	 * How many of the cross-file failures the import graph had predicted — the
	 * numerator of the graph's recall (`crossFileCount` is the denominator).
	 */
	predictedCrossFileCount?: number;
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

/** A recorded event as stored/delivered: sequenced and wall-clock stamped. */
export type RecordedDiagnosticEvent = DiagnosticEvent & { seq: number; ts: number };

export interface DiagnosticSnapshot {
	counters: Record<string, DiagnosticCounter>;
	recent: RecordedDiagnosticEvent[];
	total: number;
}

/** Optional subscriber, e.g. a bridge that re-emits onto the agent-session bus. */
export type DiagnosticListener = (event: RecordedDiagnosticEvent) => void;

// Bounded so a long autonomous session can't grow this without limit. Mirrors
// the kill-ring/learned-error cap style used elsewhere in the codebase.
const MAX_RECENT_EVENTS = 200;

interface DiagnosticsState {
	counters: Map<string, DiagnosticCounter>;
	recent: RecordedDiagnosticEvent[];
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
	const stamped: RecordedDiagnosticEvent = { ...event, seq: state.seq, ts: Date.now() };

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
