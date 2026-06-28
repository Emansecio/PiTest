/**
 * Subagent grounding guards.
 *
 * The PARENT agent gates every tool call through a chain of built-in grounding
 * guards (read-guard, edit-precondition, symbol/import/path/pattern/bash
 * grounding) registered as `tool_call` extension handlers in
 * {@link ./index.ts bundleBuiltInExtensions}. A spawned subagent, however, is a
 * raw `Agent` with only a permission `beforeToolCall` hook — it never runs those
 * handlers. So a subagent could edit a file it never read, submit an `edit` whose
 * oldText doesn't match the disk, or write a broken relative import: failures the
 * parent structurally cannot make. This closes that asymmetry.
 *
 * Rather than extract each guard's predicate (and risk drift from the live
 * handler), this re-runs the SAME guard factories against a minimal
 * {@link ExtensionAPI} shim that only collects their `tool_call` / `tool_result`
 * handlers, then exposes them as plain before/after hooks the subagent's `Agent`
 * can call directly. The permission extension and the host extensions
 * (coordinator/mcp/hooks/memory/learned-error) — which need a full bound runtime
 * — are intentionally excluded; the subagent already enforces permission in its
 * own beforeToolCall.
 *
 * Each chain is instantiated PER SPAWN, so its session state (read-stamp set,
 * fire-once sets) is isolated to that subagent. Every guard already reads its own
 * PIT_NO_* opt-out inside its handler, so individual guards stay independently
 * disableable here too. Opt out of the whole propagation with
 * PIT_NO_SUBAGENT_GUARDS.
 */

import type { ExtensionAPI } from "../extensions/index.js";
import type { ToolCallEvent, ToolCallEventResult, ToolResultEvent } from "../extensions/types.ts";
import { registerSubagentGroundingGuards } from "./grounding-guard-registry.ts";

type CollectedHandler = (event: unknown, ctx: unknown) => unknown;

export interface SubagentGuardChain {
	/** Run the guard chain for a tool call; resolves to the first block, else undefined. */
	beforeToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined>;
	/** Run the post-execution handlers (e.g. read-guard re-stamp). Never throws. */
	afterToolCall(event: ToolResultEvent): Promise<void>;
}

/** Opt-out: PIT_NO_SUBAGENT_GUARDS disables propagating the grounding guards to subagents. */
export function areSubagentGuardsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.PIT_NO_SUBAGENT_GUARDS;
	if (!value) return false;
	const v = value.toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

/**
 * Build a per-subagent guard chain. The factories register their handlers
 * against the shim synchronously; the returned hooks replay them in order.
 */
export function createSubagentGuardChain(options: { cwd: string }): SubagentGuardChain {
	const toolCallHandlers: CollectedHandler[] = [];
	const toolResultHandlers: CollectedHandler[] = [];

	// Minimal ExtensionAPI: the guard factories only call `pi.on(...)` at setup.
	// `tool_call` / `tool_result` are captured; any other event (e.g.
	// session_before_compact) is intentionally dropped for subagents.
	const shim = {
		on(event: string, handler: CollectedHandler) {
			if (event === "tool_call") toolCallHandlers.push(handler);
			else if (event === "tool_result") toolResultHandlers.push(handler);
		},
	} as unknown as ExtensionAPI;

	registerSubagentGroundingGuards(options.cwd, shim);

	return {
		async beforeToolCall(event) {
			for (const handler of toolCallHandlers) {
				try {
					const result = (await handler(event, undefined)) as ToolCallEventResult | undefined;
					if (result?.block) return result;
				} catch {
					// Fail-open: a guard throw must never hard-block the subagent — the
					// parent's emitToolCall has the same per-handler swallow.
				}
			}
			return undefined;
		},
		async afterToolCall(event) {
			for (const handler of toolResultHandlers) {
				try {
					await handler(event, undefined);
				} catch {
					// Best-effort: re-stamp / bookkeeping failures are non-fatal.
				}
			}
		},
	};
}
