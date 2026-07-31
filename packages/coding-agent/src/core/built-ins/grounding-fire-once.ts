/**
 * The shared pre-execution Guard seam.
 *
 * Every built-in pre-exec guard (symbol / import / erasable-syntax / path /
 * pattern / bash / destructive-command grounding) is the same ritual wrapped
 * around one small decision function:
 *
 *   kill-switch -> tool gate -> decide -> {allow | rewrite | block}
 *                                          + fire-once + diagnostic + fail-open
 *
 * Only the `decide` differs. {@link createGuard} owns the ritual ONCE so each
 * adapter is left with nothing but its own check and its own deps (caches,
 * LSP/repo-map wiring). The invariants it centralizes:
 *
 *   - **fire-once anti-wedge**: a block is advisory. The blocked `(tool, args)`
 *     is remembered in a per-session `Set`; an insistent model re-issuing the
 *     IDENTICAL call runs it. The guard advises, never wedges.
 *   - **outcome accounting**: `outcome:"blocked"` on the first fire,
 *     `outcome:"overridden"` on the identical re-issue, so per-guard/per-rule
 *     acceptance rate is readable straight off the diagnostics ring buffer.
 *   - **fail-open, but never silent**: a throw anywhere (kill-switch, tool gate,
 *     decide, or the emission itself) allows the call. Defense-in-depth —
 *     `emitToolCall` already isolates per-handler throws; a guard bug must never
 *     hard-block. Every containment is recorded as a `guard.failed` diagnostic:
 *     a swallowed throw is indistinguishable from "the guard had nothing to say",
 *     so without it a permanently-broken guard reads as a permanently-clean one.
 *   - **in-place rewrite**: an auto-correction patches `event.input` and PASSES.
 *     That is neither a block nor an override, so it records only `{note, ruleId}`
 *     (the `outcome` enum cannot express an auto-correct).
 *
 * The handler stays SYNCHRONOUS when `decide` is synchronous — several guards
 * (path/pattern/bash/destructive) are pure-sync and their callers read the
 * verdict without awaiting.
 *
 * The read-guard is deliberately NOT built on `createGuard`: its fire-once is
 * keyed by absolute PATH (not by `(tool, args)`) and is cleared by unrelated
 * events (a fresh `read`, the model's own successful write, compaction). It
 * shares only {@link recordGuardOutcome}.
 */

import { type DiagnosticCategory, type DiagnosticContext, recordDiagnostic } from "@pit/ai";
import type { ExtensionAPI } from "../extensions/index.js";
import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "../extensions/types.ts";

/**
 * Shared fire-once key construction for the guard adapters.
 *
 * The key is stable across re-orderings of the top-level arg keys: a verbatim
 * re-issue with reordered keys still matches the fire-once escape.
 */
export function stableToolCallKey(toolName: string, input: Record<string, unknown>): string {
	const ordered: Record<string, unknown> = {};
	for (const k of Object.keys(input).sort()) {
		ordered[k] = input[k];
	}
	return `${toolName}:${JSON.stringify(ordered)}`;
}

/**
 * Verdict of one guard check.
 *
 * `allow` (or `undefined`) lets the call through untouched. `rewrite` patches the
 * tool args in place and PASSES. `block` stops the call once, with the fire-once
 * escape applied by {@link createGuard}. `ruleId`/`note` override the spec-level
 * defaults for guards whose single check has several stable sub-kinds (import
 * path/export/bare/alias, erasable enum/namespace/parameter-property/…).
 */
export type GuardDecision =
	| { action: "allow" }
	| { action: "rewrite"; args: Record<string, unknown>; ruleId?: string; note?: string }
	| { action: "block"; reason: string; ruleId?: string; note?: string };

export interface GuardSpec {
	/** Stable emitter id recorded on every diagnostic, e.g. "path-grounding-extension". */
	source: string;
	category: DiagnosticCategory;
	/**
	 * Default stable, lowercase-kebab id of the check this guard fires, recorded on
	 * every emission so per-rule efficacy is measurable downstream (the category
	 * alone only identifies the guard). A {@link GuardDecision} may override it when
	 * the guard has several sub-kinds.
	 */
	ruleId: string;
	/** Tool gate. Evaluated per call, after the kill-switch. */
	appliesTo(toolName: string): boolean;
	/** Kill-switch (PIT_NO_*). Evaluated per call so the env can change mid-session; fail-open. */
	disabled?(): boolean;
	/**
	 * The guard's own check. `ctx` is undefined on the subagent guard chain (the
	 * shim invokes handlers without one), so treat every field as optional.
	 */
	decide(
		event: ToolCallEvent,
		ctx: ExtensionContext | undefined,
	): GuardDecision | undefined | Promise<GuardDecision | undefined>;
}

