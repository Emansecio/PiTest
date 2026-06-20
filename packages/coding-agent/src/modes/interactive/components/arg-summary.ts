import { truncateWithEllipsis } from "../../../utils/surrogate.ts";

// Max width of the one-line arg summary shown next to a tool name for tools
// without a custom renderCall.
export const FALLBACK_CALL_SUMMARY_MAX = 80;

/**
 * Compact, single-line preview of a tool call's args for a collapsed row.
 * Scalars render as `key: value`; arrays/objects collapse to `[n]` / `{…}` so
 * a large payload (typical of MCP tools) never expands the row. The whole line
 * is clamped to maxLen.
 */
export function summarizeArgsOneLine(args: unknown, maxLen = FALLBACK_CALL_SUMMARY_MAX): string {
	const clamp = (s: string): string => truncateWithEllipsis(s, maxLen);
	if (typeof args === "string") {
		return clamp(args.replace(/\s+/g, " ").trim());
	}
	if (args === null || typeof args !== "object") {
		return "";
	}
	const parts: string[] = [];
	let joinedLen = 0;
	for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
		if (v === null || v === undefined) continue;
		let val: string;
		if (typeof v === "string") val = v;
		else if (typeof v === "number" || typeof v === "boolean") val = String(v);
		else if (Array.isArray(v)) val = `[${v.length}]`;
		else val = "{…}";
		const part = `${k}: ${val.replace(/\s+/g, " ").trim()}`;
		parts.push(part);
		joinedLen += (parts.length > 1 ? 2 : 0) + part.length;
		// Stop once we already overflow — no point formatting the tail.
		if (joinedLen >= maxLen) break;
	}
	return clamp(parts.join("  "));
}
