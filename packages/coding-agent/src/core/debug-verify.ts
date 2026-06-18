/**
 * Debug-driven verify — the additive runtime-confirmation step that runs AFTER
 * the check-based verification gate passes.
 *
 * The check-based gate proves a turn still type-checks / lints / tests-green. It
 * does NOT prove the fix exercises the path it was meant to: a guard that should
 * cover `null` might pass the suite because no test reaches it. Debug-driven
 * verify launches the native DAP debugger against a recognized repro (a touched
 * pytest / go test), sets a breakpoint at the fix site, runs to it, and captures
 * the live variable state. That snapshot is handed back so the agent's next turn
 * can read e.g. "at breakpoint x was undefined — the fix does not cover null".
 *
 * Design contract (all load-bearing):
 *  - ADDITIVE, NEVER BLOCKING. The gate already decided the turn is done. This
 *    only produces an OPTIONAL context snapshot. It must never fail the turn.
 *  - FAIL-OPEN ABSOLUTE. Any error / exception / timeout / missing adapter /
 *    non-applicable repro returns null. The caller treats null as "nothing to
 *    add" and proceeds exactly as the check-based gate would have.
 *  - NEVER LEAK A PROCESS. The DAP session is ALWAYS terminated in a finally,
 *    even on launch failure / timeout / breakpoint error.
 *  - SHORT TIMEOUT. Runtime inspection is best-effort; a slow launch must not
 *    stall the turn boundary. Bounded by DEBUG_VERIFY_TIMEOUT_MS.
 *  - OPT-OUT via PIT_NO_DEBUG_VERIFY=1 (default ON).
 *
 * --------------------------------------------------------------------------
 * WIRING (agent-session.ts ~_runVerificationGate, around line 2961 — DO NOT edit
 * that file here; the orchestrator wires it):
 *
 * Inside `_runVerificationGate`, after the check-based loop reports `phase: "passed"`
 * (i.e. `result.ok === true`), and ONLY then, call:
 *
 *   const snapshot = await maybeRunDebugVerify({
 *     cwd: this._cwd,
 *     touchedFiles: Array.from(this._turnTouchedFilePaths),  // see note
 *     checkResult: result,
 *     signal: abort.signal,
 *   });
 *   if (snapshot && snapshot.verdict === "suspect") {
 *     await this._promptOnce(debugVerifyContextPrompt(snapshot), {
 *       expandPromptTemplates: false,
 *       source: options?.source,
 *     });
 *   }
 *
 * Notes for the wire:
 *  - `_turnTouchedFiles` today is a boolean; the wire needs the actual file
 *    paths. If a path set isn't tracked yet, pass [] — `isDebuggableRepro`
 *    returns null on empty and debug-verify no-ops (still fail-open).
 *  - Re-inject ONLY when `verdict === "suspect"` (a breakpoint that was reached
 *    but the captured state looks wrong, e.g. the fixed variable is still
 *    undefined/null). `verdict === "confirmed"` means the path was exercised and
 *    looked fine — no re-injection needed. `null` means not-applicable / failed
 *    to launch — say nothing.
 *  - This call is the LAST thing the gate does on green; it must not gate the
 *    already-passed result.
 * --------------------------------------------------------------------------
 */

import { resolve } from "node:path";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import { selectLaunchAdapter } from "./dap/config.ts";
import { dapSessionManager } from "./dap/index.ts";
import type { DapSessionSummary, DapVariable } from "./dap/types.ts";
import { type CheckResult, type DebuggableRepro, isDebuggableRepro, withFixSite } from "./verification/verification.ts";

/** Hard upper bound on the whole debug-verify excursion. Short by design. */
const DEBUG_VERIFY_TIMEOUT_MS = 20_000;
/** Per-DAP-request timeout (launch/continue/inspect each get this, clamped under the total). */
const DEBUG_VERIFY_REQUEST_TIMEOUT_MS = 8_000;
/** Cap captured variables so the snapshot can't balloon the next prompt. */
const MAX_CAPTURED_VARIABLES = 40;

export interface DebugVerifyContext {
	cwd: string;
	/** Files the turn modified (absolute or cwd-relative). Empty => no-op. */
	touchedFiles: readonly string[];
	/** The already-PASSED check result (debug-verify only runs on green). */
	checkResult: CheckResult;
	/** Caller abort (turn interrupt) — honored alongside the internal timeout. */
	signal?: AbortSignal;
	/**
	 * Dominant source file:line the turn edited. When present (and the file matches
	 * the repro's ecosystem), the breakpoint binds to the corrected statement via
	 * `withFixSite` instead of falling back to `stopOnEntry`. No-ops on invalid input.
	 */
	fixSite?: { file: string; line: number };
}

export interface DebugVerifyVariable {
	name: string;
	value: string;
	type?: string;
}

