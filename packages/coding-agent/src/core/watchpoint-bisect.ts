/**
 * Watchpoint-bisect — answers "who writes / corrupts X?" by arming a hardware
 * data breakpoint (watchpoint) on a variable/expression, resuming, and capturing
 * the writer's stack at each write-stop. Optionally cross-references the symbol
 * via LSP to enumerate static writers.
 *
 * This is the pure logic behind the `watchpoint_bisect` debug action. It is kept
 * out of tools/debug.ts on purpose: debug.ts owns the tool enum/registry (a shared
 * hub other lanes touch), while this module owns the algorithm and is wired in by
 * the main loop (see "WIRE" comment block at the bottom).
 *
 * Design constraints (tsgo erasableSyntaxOnly): no enum / no parameter-properties /
 * no namespace / no nested ternary. Unions of string literals replace enums.
 *
 * Fail-safe: degrades to a conditional source/function breakpoint when the active
 * adapter does not advertise `supportsDataBreakpoints`. A hard hit-cap prevents an
 * infinite continue loop when a write fires on every iteration of a hot path.
 */

import type {
	DapContinueOutcome,
	DapDataBreakpointInfoResponse,
	DapEvaluateResponse,
	DapScope,
	DapSessionSummary,
	DapStackFrame,
} from "./dap/types.js";

// ---------------------------------------------------------------------------
// Injected dependencies — structural subset of DapSessionManager's real methods.
// Each signature mirrors packages/coding-agent/src/core/dap/session.ts exactly so
// the live dapSessionManager singleton can be passed straight through at wire time.
// ---------------------------------------------------------------------------

export interface WatchpointBisectDeps {
	/** True iff the active adapter advertises hardware data breakpoints. */
	supportsDataBreakpoints: () => boolean;
	/** dapSessionManager.dataBreakpointInfo (session.ts:567). */
	dataBreakpointInfo: (
		name: string,
		variablesReference?: number,
		frameId?: number,
		signal?: AbortSignal,
		timeoutMs?: number,
	) => Promise<{ snapshot: DapSessionSummary; info: DapDataBreakpointInfoResponse }>;
	/** dapSessionManager.setDataBreakpoint (session.ts:589). */
	setDataBreakpoint: (
		dataId: string,
		accessType?: "read" | "write" | "readWrite",
		condition?: string,
		hitCondition?: string,
		signal?: AbortSignal,
		timeoutMs?: number,
	) => Promise<{ snapshot: DapSessionSummary; breakpoints: unknown[] }>;
	/** dapSessionManager.continue (session.ts:759). */
	continue: (signal?: AbortSignal, timeoutMs?: number) => Promise<DapContinueOutcome>;
	/** dapSessionManager.stackTrace (session.ts:820). */
	stackTrace: (
		frameCount: number | undefined,
		signal?: AbortSignal,
		timeoutMs?: number,
	) => Promise<{ snapshot: DapSessionSummary; stackFrames: DapStackFrame[]; totalFrames?: number }>;
	/** dapSessionManager.scopes (session.ts:843). */
	scopes: (
		frameId: number | undefined,
		signal?: AbortSignal,
		timeoutMs?: number,
	) => Promise<{ snapshot: DapSessionSummary; scopes: DapScope[] }>;
	/** dapSessionManager.evaluate (session.ts:871). */
	evaluate: (
		expression: string,
		context: "watch" | "repl" | "hover" | "variables" | "clipboard",
		frameId: number | undefined,
		signal?: AbortSignal,
		timeoutMs?: number,
	) => Promise<{ snapshot: DapSessionSummary; evaluation: DapEvaluateResponse }>;

	// --- fallback path (no hardware watchpoints) ---
	/** dapSessionManager.setBreakpoint (session.ts:408). Used by the conditional fallback. */
	setBreakpoint?: (
		file: string,
		line: number,
		condition?: string,
		signal?: AbortSignal,
		timeoutMs?: number,
	) => Promise<{ snapshot: DapSessionSummary; sourcePath: string; breakpoints: unknown[] }>;
	/** dapSessionManager.setFunctionBreakpoint (session.ts:466). Used by the conditional fallback. */
	setFunctionBreakpoint?: (
		name: string,
		condition?: string,
		signal?: AbortSignal,
		timeoutMs?: number,
	) => Promise<{ snapshot: DapSessionSummary; breakpoints: unknown[] }>;

