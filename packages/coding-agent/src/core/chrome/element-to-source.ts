/**
 * Element-to-source — from a clicked element / CSS selector in a live Chrome page
 * to the HANDLER in the ORIGINAL source code (file:line), through CDP.
 *
 * Flow (all over the generic `send()` of cdp-client):
 *   DOM.getDocument → DOM.querySelector(selector) → DOM.resolveNode → objectId
 *   → DOMDebugger.getEventListeners(objectId) → per listener {scriptId, line, col, type}
 *   → Debugger.getScriptSource(scriptId) (+ the script's sourceMapURL, or the
 *     trailing //# sourceMappingURL= comment) → decode the source map → ORIGINAL
 *     position. With no source map we degrade cleanly to the transpiled position
 *     (scriptId/url:line) and flag `mapped:false`.
 *
 * Native + default-ON: it enables DOM / DOMDebugger / Debugger ON-DEMAND here (the
 * same on-demand pattern as Accessibility.enable in chrome-devtools-manager), so it
 * adds nothing to the boot auto-enable set. No setting, no flag — the action ships
 * active wherever a dev source map exists; when it doesn't, the transpiled position
 * is still useful and the caller is told so.
 *
 * Fail-safe by construction: every CDP step is wrapped; a missing domain, an
 * inline data: source map, a base64 / external map, or a malformed VLQ segment all
 * degrade to "transpiled position, mapped:false" instead of throwing. The only hard
 * error is "selector matched no element" (the caller asked about nothing).
 */

// --- Injected transport ----------------------------------------------------

/**
 * The generic CDP `send()` — exactly the shape of CdpConnection.send in
 * cdp-client.ts / CdpConnectionLike in chrome-devtools-manager.ts. Injected so the
 * module is transport-agnostic and trivially testable with a fake.
 */
