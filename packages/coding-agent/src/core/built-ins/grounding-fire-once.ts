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