	/**
	 * Optional: cross the watched symbol with LSP references to list static writers
	 * (call sites that assign the symbol). Injected by the caller as a thin adapter
	 * over the `lsp` tool's "references" action so this module stays decoupled from
	 * the LSP hub. Returns an empty array (or throws → swallowed) when unavailable.
	 */
	findReferences?: (
		symbol: string,
		signal?: AbortSignal,
	) => Promise<Array<{ file: string; line: number; column?: number }>>;
}

export interface WatchpointBisectArgs {
	/**
	 * Variable name OR expression to watch. For a data breakpoint the adapter needs a
	 * `name` (and optionally a containing variablesReference/frameId) — same inputs as
	 * data_breakpoint_info.
	 */
	expression: string;
	/** Containing scope's variablesReference (e.g. a `scopes` result), if the name is a member. */
	variablesReference?: number;
	/** Frame selector for resolving the dataId / fallback evaluation. */
	frameId?: number;
	/** Access filter; defaults to "write" — we want writers, not reads. */
	accessType?: "read" | "write" | "readWrite";
	/** Stop after this many write-hits (default 8). Hard-capped to avoid infinite continue loops. */
	maxHits?: number;
	/** Per-request timeout in ms (propagated to every DAP call). */
	timeoutMs?: number;
	/**
	 * Fallback only: where to plant the conditional breakpoint when hardware
	 * watchpoints are unavailable. Provide either {file,line} or {function}.
	 */
	fallbackFile?: string;
	fallbackLine?: number;
	fallbackFunction?: string;
	/** If true, also resolve LSP references for the symbol (when deps.findReferences exists). */
	crossReference?: boolean;
}

export interface WatchpointWriter {
	file: string;
	line: number;
	function: string;
	/**
	 * The full captured frame for tooling/UI; top-of-stack writer. Optional: a
	 * stop with no stack frames yields no frame, so consumers must guard before
	 * dereferencing rather than relying on a (lying) non-null cast.
	 */
	frame?: DapStackFrame;
}

export interface WatchpointHit {
	writer: WatchpointWriter;
	/** Observed value of the watched expression at the moment of the write, if readable. */
	value?: string;
	/** Full stack at the stop, most-recent frame first. */
	stack: DapStackFrame[];
	stopReason?: string;
}

export interface WatchpointBisectResult {
	/** Which strategy actually ran. */
	mode: "data-breakpoint" | "conditional-breakpoint";
	/** First/primary writer (top frame of the first hit), or undefined if no write was caught. */
	writer?: WatchpointWriter;
	/** Value captured at the first hit. */
	value?: string;
	/** Every distinct stop captured, in order. */
	hits: WatchpointHit[];
	/** Static writer call-sites from LSP references, when crossReference was requested. */
	references?: Array<{ file: string; line: number; column?: number }>;
	/** dataId resolved for the watchpoint (data-breakpoint mode only). */
	dataId?: string;
	/** True when the hit-cap stopped the loop before the program ran to completion. */
	cappedOut: boolean;
	/** Human-readable degradation note (e.g. why fallback was chosen / what was missing). */
	note?: string;
}

const ABSOLUTE_HIT_CAP = 64;
const DEFAULT_HITS = 8;
const DEFAULT_TIMEOUT_MS = 30_000;

function clampHits(requested: number | undefined): number {
	const n = requested ?? DEFAULT_HITS;
	if (!Number.isFinite(n) || n < 1) return DEFAULT_HITS;
	return Math.min(Math.floor(n), ABSOLUTE_HIT_CAP);
}

/** Top-of-stack frame → writer record. The frame at index 0 is the code that wrote. */
function writerFromStack(stack: DapStackFrame[]): WatchpointWriter | undefined {
	const top = stack[0];
	if (!top) return undefined;
	return {
		// DapSource.path is the on-disk path when the adapter resolves it; fall back to name.
		file: top.source?.path ?? top.source?.name ?? "<unknown>",
		line: top.line,
		function: top.name,
		frame: top,
	};
}

/**
 * Read the current value of the watched expression at the stopped frame. Best-effort:
 * a failed evaluate (symbol out of scope at this frame) must not abort the bisect.
 */
