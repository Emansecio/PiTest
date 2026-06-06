/**
 * Structural compression ("SmartCrusher") for large JSON / NDJSON tool outputs.
 *
 * Sibling to `collapseRepeatedLines` in truncate.ts: instead of a blind
 * head/tail byte cut, it parses the output and elides the *middle* of large
 * arrays while preserving the schema (object keys), head+tail samples, and the
 * count of omitted items. The result is a one-line header followed by valid
 * pruned JSON, so the summarizer/model keeps the shape of the data at a fraction
 * of the tokens.
 *
 * Design contract — only *upgrades* a reduction that would happen anyway:
 * callers invoke `crushJson` solely when the text already exceeds their budget,
 * and fall back to their existing truncation when it returns `undefined`. It
 * never touches output that would fit. This keeps it cache-safe (pure and
 * deterministic: same input → same output) and never a regression versus the
 * blind cut it replaces.
 */

export interface JsonCrushOptions {
	/** Target character budget for the crushed output. */
	targetChars: number;
	/** Array elements kept from the start of each array (default 3). */
	keepHead?: number;
	/** Array elements kept from the end of each array (default 2). */
	keepTail?: number;
	/** String values longer than this are truncated (default 200). */
	maxStringChars?: number;
}

/**
 * Default target size for a structural crush at the *source* (a tool output),
 * behind the PIT_JSON_CRUSH flag. Smaller than a read's byte budget on purpose:
 * the crush keeps schema + head/tail samples, so a few KB carries the shape of a
 * payload that would otherwise be blindly head-cut. The file/temp output on disk
 * remains the source of truth for any elided detail.
 */
export const JSON_CRUSH_TARGET_BYTES = 8 * 1024;

/** Above this input size we don't attempt to parse — too costly; let the caller's blind cut handle it. */
const MAX_PARSE_CHARS = 5_000_000;
/** Recursion guard for pathologically nested JSON. */
const MAX_DEPTH = 64;

interface Tier {
	keepHead: number;
	keepTail: number;
	maxStringChars: number;
}

type ParseResult = { ok: true; value: unknown } | { ok: false };

function tryParse(text: string): ParseResult {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

function firstNonWhitespace(text: string): string | undefined {
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c !== " " && c !== "\n" && c !== "\t" && c !== "\r") return c;
	}
	return undefined;
}

function elisionMarker(n: number, unit: string): string {
	return `… +${n} ${unit} elided …`;
}

function isElision(v: unknown): v is string {
	return typeof v === "string" && v.includes(" elided …");
}

/**
 * Parse NDJSON (one JSON value per line). Strict: every non-empty line must
 * start with `{`/`[` and parse, otherwise this is not NDJSON (likely a log with
 * mixed prose, or a truncated dump) and we bail to `undefined`.
 */
function tryNdjson(text: string): unknown[] | undefined {
	const lines = text.split("\n");
	const values: unknown[] = [];
	let nonEmpty = 0;
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		nonEmpty++;
		const c = line[0];
		if (c !== "{" && c !== "[") return undefined;
		const r = tryParse(line);
		if (!r.ok) return undefined;
		values.push(r.value);
	}
	if (nonEmpty < 2) return undefined;
	return values;
}

/**
 * Recursively prune a parsed JSON value: collapse large arrays to head+tail with
 * an elision marker, truncate long string values, keep all object keys (the
 * schema is the most valuable signal). Returns a new value; never mutates input.
 */
function pruneValue(value: unknown, tier: Tier, depth: number): unknown {
	if (depth > MAX_DEPTH) return "… (max depth) …";

	if (Array.isArray(value)) {
		const n = value.length;
		if (n <= tier.keepHead + tier.keepTail) {
			return value.map((v) => pruneValue(v, tier, depth + 1));
		}
		const head = value.slice(0, tier.keepHead).map((v) => pruneValue(v, tier, depth + 1));
		const tail = tier.keepTail > 0 ? value.slice(n - tier.keepTail).map((v) => pruneValue(v, tier, depth + 1)) : [];
		const omitted = n - tier.keepHead - tier.keepTail;
		return [...head, elisionMarker(omitted, "items"), ...tail];
	}

	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = pruneValue(v, tier, depth + 1);
		}
		return out;
	}

	if (typeof value === "string" && value.length > tier.maxStringChars) {
		return `${value.slice(0, tier.maxStringChars)}…(+${value.length - tier.maxStringChars} chars)`;
	}

	return value;
}

/** Emit a pruned NDJSON array as one line per kept item (markers stay unquoted). */
function emitNdjson(pruned: unknown): string {
	if (!Array.isArray(pruned)) return JSON.stringify(pruned);
	return pruned.map((item) => (isElision(item) ? item : JSON.stringify(item))).join("\n");
}

/**
 * Try increasingly aggressive tiers until the crushed output fits `targetChars`.
 * Returns `undefined` when even the minimal tier overflows — the caller then
 * falls back to its own truncation.
 */
function emit(parsed: unknown, originalLen: number, opts: JsonCrushOptions, ndjson: boolean): string | undefined {
	const tiers: Tier[] = [
		{ keepHead: opts.keepHead ?? 3, keepTail: opts.keepTail ?? 2, maxStringChars: opts.maxStringChars ?? 200 },
		{ keepHead: 2, keepTail: 1, maxStringChars: 120 },
		{ keepHead: 1, keepTail: 1, maxStringChars: 80 },
		{ keepHead: 1, keepTail: 0, maxStringChars: 40 },
	];
	const header = `[crushed JSON — ${originalLen} chars original]\n`;
	for (const tier of tiers) {
		const pruned = pruneValue(parsed, tier, 0);
		const body = ndjson ? emitNdjson(pruned) : JSON.stringify(pruned, null, 1);
		const out = header + body;
		if (out.length <= opts.targetChars) return out;
	}
	return undefined;
}

/**
 * Structurally compress a large JSON/NDJSON string to ~`targetChars`, preserving
 * schema + head/tail samples + omitted counts. Returns `undefined` when not
 * applicable (not JSON, already fits, too large to parse, or won't fit even when
 * fully collapsed) so the caller can fall back to its existing truncation.
 */
export function crushJson(text: string, opts: JsonCrushOptions): string | undefined {
	if (text.length <= opts.targetChars) return undefined;
	if (text.length > MAX_PARSE_CHARS) return undefined;

	const firstChar = firstNonWhitespace(text);
	if (firstChar === "{" || firstChar === "[") {
		const r = tryParse(text);
		if (r.ok && r.value !== null && typeof r.value === "object") {
			return emit(r.value, text.length, opts, false);
		}
	}

	const nd = tryNdjson(text);
	if (nd) return emit(nd, text.length, opts, true);

	return undefined;
}
