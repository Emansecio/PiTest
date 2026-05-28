/**
 * `agent://` URL scheme — exposes settled subagent results to read tools.
 *
 * Format:
 *   agent://<taskName>                  -> entire SubagentTaskResult as JSON
 *   agent://<taskName>/output           -> result.output as plain text
 *   agent://<taskName>/value            -> JSON.stringify(result.value, null, 2)
 *   agent://<taskName>/value/<path>     -> dotted/index path into result.value
 *
 * Results are written into a module-level Map by `spawnSubagent` when a task
 * settles (success or failure). The map is process-local; it does not survive
 * across CLI invocations.
 *
 * The resolver is intentionally exported as a standalone function so the
 * caller (typically the url-schemes registry, owned by another module) can
 * wire it in at session boot. If the registry is not yet available at runtime,
 * the stub call to `registerAgentScheme` is a no-op aside from the registration
 * itself; consumers can call it later.
 */

import type { SubagentTaskResult } from "./types.ts";

// In-process storage keyed by `taskName`. Last writer wins.
const RESULTS = new Map<string, SubagentTaskResult>();

/** Records a settled task result. Called by `spawnSubagent` on settle. */
export function recordSubagentResult(taskName: string, result: SubagentTaskResult): void {
	RESULTS.set(taskName, result);
}

/** Returns a snapshot of a recorded result, or undefined if not present. */
export function getSubagentResult(taskName: string): SubagentTaskResult | undefined {
	return RESULTS.get(taskName);
}

/** Test seam: lets unit tests prime the result map without spawning a real subagent. */
export function _setResultForTesting(taskName: string, result: SubagentTaskResult): void {
	RESULTS.set(taskName, result);
}

/** Test seam: clears all recorded results. */
export function _clearResultsForTesting(): void {
	RESULTS.clear();
}

export interface AgentUrlReadResult {
	kind: "text" | "error";
	content?: string;
	error?: string;
	mimeType?: string;
}

function walkValue(
	value: unknown,
	segments: readonly string[],
): { ok: true; value: unknown } | { ok: false; error: string } {
	let cursor: unknown = value;
	for (const segment of segments) {
		if (cursor === null || cursor === undefined) {
			return { ok: false, error: `path segment "${segment}" traversed past null/undefined` };
		}
		if (Array.isArray(cursor)) {
			const idx = Number.parseInt(segment, 10);
			if (!Number.isFinite(idx) || idx < 0 || idx >= cursor.length) {
				return { ok: false, error: `array index "${segment}" out of bounds` };
			}
			cursor = cursor[idx];
			continue;
		}
		if (typeof cursor === "object") {
			const record = cursor as Record<string, unknown>;
			if (!Object.hasOwn(record, segment)) {
				return { ok: false, error: `unknown key "${segment}"` };
			}
			cursor = record[segment];
			continue;
		}
		return { ok: false, error: `cannot descend into ${typeof cursor} with segment "${segment}"` };
	}
	return { ok: true, value: cursor };
}

function formatLeaf(value: unknown): string {
	if (value === null || value === undefined) return String(value);
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value, null, 2);
}

/**
 * Resolve an `agent://` URL. Exported as a plain function so it can be wired
 * into any URL-scheme registry shape without coupling to one.
 *
 * The `url` argument is the parsed `URL` object; `url.hostname` is the task
 * name and `url.pathname` is the sub-selector.
 */
export function resolveAgentUrl(url: URL): AgentUrlReadResult {
	if (url.protocol !== "agent:") {
		return { kind: "error", error: `unsupported scheme: ${url.protocol}` };
	}
	const taskName = url.hostname;
	if (!taskName) {
		return { kind: "error", error: "agent:// URL is missing a task name" };
	}
	const result = RESULTS.get(taskName);
	if (!result) {
		return { kind: "error", error: `no subagent result recorded for "${taskName}"` };
	}

	const rawPath = url.pathname.replace(/^\/+/, "");
	if (!rawPath) {
		return { kind: "text", content: JSON.stringify(result, null, 2), mimeType: "application/json" };
	}

	const segments = rawPath.split("/").filter((s) => s.length > 0);
	const head = segments[0];
	const rest = segments.slice(1);

	if (head === "output") {
		if (rest.length > 0) {
			return { kind: "error", error: "agent://<task>/output does not accept a sub-path" };
		}
		return { kind: "text", content: result.output ?? "", mimeType: "text/plain" };
	}

	if (head === "value") {
		if (result.value === undefined) {
			return { kind: "error", error: `task "${taskName}" has no parsed value (no resultSchema?)` };
		}
		if (rest.length === 0) {
			return { kind: "text", content: JSON.stringify(result.value, null, 2), mimeType: "application/json" };
		}
		const walked = walkValue(result.value, rest);
		if (!walked.ok) return { kind: "error", error: walked.error };
		return { kind: "text", content: formatLeaf(walked.value), mimeType: "text/plain" };
	}

	return { kind: "error", error: `unknown agent:// selector "${head}"` };
}

/**
 * Minimal shape required of an URL-scheme registry. We avoid importing the
 * concrete `UrlSchemeRegistry` type here so this module stays decoupled from
 * the (separately-owned) `core/url-schemes` package.
 */
export interface MinimalUrlSchemeRegistry {
	register(resolver: {
		scheme: string;
		read(url: URL, ctx: unknown): Promise<{ kind: string; content?: string; error?: string; mimeType?: string }>;
	}): void;
}

/**
 * Stub registrar. The url-schemes registry is owned elsewhere; this function
 * is exported so a future wire-up can call it from session boot. It is
 * intentionally not invoked at import time.
 */
export function registerAgentScheme(registry: MinimalUrlSchemeRegistry): void {
	registry.register({
		scheme: "agent",
		async read(url) {
			const result = resolveAgentUrl(url);
			if (result.kind === "error") {
				return { kind: "error", error: result.error };
			}
			return { kind: "text", content: result.content, mimeType: result.mimeType };
		},
	});
}
