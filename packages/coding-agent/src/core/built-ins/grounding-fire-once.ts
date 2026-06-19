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
	return `${toolName}:${JSON.stringify(input, Object.keys(input).sort())}`;
}