/**
 * Emit one guard block/override diagnostic in the shape every guard shares.
 * `context` carries the guard's own locator key (`note` for the grounding
 * adapters, `path` for the read-guard).
 */
export function recordGuardOutcome(params: {
	category: DiagnosticCategory;
	source: string;
	outcome: "blocked" | "overridden";
	ruleId: string;
	toolName: string;
	toolCallId: string;
	context?: DiagnosticContext;
}): void {
	recordDiagnostic({
		category: params.category,
		level: "info",
		source: params.source,
		context: {
			...params.context,
			outcome: params.outcome,
			ruleId: params.ruleId,
			toolName: params.toolName,
			toolCallId: params.toolCallId,
		},
	});
}

function isThenable<T>(value: unknown): value is Promise<T> {
	return typeof (value as { then?: unknown } | undefined)?.then === "function";
}

/** Phase of the guard ritual that threw, recorded on the `guard.failed` diagnostic. */
type GuardFailurePhase = "check" | "settle";

/**
 * Record one contained guard fault. The call the guard was vetting RAN UNVETTED —
 * that is the whole point of recording it: fail-open keeps the session alive, the
 * diagnostic keeps the hole visible (and, via `outcome:"failed"`, keeps a broken
 * guard out of the acceptance-rate math for its rule).
 */
function recordGuardFailure(params: {
	spec: GuardSpec;
	event: ToolCallEvent;
	phase: GuardFailurePhase;
	error: unknown;
}): void {
	try {
		const { spec, event, phase, error } = params;
		recordDiagnostic({
			category: "guard.failed",
			level: "error",
			source: spec.source,
			context: {
				// `source` already identifies WHICH guard failed; the category is
				// redundant with it and is not part of DiagnosticContext.
				outcome: "failed",
				ruleId: spec.ruleId,
				phase,
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				note: error instanceof Error ? error.message : String(error),
			},
		});
	} catch {
		// The diagnostic channel itself is best-effort; never let observability
		// turn a contained guard fault into a thrown tool call.
	}
}

/**
 * Wrap one {@link GuardSpec} into an extension factory: the whole pre-exec guard
 * ritual (kill-switch, tool gate, fire-once, diagnostics, fail-open) applied to
 * the spec's `decide`.
 */
export function createGuard(spec: GuardSpec): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		const fired = new Set<string>();

		const settle = (event: ToolCallEvent, decision: GuardDecision | undefined): ToolCallEventResult | undefined => {
			if (decision === undefined || decision.action === "allow") return undefined;

			const input = event.input as Record<string, unknown>;
			const ruleId = decision.ruleId ?? spec.ruleId;
			const note = decision.note ?? event.toolName;

			if (decision.action === "rewrite") {
				// event.input is mutable in place; patch the corrected args and PASS.
				Object.assign(input, decision.args);
				recordDiagnostic({
					category: spec.category,
					level: "info",
					source: spec.source,
					context: { note, ruleId },
				});
				return undefined;
			}

			const key = stableToolCallKey(event.toolName, input);
			if (fired.has(key)) {
				// The model is OVERRIDING the fire-once advisory by re-issuing the
				// identical call — record the acceptance so override-rate is measurable
				// against the blocks below.
				recordGuardOutcome({
					category: spec.category,
					source: spec.source,
					outcome: "overridden",
					ruleId,
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					context: { note },
				});
				return undefined; // already advised once -> let it run
			}
			fired.add(key);
			recordGuardOutcome({
				category: spec.category,
				source: spec.source,
				outcome: "blocked",
				ruleId,
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				context: { note },
			});
			return { block: true, reason: decision.reason };
		};

		pi.on("tool_call", (event, ctx) => {
			try {
				if (spec.disabled?.() === true) return undefined;
				if (!spec.appliesTo(event.toolName)) return undefined;

				const decision = spec.decide(event, ctx);
				if (isThenable<GuardDecision | undefined>(decision)) {
					return decision.then(
						(resolved) => {
							try {
								return settle(event, resolved);
							} catch (error) {
								recordGuardFailure({ spec, event, phase: "settle", error });
								return undefined;
							}
						},
						(error) => {
							recordGuardFailure({ spec, event, phase: "check", error });
							return undefined;
						},
					);
				}
				try {
					return settle(event, decision);
				} catch (error) {
					// Inner catch so the recorded `phase` distinguishes a broken check
					// from a broken verdict application (frozen args, bad rewrite shape).
					recordGuardFailure({ spec, event, phase: "settle", error });
					return undefined;
				}
			} catch (error) {
				recordGuardFailure({ spec, event, phase: "check", error });
				return undefined;
			}
		});
	};
}