export interface DebugVerifyStateSnapshot {
	ecosystem: DebuggableRepro["ecosystem"];
	adapter: string;
	program: string;
	breakpointFile: string;
	/** Whether execution actually reached the breakpoint (a stop occurred there). */
	reachedBreakpoint: boolean;
	/** Stop location, when known: "file:line". */
	location?: string;
	/** Captured locals at the stop (capped). Empty when nothing was reachable. */
	variables: DebugVerifyVariable[];
}

export interface DebugVerifyResult {
	/**
	 * "confirmed" — repro reached the breakpoint and the captured state has no
	 *   obvious null/undefined smell on the fixed surface.
	 * "suspect"  — reached the breakpoint but a captured variable still reads as
	 *   undefined/null/None/nil, i.e. the fix may not cover the path. Re-inject.
	 * "inconclusive" — launched but never reached the breakpoint (no runtime
	 *   evidence either way). Do not re-inject; treat like null contextually.
	 */
	verdict: "confirmed" | "suspect" | "inconclusive";
	stateSnapshot: DebugVerifyStateSnapshot;
}

/** Values that strongly suggest an uncovered null path on the fixed surface. */
const NULLISH_VALUE_RE = /^(undefined|null|none|nil|<undefined>|<null>)$/i;

function isDisabled(): boolean {
	return isTruthyEnvFlag(process.env.PIT_NO_DEBUG_VERIFY);
}

function formatLocation(snapshot: DapSessionSummary | undefined): string | undefined {
	if (!snapshot?.source?.path || snapshot.line === undefined) return undefined;
	return `${snapshot.source.path}:${snapshot.line}`;
}

function looksNullish(variables: DebugVerifyVariable[]): boolean {
	return variables.some((v) => NULLISH_VALUE_RE.test(v.value.trim()));
}

/** Normalize a path for cross-platform comparison (separator + Windows case). */
function normalizeForCompare(p: string): string {
	return resolve(p).replace(/\\/g, "/").toLowerCase();
}

/**
 * Whether the current stop landed in the breakpoint's source file. Compares the
 * stop frame's reported source path against the fix-site file, normalized for
 * Windows (separator + drive-letter case). Returns false when the snapshot has no
 * source path — an unknown stop location must NOT be read as the fix site (its
 * locals would be the wrong frame).
 */
function stopMatchesFile(snapshot: DapSessionSummary | undefined, file: string): boolean {
	const stopPath = snapshot?.source?.path;
	if (typeof stopPath !== "string" || stopPath.length === 0) return false;
	return normalizeForCompare(stopPath) === normalizeForCompare(file);
}

/**
 * Best-effort: pull locals from the current stop frame. Walks scopes → variables.
 * Returns [] on any failure (fail-open within fail-open).
 */