async function readValue(
	deps: WatchpointBisectDeps,
	expression: string,
	frameId: number | undefined,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<string | undefined> {
	try {
		const res = await deps.evaluate(expression, "watch", frameId, signal, timeoutMs);
		return res.evaluation.result;
	} catch {
		return undefined;
	}
}

/**
 * Optional LSP cross-reference. Fully best-effort — never throws into the caller.
 */
async function collectReferences(
	deps: WatchpointBisectDeps,
	symbol: string,
	signal: AbortSignal | undefined,
): Promise<Array<{ file: string; line: number; column?: number }> | undefined> {
	if (!deps.findReferences) return undefined;
	try {
		return await deps.findReferences(symbol, signal);
	} catch {
		return [];
	}
}

/**
 * Core entry point. Resolves a dataId, arms a write watchpoint, and continues,
 * capturing each writer until the hit-cap or until the program no longer stops
 * (ran to completion / terminated). Falls back to a conditional breakpoint when
 * the adapter lacks hardware data breakpoints.
 */
export async function runWatchpointBisect(
	deps: WatchpointBisectDeps,
	args: WatchpointBisectArgs,
): Promise<WatchpointBisectResult> {
	const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxHits = clampHits(args.maxHits);
	const accessType = args.accessType ?? "write";

	// LSP cross-reference can be gathered regardless of strategy; it's independent of
	// the live process state, so do it up front (still best-effort).
	const references = args.crossReference ? await collectReferences(deps, args.expression, undefined) : undefined;

	if (!deps.supportsDataBreakpoints()) {
		return runConditionalFallback(deps, args, { timeoutMs, maxHits, references });
	}

	// 1) Resolve a dataId for the expression. The adapter decides whether the symbol
	//    is watchable and via which variablesReference/frame.
	const infoRes = await deps.dataBreakpointInfo(
		args.expression,
		args.variablesReference,
		args.frameId,
		undefined,
		timeoutMs,
	);
	const dataId = infoRes.info.dataId;
	if (!dataId) {
		// Adapter advertises data breakpoints but can't watch THIS symbol → fall back.
		return runConditionalFallback(deps, args, {
			timeoutMs,
			maxHits,
			references,
			note: `adapter could not resolve a watchpoint for "${args.expression}": ${infoRes.info.description || "no dataId"}`,
		});
	}

	// Honor what the adapter says it supports for this dataId (some only allow readWrite).
	const supported = infoRes.info.accessTypes;
	const effectiveAccess = pickAccessType(accessType, supported);

	// 2) Arm the write watchpoint.
	await deps.setDataBreakpoint(dataId, effectiveAccess, undefined, undefined, undefined, timeoutMs);

	// 3) continue → stop loop.
	const hits = await runHitLoop(deps, args.expression, timeoutMs, maxHits);

	const first = hits[0];
	return {
		mode: "data-breakpoint",
		writer: first?.writer,
		value: first?.value,
		hits,
		references,
		dataId,
		cappedOut: hits.length >= maxHits,
		note:
			effectiveAccess === accessType
				? undefined
				: `requested access "${accessType}" not supported; used "${effectiveAccess}"`,
	};
}

/**
 * Pick an access type the adapter actually supports for this dataId. If the requested
 * one is in the advertised set (or the adapter advertised nothing), keep it; otherwise
 * take the first advertised type. Avoids arming a watchpoint the adapter will reject.
 */
function pickAccessType(
	requested: "read" | "write" | "readWrite",
	supported: Array<"read" | "write" | "readWrite"> | undefined,
): "read" | "write" | "readWrite" {
	if (!supported || supported.length === 0) return requested;
	if (supported.includes(requested)) return requested;
	return supported[0];
}

/**
 * Drives continue/stop, capturing one WatchpointHit per stop. Terminates when:
 *  - the program no longer stops (state !== "stopped" → ran to completion / terminated), or
 *  - a continue times out (timedOut → likely hung; don't busy-loop), or
 *  - the hit-cap is reached.
 */
async function runHitLoop(
	deps: WatchpointBisectDeps,
	expression: string,
	timeoutMs: number,
	maxHits: number,
): Promise<WatchpointHit[]> {
	const hits: WatchpointHit[] = [];
	for (let i = 0; i < maxHits; i++) {
		const outcome = await deps.continue(undefined, timeoutMs);
		// Not stopped → program finished, exited, or is still running (timed out). Either
		// way there's no fresh writer frame to read; stop the bisect.
		if (outcome.state !== "stopped" || outcome.timedOut) break;

		const traceRes = await deps.stackTrace(undefined, undefined, timeoutMs);
		const stack = traceRes.stackFrames;
		const writer = writerFromStack(stack);
		if (!writer) {
			// Stopped but no frames (rare). Record reason and stop — re-continuing risks a loop.
			hits.push({
				// No frames at this stop, so there is genuinely no writer frame. Leave
				// `frame` undefined instead of casting `undefined` to DapStackFrame.
				writer: { file: "<unknown>", line: 0, function: "<unknown>", frame: stack[0] },
				stack,
				stopReason: outcome.snapshot.stopReason,
			});
			break;
		}

		// Read the value at the writer's frame (best-effort).
		const value = await readValue(deps, expression, writer.frame?.id, undefined, timeoutMs);
		hits.push({ writer, value, stack, stopReason: outcome.snapshot.stopReason });
	}
	return hits;
}

interface FallbackCtx {
	timeoutMs: number;
	maxHits: number;
	references?: Array<{ file: string; line: number; column?: number }>;
	note?: string;
}

/**
 * Degraded path: no hardware watchpoint available. Plant a conditional breakpoint
 * where writes are expected and reuse the same continue/stop loop. The condition is
 * intentionally left to the caller via fallbackFile/Line or fallbackFunction because
 * the adapter can't auto-locate writers of an arbitrary symbol; the LSP references
 * (when present) are the recommended source of those locations.
 */
async function runConditionalFallback(
	deps: WatchpointBisectDeps,
	args: WatchpointBisectArgs,
	ctx: FallbackCtx,
): Promise<WatchpointBisectResult> {
	const baseNote = ctx.note ? `${ctx.note}; ` : "";

	const hasFileTarget = Boolean(args.fallbackFile) && args.fallbackLine !== undefined;
	const hasFnTarget = Boolean(args.fallbackFunction);

	if (!hasFileTarget && !hasFnTarget) {
		// Nothing to plant. Return a structured result with the references (if any) so the
		// model can pick a writer line and retry — rather than throwing and losing context.
		return {
			mode: "conditional-breakpoint",
			hits: [],
			references: ctx.references,
			cappedOut: false,
			note: `${baseNote}hardware watchpoints unavailable and no fallback target given. ${
				ctx.references && ctx.references.length > 0
					? `Pick a writer from references and re-run with fallbackFile/fallbackLine.`
					: `Provide fallbackFile+fallbackLine or fallbackFunction to plant a conditional breakpoint.`
			}`,
		};
	}

	if (hasFnTarget && deps.setFunctionBreakpoint) {
		await deps.setFunctionBreakpoint(args.fallbackFunction as string, undefined, undefined, ctx.timeoutMs);
	} else if (hasFileTarget && deps.setBreakpoint) {
		await deps.setBreakpoint(
			args.fallbackFile as string,
			args.fallbackLine as number,
			undefined,
			undefined,
			ctx.timeoutMs,
		);
	} else {
		return {
			mode: "conditional-breakpoint",
			hits: [],
			references: ctx.references,
			cappedOut: false,
			note: `${baseNote}fallback target given but the corresponding breakpoint setter was not injected`,
		};
	}

	const hits = await runHitLoop(deps, args.expression, ctx.timeoutMs, ctx.maxHits);
	const first = hits[0];
	return {
		mode: "conditional-breakpoint",
		writer: first?.writer,
		value: first?.value,
		hits,
		references: ctx.references,
		cappedOut: hits.length >= ctx.maxHits,
		note: `${baseNote}used conditional breakpoint fallback (no hardware data breakpoints)`.trim(),
	};
}

/**
 * Renders the result to a compact model-facing summary. Kept here so debug.ts can call
 * one function at wire time instead of re-deriving formatting.
 */
export function formatWatchpointBisect(result: WatchpointBisectResult): string {
	const lines: string[] = [];
	lines.push(`watchpoint_bisect (${result.mode}) — ${result.hits.length} write(s) captured`);
	if (result.writer) {
		const w = result.writer;
		lines.push(
			`First writer: ${w.function} @ ${w.file}:${w.line}${result.value !== undefined ? ` → ${result.value}` : ""}`,
		);
	}
	for (let i = 1; i < result.hits.length; i++) {
		const h = result.hits[i];
		lines.push(
			`  +${i}: ${h.writer.function} @ ${h.writer.file}:${h.writer.line}${h.value !== undefined ? ` → ${h.value}` : ""}`,
		);
	}
	if (result.references && result.references.length > 0) {
		lines.push(`Static writers (LSP references): ${result.references.length}`);
		for (const ref of result.references.slice(0, 10)) {
			lines.push(`  · ${ref.file}:${ref.line}`);
		}
	}
	if (result.cappedOut) lines.push(`(hit-cap reached — there may be more writers)`);
	if (result.note) lines.push(result.note);
	return lines.join("\n");
}
