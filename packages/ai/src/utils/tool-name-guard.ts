import type { Tool } from "../types.ts";

/**
 * Wire-safety guard for tool names.
 *
 * OpenAI-compatible providers constrain tool names to the charset
 * `[a-zA-Z0-9_-]` and a 64-character limit (the same rules the tool-call id
 * sanitizer enforces — see `sanitizeToolCallId`). Built-in tools already satisfy
 * this, and MCP tools are sanitized at the registry, so this guard is
 * defense-in-depth for extension/custom tools whose names may contain dots,
 * slashes, colons, or be over-long.
 *
 * The guard is a per-request, bidirectional remap:
 *   - `toWire` rewrites an original name to its wire-safe form for the request
 *     (tool definitions). Identity when unknown — the current tool set is always
 *     in the map, so a miss can only mean an already-valid name.
 *   - `toWireHistorical` rewrites a REPLAYED tool name (from an assistant
 *     tool_call or a tool result in history) to a wire-safe form. Unlike
 *     `toWire`, a miss here is expected: the name may belong to a tool that was
 *     since removed or an MCP server that disconnected, so it is no longer in the
 *     current tool set. Such a name must NOT reach the wire raw — if it is out of
 *     charset/length the provider rejects the whole request on every subsequent
 *     turn (poisoned transcript). On a miss we therefore sanitize unconditionally
 *     (valid names pass through without allocation). This applies EVEN when the
 *     guard is the no-op (current tool set all valid): the no-op still sanitizes
 *     invalid historical names.
 *   - `fromWire` rewrites a name coming back from the model in a tool call to
 *     the original name before it surfaces to the caller.
 *
 * When every name is already valid (the hot path) the guard is a shared no-op
 * singleton: `toWire`/`fromWire` are identity, `toWireHistorical` sanitizes only
 * invalid names, and no maps are allocated.
 *
 * Kill switch: `PIT_NO_TOOLNAME_GUARD=1` returns the no-op guard unconditionally.
 * This disables the bidirectional current-tool remap, but `toWireHistorical` on
 * the no-op still sanitizes invalid replayed names — that minimal defense is what
 * keeps a single poisoned history entry from failing every subsequent request,
 * so it is deliberately not switched off.
 */
export interface ToolNameGuard {
	/** Map an original tool name to its wire-safe name. Identity when unknown. */
	toWire(name: string): string;
	/**
	 * Map a replayed (historical) tool name to a wire-safe name. Looks up the
	 * current-tool-set remap first; on a miss, sanitizes the name unconditionally
	 * so no out-of-charset/over-long name from history ever reaches the wire.
	 *
	 * Coherence note: a sanitized historical name may collide with the wire name
	 * of a current tool, or two distinct historical names may sanitize to the same
	 * string. This is intentionally accepted: these names appear only in the
	 * transcript (assistant tool_call + matching tool result, paired by call id,
	 * not by name) and the model never invokes a tool that is not in the current
	 * tool set. A name collision in replay is therefore harmless.
	 */
	toWireHistorical(name: string): string;
	/** Map a wire name (from a model response) back to the original. Identity when unknown. */
	fromWire(name: string): string;
	/** True only when at least one name was rewritten (response remap needed). */
	readonly active: boolean;
}

const MAX_TOOL_NAME_LEN = 64;
const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

/** Shared no-op guard: identity mapping, no allocation, `active === false`. */
export const NOOP_TOOL_NAME_GUARD: ToolNameGuard = {
	toWire: (name) => name,
	// Even with no active remap, a replayed historical name must be wire-safe:
	// sanitize only when invalid so the hot path stays allocation-free.
	toWireHistorical: (name) => sanitizeToolNameIfInvalid(name),
	fromWire: (name) => name,
	active: false,
};

function guardDisabled(): boolean {
	const env = typeof process !== "undefined" ? process.env?.PIT_NO_TOOLNAME_GUARD : undefined;
	const flag = env?.toLowerCase();
	return flag === "1" || flag === "true" || flag === "yes";
}

/**
 * Replace any char outside `[a-zA-Z0-9_-]` with `_`, then truncate to 64 chars.
 * Mirrors {@link sanitizeToolCallId} so ids and names share one charset.
 */
function sanitizeToolName(name: string): string {
	const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
	return sanitized.length > MAX_TOOL_NAME_LEN ? sanitized.slice(0, MAX_TOOL_NAME_LEN) : sanitized;
}

/**
 * Sanitize only when the name is out of charset/length; return it unchanged
 * (no allocation) when it is already wire-safe. Used by the historical replay
 * path so valid names cost nothing while invalid ones can never reach the wire.
 */
function sanitizeToolNameIfInvalid(name: string): string {
	if (name.length <= MAX_TOOL_NAME_LEN && VALID_TOOL_NAME.test(name)) return name;
	return sanitizeToolName(name);
}

/**
 * Deterministically disambiguate a wire name that already collides with one
 * assigned to a different original name: append `_2`, `_3`, … trimming the base
 * so the result never exceeds the 64-char limit.
 */
function dedupeWireName(candidate: string, used: Set<string>): string {
	if (!used.has(candidate)) return candidate;
	for (let n = 2; ; n++) {
		const suffix = `_${n}`;
		const base =
			candidate.length + suffix.length > MAX_TOOL_NAME_LEN
				? candidate.slice(0, MAX_TOOL_NAME_LEN - suffix.length)
				: candidate;
		const next = base + suffix;
		if (!used.has(next)) return next;
	}
}

/**
 * Build a {@link ToolNameGuard} for a request's tool set. Returns the shared
 * no-op guard when the guard is disabled, there are no tools, or every name is
 * already within the provider charset + length (distinct valid names never
 * collide, so no remap is possible).
 */
export function buildToolNameGuard(tools: readonly Tool[] | undefined): ToolNameGuard {
	if (!tools || tools.length === 0 || guardDisabled()) return NOOP_TOOL_NAME_GUARD;

	// Hot path: scan once; if nothing is out of charset/length, no remap needed.
	let needsGuard = false;
	for (const tool of tools) {
		if (tool.name.length > MAX_TOOL_NAME_LEN || !VALID_TOOL_NAME.test(tool.name)) {
			needsGuard = true;
			break;
		}
	}
	if (!needsGuard) return NOOP_TOOL_NAME_GUARD;

	const toWireMap = new Map<string, string>();
	const fromWireMap = new Map<string, string>();
	const used = new Set<string>();
	for (const tool of tools) {
		// Tolerate accidental duplicate tool entries: first mapping wins.
		if (toWireMap.has(tool.name)) continue;
		const wire = dedupeWireName(sanitizeToolName(tool.name), used);
		used.add(wire);
		toWireMap.set(tool.name, wire);
		fromWireMap.set(wire, tool.name);
	}

	return {
		toWire: (name) => toWireMap.get(name) ?? name,
		// Historical replay: prefer the current-tool-set wire name; on a miss the
		// name is from a removed/disconnected tool — sanitize (if invalid) rather
		// than pass it raw. See ToolNameGuard.toWireHistorical for the collision note.
		toWireHistorical: (name) => toWireMap.get(name) ?? sanitizeToolNameIfInvalid(name),
		fromWire: (name) => fromWireMap.get(name) ?? name,
		active: true,
	};
}