async function captureVariables(signal: AbortSignal): Promise<DebugVerifyVariable[]> {
	try {
		const { scopes } = await dapSessionManager.scopes(undefined, signal, DEBUG_VERIFY_REQUEST_TIMEOUT_MS);
		const out: DebugVerifyVariable[] = [];
		for (const scope of scopes) {
			if (out.length >= MAX_CAPTURED_VARIABLES) break;
			// Prefer cheap "locals"/"arguments" scopes; skip expensive globals/registers.
			if (scope.expensive) continue;
			let vars: DapVariable[];
			try {
				const res = await dapSessionManager.variables(
					scope.variablesReference,
					signal,
					DEBUG_VERIFY_REQUEST_TIMEOUT_MS,
				);
				vars = res.variables;
			} catch {
				continue;
			}
			for (const v of vars) {
				if (out.length >= MAX_CAPTURED_VARIABLES) break;
				out.push({ name: v.name, value: v.value, ...(v.type ? { type: v.type } : {}) });
			}
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Run debug-driven verify for a turn that already passed its check. Returns a
 * verdict + state snapshot, or null when not applicable / disabled / failed.
 *
 * ABSOLUTELY fail-open and process-safe: every DAP interaction is guarded and the
 * session is terminated in `finally`. The only way this affects the turn is via
 * the (optional) returned snapshot.
 */
export async function maybeRunDebugVerify(ctx: DebugVerifyContext): Promise<DebugVerifyResult | null> {
	if (isDisabled()) return null;

	let repro: DebuggableRepro | null;
	try {
		repro = isDebuggableRepro(ctx.touchedFiles, ctx.checkResult, ctx.cwd);
	} catch {
		return null;
	}
	if (!repro) return null;

	// Refine the breakpoint to the touched source line when the wire tracked one.
	// withFixSite no-ops on invalid input or an ecosystem-mismatched file.
	if (ctx.fixSite) {
		repro = withFixSite(repro, ctx.fixSite.file, ctx.fixSite.line, ctx.cwd);
	}

	// Bound the entire excursion: internal timeout ∨ caller abort.
	const timeoutSignal = AbortSignal.timeout(DEBUG_VERIFY_TIMEOUT_MS);
	const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;

	let launched = false;
	try {
		const adapter = selectLaunchAdapter(repro.program, ctx.cwd, repro.adapter);
		if (!adapter) return null; // adapter vanished between detection and launch — fail-open.

		await dapSessionManager.launch(
			{
				adapter,
				program: repro.program,
				...(repro.module ? { module: repro.module } : {}),
				args: repro.args,
				cwd: ctx.cwd,
			},
			signal,
			DEBUG_VERIFY_REQUEST_TIMEOUT_MS,
		);
		launched = true;

		// Set the breakpoint at the FIX SITE. The wire refines `breakpointFile`/
		// `breakpointLine` to the touched source line via `withFixSite`; when it does,
		// the breakpoint binds to the corrected statement and the captured locals carry
		// the state under fix. Without a known line we must NOT fall back to line 1 (for
		// pytest that's the test file's module top — empty locals, never the function),
		// so we skip the line breakpoint entirely and rely on `stopOnEntry` parking us
		// in the target. Breakpoint failure is non-fatal.
		const fixLine = repro.breakpointLine;
		let breakpointSet = false;
		if (fixLine !== undefined) {
			try {
				await dapSessionManager.setBreakpoint(
					repro.breakpointFile,
					fixLine,
					undefined,
					signal,
					DEBUG_VERIFY_REQUEST_TIMEOUT_MS,
				);
				breakpointSet = true;
			} catch {
				// ignore — proceed to continue/inspect regardless.
			}
		}

		// Resume to the breakpoint (or program end). Short timeout: if the repro
		// runs long, we treat it as inconclusive rather than stalling the turn.
		let reached = false;
		let snapshot: DapSessionSummary | undefined;
		try {
			const outcome = await dapSessionManager.continue(signal, DEBUG_VERIFY_REQUEST_TIMEOUT_MS);
			snapshot = outcome.snapshot;
			reached = outcome.state === "stopped";
		} catch {
			reached = false;
		}

		// A stop only counts as runtime evidence if it landed in real source (not a
		// bare park with no location). When a fix-site LINE breakpoint was set, require
		// the stop to be in that file so an unrelated stop can't capture the wrong frame.
		// Without a known fix line (the common case) any located stop is best-effort
		// evidence — its locals still inform the verdict, and a false "confirmed" is inert
		// since only "suspect" re-injects context.
		if (reached) {
			if (!snapshot?.source?.path) {
				reached = false;
			} else if (breakpointSet && !stopMatchesFile(snapshot, repro.breakpointFile)) {
				reached = false;
			}
		}

		const variables = reached ? await captureVariables(signal) : [];
		const location = formatLocation(snapshot);
		const state: DebugVerifyStateSnapshot = {
			ecosystem: repro.ecosystem,
			adapter: repro.adapter,
			program: repro.program,
			breakpointFile: repro.breakpointFile,
			reachedBreakpoint: reached,
			...(location ? { location } : {}),
			variables,
		};

		if (!reached) return { verdict: "inconclusive", stateSnapshot: state };
		const verdict = looksNullish(variables) ? "suspect" : "confirmed";
		return { verdict, stateSnapshot: state };
	} catch {
		return null;
	} finally {
		// ALWAYS terminate — even if launch threw mid-way — so no debuggee leaks.
		if (launched) {
			try {
				// Use a fresh signal: the excursion signal may already be aborted
				// (timeout) and we still must tear the session down.
				await dapSessionManager.terminate(undefined, DEBUG_VERIFY_REQUEST_TIMEOUT_MS);
			} catch {
				try {
					await dapSessionManager.disposeAll();
				} catch {}
			}
		}
	}
}

/**
 * Render a debug-verify snapshot as a continuation prompt for the next turn.
 * Only meaningful for `verdict === "suspect"`. Kept here so the wire imports one
 * symbol; the agent-session formats nothing itself.
 */
export function debugVerifyContextPrompt(result: DebugVerifyResult): string {
	const s = result.stateSnapshot;
	const nullish = s.variables.filter((v) => NULLISH_VALUE_RE.test(v.value.trim()));
	const lines = [
		"Debug-driven verify ran the repro after the check passed and found a suspect runtime state:",
		`- repro: ${s.ecosystem} via ${s.adapter}`,
		`- breakpoint: ${s.location ?? s.breakpointFile}`,
	];
	if (nullish.length > 0) {
		lines.push(
			`- at the breakpoint these values were still nullish: ${nullish
				.map((v) => `${v.name}=${v.value}`)
				.join(", ")}`,
		);
		lines.push(
			"This suggests the fix may not cover the null/undefined path. Re-check whether the guard handles that case, then continue.",
		);
	}
	return lines.join("\n");
}
