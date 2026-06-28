import { type DiagnosticCategory, recordDiagnostic } from "@pit/ai";
import type { ExtensionAPI } from "../extensions/index.js";
import type { ToolCallEvent, ToolCallEventResult } from "../extensions/types.ts";

/**
 * Shared fire-once key construction for the grounding guard adapters.
 *
 * Each grounding `-extension.ts` keeps a per-session `Set<string>` so an insistent
 * model re-issuing an identical blocked call runs it (advises, never wedges). The
 * key is stable across re-orderings of the top-level arg keys: a verbatim re-issue
 * with reordered keys still matches the fire-once escape. Centralizing it keeps the
 * five adapters byte-identical (and the subagent-guards re-instantiation in sync).
 */
export function stableToolCallKey(toolName: string, input: Record<string, unknown>): string {
	const ordered: Record<string, unknown> = {};
	for (const k of Object.keys(input).sort()) {
		ordered[k] = input[k];
	}
	return `${toolName}:${JSON.stringify(ordered)}`;
}

export interface FireOnceBlockGuardOptions {
	category: DiagnosticCategory;
	source: string;
	decide(event: ToolCallEvent): { block: true; reason: string } | undefined;
}

/**
 * Thin adapter for block-only grounding guards: fire-once set, diagnostic on block,
 * fail-open try/catch. `decide` returns undefined to allow the call.
 */
export function createFireOnceBlockGuard(options: FireOnceBlockGuardOptions): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		const fired = new Set<string>();

		pi.on("tool_call", (event) => {
			try {
				const decision = options.decide(event);
				if (!decision || decision.block !== true) return undefined;

				const input = event.input as Record<string, unknown>;
				const key = stableToolCallKey(event.toolName, input);
				if (fired.has(key)) return undefined;
				fired.add(key);
				recordDiagnostic({
					category: options.category,
					level: "info",
					source: options.source,
					context: { note: event.toolName },
				});
				return { block: true, reason: decision.reason } satisfies ToolCallEventResult;
			} catch {
				return undefined;
			}
		});
	};
}