export type CdpSend = (
	method: string,
	params?: Record<string, unknown>,
	opts?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<any>;

/**
 * Optional LSP bridge: given a transpiled-or-original {file,line,column}, return a
 * refined symbol/definition position. Absent = skipped (the feature degrades to the
 * source-map position alone). Kept dependency-injected so this module never imports
 * the LSP layer directly (no cross-layer coupling).
 */
export type LspResolve = (pos: SourcePosition) => Promise<SourcePosition | undefined>;

export interface ElementToSourceDeps {
	send: CdpSend;
	signal?: AbortSignal;
	/** OPTIONAL — refine a resolved position to its declaring symbol via LSP. */
	lspResolve?: LspResolve;
	/**
	 * OPTIONAL fetcher for EXTERNAL source maps (sourceMappingURL is a real URL,
	 * not an inline data: URI). Absent = external maps are skipped and we degrade
	 * to the transpiled position. Injected so the module does no I/O of its own.
	 */
	fetchText?: (url: string) => Promise<string | undefined>;
}

// --- Result shapes ---------------------------------------------------------

export interface SourcePosition {
	/** Original source path when mapped, else the script URL (or `script#<id>`). */
	file: string;
	/** 1-based line (CDP line/column numbers are 0-based; we present 1-based). */
	line: number;
	/** 1-based column. */
	column: number;
}

export interface ResolvedListener {
	/** DOM event type, e.g. "click", "submit". */
	type: string;
	source: SourcePosition;
	/** true = position came from a source map; false = transpiled position. */
	mapped: boolean;
	/** Original symbol name from the source map's `names`, when available. */
	name?: string;
	/** Set when degraded: why this listener could not be mapped to source. */
	note?: string;
}

export interface ElementToSourceResult {
	listeners: ResolvedListener[];
	/** Present only when nothing could be resolved for a non-error reason. */
	note?: string;
}

// --- Raw CDP shapes (subset we consume) ------------------------------------

interface RawListener {
	type: string;
	scriptId?: string;
	lineNumber?: number;
	columnNumber?: number;
}

interface ParsedSourceMap {
	sources: string[];
	names: string[];
	sourceRoot?: string;
	// Decoded mappings, grouped by generated line. Each segment is
	// [genCol, srcIndex, srcLine, srcCol, nameIndex?]. We keep only what we need.
	byGenLine: Array<Array<{ genCol: number; srcIndex: number; srcLine: number; srcCol: number; nameIndex: number }>>;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Resolve every event listener bound to the element matching `selector` to its
 * handler position in source. See module doc for the flow + degradation contract.
 */
export async function resolveElementToSource(
	deps: ElementToSourceDeps,
	selector: string,
): Promise<ElementToSourceResult> {
	const { send, signal } = deps;

	// Enable the domains we use, ON-DEMAND (never throws — a target that lacks one
	// of these still lets the later call fail soft into a degraded result).
	await enableDomain(send, "DOM.enable", signal);
	await enableDomain(send, "DOMDebugger.enable", signal);
	// Debugger.enable streams scriptParsed events and is what makes scriptId →
	// source resolvable; if it is unavailable we still return transpiled positions.
	await enableDomain(send, "Debugger.enable", signal);

	const objectId = await resolveObjectId(send, selector, signal);
	if (!objectId) {
		// Hard error: the caller asked about an element that does not exist.
		throw new Error(`No element matches selector ${JSON.stringify(selector)}.`);
	}

	const rawListeners = await getEventListeners(send, objectId, signal);
	if (rawListeners.length === 0) {
		return { listeners: [], note: `No event listeners bound to ${JSON.stringify(selector)}.` };
	}

	// Cache script source + parsed map per scriptId so N listeners on the same
	// script don't re-fetch / re-parse (handlers commonly share a bundle).
	const scriptCache = new Map<string, { url: string; map: ParsedSourceMap | undefined; mapNote?: string }>();

	const listeners: ResolvedListener[] = [];
	for (const raw of rawListeners) {
		listeners.push(await resolveOneListener(deps, raw, scriptCache));
	}
	return { listeners };
}

// ---------------------------------------------------------------------------
// Per-listener resolution.
// ---------------------------------------------------------------------------

async function resolveOneListener(
	deps: ElementToSourceDeps,
	raw: RawListener,
	scriptCache: Map<string, { url: string; map: ParsedSourceMap | undefined; mapNote?: string }>,
): Promise<ResolvedListener> {
	const { lspResolve } = deps;
	const type = raw.type || "(unknown)";
	const genLine = raw.lineNumber ?? 0;
	const genCol = raw.columnNumber ?? 0;

	if (!raw.scriptId) {
		// Native / anonymous listener with no script position (e.g. attribute
		// handler the runtime didn't attribute). Nothing to map.
		return { type, source: { file: "(native)", line: 1, column: 1 }, mapped: false, note: "no scriptId" };
	}

	let cached = scriptCache.get(raw.scriptId);
	if (!cached) {
		cached = await loadScript(deps, raw.scriptId);
		scriptCache.set(raw.scriptId, cached);
	}

	const transpiled: SourcePosition = {
		file: cached.url || `script#${raw.scriptId}`,
		line: genLine + 1,
		column: genCol + 1,
	};

	if (!cached.map) {
		const refined = lspResolve ? await safeLsp(lspResolve, transpiled) : undefined;
		return {
			type,
			source: refined ?? transpiled,
			mapped: false,
			note: cached.mapNote ?? "no source map",
		};
	}

	const original = mapPosition(cached.map, genLine, genCol);
	if (!original) {
		// Source map present but this generated position isn't covered by any
		// segment — degrade to transpiled rather than guessing.
		return { type, source: transpiled, mapped: false, note: "position not in source map" };
	}

	const mappedPos: SourcePosition = {
		file: resolveSourcePath(cached.map, original.srcIndex, cached.url),
		line: original.srcLine + 1,
		column: original.srcCol + 1,
	};
	const name = original.nameIndex >= 0 ? cached.map.names[original.nameIndex] : undefined;
	const refined = lspResolve ? await safeLsp(lspResolve, mappedPos) : undefined;
	return {
		type,
		source: refined ?? mappedPos,
		mapped: true,
		...(name ? { name } : {}),
	};
}

// ---------------------------------------------------------------------------
// CDP steps (each fail-soft).
// ---------------------------------------------------------------------------

/** Enable a CDP domain on-demand. Never throws — a missing domain just degrades. */
async function enableDomain(send: CdpSend, method: string, signal?: AbortSignal): Promise<void> {
	try {
		await send(method, {}, { signal });
	} catch {
		// Domain unavailable on this target type; downstream calls degrade.
	}
}

/** DOM.getDocument → querySelector → resolveNode, returning a Runtime objectId. */
async function resolveObjectId(send: CdpSend, selector: string, signal?: AbortSignal): Promise<string | undefined> {
	let rootId: number | undefined;
	try {
		const doc = await send("DOM.getDocument", { depth: 1 }, { signal });
		rootId = doc?.root?.nodeId;
	} catch {
		return undefined;
	}
	if (typeof rootId !== "number") return undefined;

	let nodeId: number | undefined;
	try {
		const q = await send("DOM.querySelector", { nodeId: rootId, selector }, { signal });
		nodeId = q?.nodeId;
	} catch {
		return undefined;
	}
	// querySelector returns nodeId 0 (falsy) when nothing matched.
	if (!nodeId) return undefined;

	try {
		const resolved = await send("DOM.resolveNode", { nodeId }, { signal });
		const objectId = resolved?.object?.objectId;
		return typeof objectId === "string" ? objectId : undefined;
	} catch {
		return undefined;
	}
}

/** DOMDebugger.getEventListeners(objectId) → the listeners with script positions. */
async function getEventListeners(send: CdpSend, objectId: string, signal?: AbortSignal): Promise<RawListener[]> {
	try {
		// depth/pierce default fine; we only need the script attribution fields.
		const res = await send("DOMDebugger.getEventListeners", { objectId }, { signal });
		const arr = Array.isArray(res?.listeners) ? res.listeners : [];
		return arr as RawListener[];
	} catch {
		return [];
	}
}

/**
 * Load a script's URL + parsed source map (if any). Tries, in order:
 *  1. Debugger.getScriptSource → scriptSource (so we can read a trailing
 *     //# sourceMappingURL= comment and the inline source itself).
 *  2. The script's own sourceMapURL — but we don't have scriptParsed metadata
 *     handy here, so we rely on the trailing comment in the source, which covers
 *     the dev-server / esbuild / vite common case.
 * Inline (data: base64/utf8) maps are decoded directly; external URLs use
 * deps.fetchText when provided, else degrade.
 */
async function loadScript(
	deps: ElementToSourceDeps,
	scriptId: string,
): Promise<{ url: string; map: ParsedSourceMap | undefined; mapNote?: string }> {
	const { send, signal } = deps;
	let source = "";
	let url = "";
	try {
		const res = await send("Debugger.getScriptSource", { scriptId }, { signal });
		source = typeof res?.scriptSource === "string" ? res.scriptSource : "";
		// Some Chrome builds echo the url back; tolerate its absence.
		url = typeof res?.url === "string" ? res.url : "";
	} catch {
		return { url: "", map: undefined, mapNote: "script source unavailable" };
	}

	const mapUrl = extractSourceMappingURL(source);
	if (!mapUrl) return { url, map: undefined, mapNote: "no sourceMappingURL" };

	const rawMap = await loadSourceMapText(deps, mapUrl);
	if (rawMap === undefined) {
		return { url, map: undefined, mapNote: "source map not retrievable" };
	}
	const parsed = parseSourceMap(rawMap);
	if (!parsed) return { url, map: undefined, mapNote: "source map unparseable" };
	return { url, map: parsed };
}

/** Resolve a sourceMappingURL to its raw JSON: inline data: URI or external fetch. */
async function loadSourceMapText(deps: ElementToSourceDeps, mapUrl: string): Promise<string | undefined> {
	if (mapUrl.startsWith("data:")) {
		return decodeDataUri(mapUrl);
	}
	// External map — only retrievable with an injected fetcher.
	if (!deps.fetchText) return undefined;
	try {
		return await deps.fetchText(mapUrl);
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Source-map parsing (minimal, dependency-free).
// ---------------------------------------------------------------------------

/** Find the LAST `//# sourceMappingURL=...` (or the older `//@`) in the source. */
export function extractSourceMappingURL(source: string): string | undefined {
	// Scan from the end: bundlers emit the comment last; a string literal earlier
	// in the file could otherwise be a false positive.
	const re = /\/\/[#@]\s*sourceMappingURL=(\S+)/g;
	let last: string | undefined;
	let m = re.exec(source);
	while (m) {
		last = m[1];
		m = re.exec(source);
	}
	return last;
}

/** Decode a `data:application/json;base64,...` or `;charset=utf-8,...` URI to text. */
export function decodeDataUri(uri: string): string | undefined {
	const comma = uri.indexOf(",");
	if (comma < 0) return undefined;
	const meta = uri.slice(5, comma); // after "data:"
	const payload = uri.slice(comma + 1);
	try {
		if (/;base64/i.test(meta)) {
			return Buffer.from(payload, "base64").toString("utf8");
		}
		return decodeURIComponent(payload);
	} catch {
		return undefined;
	}
}

/** Parse a source map JSON into the lookup structure we use. Returns undefined on bad input. */
export function parseSourceMap(raw: string): ParsedSourceMap | undefined {
	let json: {
		mappings?: unknown;
		sources?: unknown;
		names?: unknown;
		sourceRoot?: unknown;
		sections?: unknown;
	};
	try {
		json = JSON.parse(raw);
	} catch {
		return undefined;
	}
	// Indexed (sectioned) maps are uncommon for dev bundles; we don't decode them —
	// degrade to transpiled rather than mis-map.
	if (json.sections !== undefined) return undefined;
	if (typeof json.mappings !== "string" || !Array.isArray(json.sources)) return undefined;

	const sources = (json.sources as unknown[]).map((s) => (typeof s === "string" ? s : ""));
	const names = Array.isArray(json.names)
		? (json.names as unknown[]).map((n) => (typeof n === "string" ? n : ""))
		: [];
	const sourceRoot = typeof json.sourceRoot === "string" ? json.sourceRoot : undefined;
	const byGenLine = decodeMappings(json.mappings as string);
	return { sources, names, sourceRoot, byGenLine };
}

/**
 * Decode VLQ `mappings`. Segments are comma-separated, lines semicolon-separated.
 * Fields are DELTAS (relative to the previous segment) for: generated column,
 * source index, source line, source column, name index. We keep the running
 * absolutes per the standard V3 reset rules (only generated column resets per line).
 */
function decodeMappings(
	mappings: string,
): Array<Array<{ genCol: number; srcIndex: number; srcLine: number; srcCol: number; nameIndex: number }>> {
	const result: Array<
		Array<{ genCol: number; srcIndex: number; srcLine: number; srcCol: number; nameIndex: number }>
	> = [];
	let srcIndex = 0;
	let srcLine = 0;
	let srcCol = 0;
	let nameIndex = 0;
	const lines = mappings.split(";");
	for (const lineStr of lines) {
		let genCol = 0; // resets every generated line
		const segments: Array<{ genCol: number; srcIndex: number; srcLine: number; srcCol: number; nameIndex: number }> =
			[];
		if (lineStr.length > 0) {
			for (const seg of lineStr.split(",")) {
				if (seg.length === 0) continue;
				const fields = decodeVlqSegment(seg);
				if (fields.length === 0) continue;
				genCol += fields[0];
				if (fields.length >= 4) {
					srcIndex += fields[1];
					srcLine += fields[2];
					srcCol += fields[3];
					let segName = -1;
					if (fields.length >= 5) {
						nameIndex += fields[4];
						segName = nameIndex;
					}
					segments.push({ genCol, srcIndex, srcLine, srcCol, nameIndex: segName });
				}
				// A 1-field segment (generated col only, no source) carries no source
				// position — skip it for lookup purposes.
			}
		}
		// Segments within a line are emitted in increasing genCol order already.
		result.push(segments);
	}
	return result;
}

const VLQ_BASE_SHIFT = 5;
const VLQ_BASE = 1 << VLQ_BASE_SHIFT; // 32
const VLQ_BASE_MASK = VLQ_BASE - 1; // 31
const VLQ_CONTINUATION = VLQ_BASE; // 32
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decode one base64-VLQ segment string into its integer fields. */
function decodeVlqSegment(segment: string): number[] {
	const out: number[] = [];
	let shift = 0;
	let value = 0;
	for (let i = 0; i < segment.length; i++) {
		const digit = BASE64.indexOf(segment[i]);
		if (digit === -1) return out; // malformed char: stop, fail-soft
		// A field wider than 32 bits cannot be represented by JS `<<` (it shifts
		// mod 32, silently corrupting the value). Bail out fail-soft on an
		// over-long VLQ run and accumulate into a Number via `2**shift` so the
		// in-range case stays exact without relying on signed 32-bit shifts.
		if (shift >= 32) return out;
		const hasContinuation = (digit & VLQ_CONTINUATION) !== 0;
		value += (digit & VLQ_BASE_MASK) * 2 ** shift;
		if (hasContinuation) {
			shift += VLQ_BASE_SHIFT;
		} else {
			if (value > Number.MAX_SAFE_INTEGER) return out; // overflowed: fail-soft
			// Last bit of the accumulated value is the sign.
			const shouldNegate = (value & 1) === 1;
			const magnitude = Math.floor(value / 2);
			out.push(shouldNegate ? -magnitude : magnitude);
			value = 0;
			shift = 0;
		}
	}
	return out;
}

/**
 * Find the original position for a generated (line, column). Standard binary/linear
 * search: the covering segment is the one with the greatest genCol ≤ the target on
 * that generated line.
 */
function mapPosition(
	map: ParsedSourceMap,
	genLine: number,
	genCol: number,
): { srcIndex: number; srcLine: number; srcCol: number; nameIndex: number } | undefined {
	const segs = map.byGenLine[genLine];
	if (!segs || segs.length === 0) return undefined;
	let best: (typeof segs)[number] | undefined;
	for (const seg of segs) {
		if (seg.genCol <= genCol) {
			best = seg;
		} else {
			break; // segments are sorted by genCol ascending
		}
	}
	// If the column is before the first segment, fall back to the first one (the
	// handler often starts a hair before the recorded column).
	const chosen = best ?? segs[0];
	return { srcIndex: chosen.srcIndex, srcLine: chosen.srcLine, srcCol: chosen.srcCol, nameIndex: chosen.nameIndex };
}

/** Compose the final source path from sourceRoot + sources[idx], best-effort. */
function resolveSourcePath(map: ParsedSourceMap, srcIndex: number, scriptUrl: string): string {
	const raw = map.sources[srcIndex] ?? "";
	if (!raw) return scriptUrl || "(unknown source)";
	const root = map.sourceRoot ?? "";
	if (!root) return raw;
	// Join sourceRoot + source the way the V3 spec does (simple concat with a slash).
	const sep = root.endsWith("/") || raw.startsWith("/") ? "" : "/";
	return `${root}${sep}${raw}`;
}

/** Run the optional LSP refinement, swallowing its failures (it's an enhancement). */
async function safeLsp(lspResolve: LspResolve, pos: SourcePosition): Promise<SourcePosition | undefined> {
	try {
		return await lspResolve(pos);
	} catch {
		return undefined;
	}
}
