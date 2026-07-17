/**
 * Tool-call JSON repair + schema coercion.
 *
 * When a model emits malformed or type-mismatched tool arguments, this layer
 * silently fixes them BEFORE TypeBox validation instead of failing the call and
 * burning a model round-trip. It is native / default-on, with a single
 * kill-switch (`PIT_NO_TOOLCALL_REPAIR=1`).
 *
 * Precedence in the agent loop (see agent-loop.ts `prepareToolCall`):
 *   1. curated tool-rewrite registries WIN — they run first, unchanged;
 *   2. structural repair — only when the raw arguments are a STRING that fails
 *      JSON.parse (fence strip + `jsonrepair`);
 *   3. schema coercion — walk parsed args against the tool's JSON schema and
 *      coerce type mismatches (the higher-value tier);
 *   4. the existing `validateToolArguments` runs as today.
 *
 * Design adapted from forgecode's `forge_json_repair` coercion table.
 *
 * IMPORTANT LIMITATION (structural tier). By the time arguments reach the agent
 * loop the provider layer (`@pit/ai` `finalizeStreamingJson`) has ALREADY parsed
 * the tool-call JSON — running JSON.parse → `repairJson` → `partial-json`, and
 * on total failure yielding `{}` with a `_streamingParseError` marker. So a raw
 * malformed *whole-arguments* string almost never reaches this module: the
 * structural tier here is a defensive fallback (a custom streamFn, or a string
 * VALUE inside the args that is itself stringified JSON). The high-value work is
 * the schema-coercion tier, which the provider does NOT do. We deliberately do
 * not reach into `@pit/ai`'s parse path.
 *
 * Pure functions + a small module-level stats counter. No dependency on the
 * agent loop, so it stays trivially testable.
 */

import { recordDiagnostic } from "@pit/ai";
import { jsonrepair } from "jsonrepair";

/** The distinct repair operations this module can apply, for stats + notes. */
export type ToolArgRepairKind =
	/** Whole-arguments string parsed/repaired into an object (structural tier). */
	| "structural_json"
	/** Markdown code fences (```json … ```) stripped before a parse. */
	| "fence_strip"
	/** Numeric string coerced to number/integer ("42" → 42, "4.2" → 4.2). */
	| "number_from_string"
	/** Boolean literal string coerced ("true"/"false" → boolean). */
	| "boolean_from_string"
	/** Empty string dropped for an optional field ("" → omit). */
	| "empty_to_undefined"
	/** Empty string coerced to null for a nullable field ("" → null). */
	| "empty_to_null"
	/** JSON-stringified array parsed for an array field ("[1,2]" → [1,2]). */
	| "json_string_to_array"
	/** JSON-stringified object parsed for an object field ('{"a":1}' → {a:1}). */
	| "json_string_to_object"
	/** Double-encoded JSON string unwrapped (up to 4 levels). */
	| "unwrap_double_encoded"
	/** Array extracted from surrounding garbage ("x[1,2]y" → [1,2]). */
	| "array_from_garbage"
	/** Single value wrapped for an array field (v → [v]). */
	| "wrap_single_in_array"
	/** Enum value fixed by case-insensitive match to a member ("READ" → "read"). */
	| "enum_case_fix";

export interface ToolArgRepairResult {
	/** The repaired arguments. Same reference as the input when nothing changed. */
	args: unknown;
	/** The repairs applied, in application order. Empty when untouched. */
	repairs: ToolArgRepairKind[];
}

// --- Kill-switch --------------------------------------------------------------

/**
 * `PIT_NO_TOOLCALL_REPAIR=1` disables BOTH tiers (structural + coercion). The
 * curated tool-rewrite registries are unaffected — they run before this layer.
 */
export function isToolCallRepairDisabled(): boolean {
	const raw = typeof process !== "undefined" ? process.env.PIT_NO_TOOLCALL_REPAIR : undefined;
	if (!raw) return false;
	const v = raw.toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

// --- Stats / observability ----------------------------------------------------

export interface ToolArgRepairStats {
	/** Total repair operations recorded since the last reset. */
	total: number;
	/** Per-tool → per-kind counts. */
	byTool: Record<string, Partial<Record<ToolArgRepairKind, number>>>;
	/** Per-kind totals across all tools. */
	byKind: Partial<Record<ToolArgRepairKind, number>>;
}

interface RepairStatsState {
	total: number;
	byTool: Map<string, Map<ToolArgRepairKind, number>>;
	byKind: Map<ToolArgRepairKind, number>;
}

// Process-global singleton (mirrors runtime-diagnostics): dist and src copies of
// this module under test still share one tally rather than each keeping a
// private, invisible one.
const GLOBAL_KEY = "__pitToolArgRepairStats__";

function getStatsState(): RepairStatsState {
	const holder = globalThis as typeof globalThis & { [GLOBAL_KEY]?: RepairStatsState };
	let state = holder[GLOBAL_KEY];
	if (!state) {
		state = { total: 0, byTool: new Map(), byKind: new Map() };
		holder[GLOBAL_KEY] = state;
	}
	return state;
}

/** Snapshot of repair counts per (tool, kind). Safe to call anytime. */
export function getToolArgRepairStats(): ToolArgRepairStats {
	const state = getStatsState();
	const byTool: ToolArgRepairStats["byTool"] = {};
	for (const [tool, kinds] of state.byTool) {
		const entry: Partial<Record<ToolArgRepairKind, number>> = {};
		for (const [kind, count] of kinds) entry[kind] = count;
		byTool[tool] = entry;
	}
	const byKind: Partial<Record<ToolArgRepairKind, number>> = {};
	for (const [kind, count] of state.byKind) byKind[kind] = count;
	return { total: state.total, byTool, byKind };
}

/** Reset the tally. Intended for tests. */
export function resetToolArgRepairStats(): void {
	const state = getStatsState();
	state.total = 0;
	state.byTool.clear();
	state.byKind.clear();
}

function recordRepairs(toolName: string, repairs: ToolArgRepairKind[]): void {
	if (repairs.length === 0) return;
	const state = getStatsState();
	let toolMap = state.byTool.get(toolName);
	if (!toolMap) {
		toolMap = new Map();
		state.byTool.set(toolName, toolMap);
	}
	for (const kind of repairs) {
		state.total += 1;
		toolMap.set(kind, (toolMap.get(kind) ?? 0) + 1);
		state.byKind.set(kind, (state.byKind.get(kind) ?? 0) + 1);
		// One observable line per repair on the shared diagnostics channel. The
		// category is not in @pit/ai's closed `DiagnosticCategory` union (that file
		// is out of scope for this change), so the value is asserted to the param
		// type rather than editing the union; `getToolArgRepairStats()` is the
		// typed, first-class observability API.
		recordDiagnostic({
			category: "tool.arg-repair" as Parameters<typeof recordDiagnostic>[0]["category"],
			level: "info",
			source: "agent-loop.toolArgRepair",
			context: { toolName, mechanism: kind },
		});
	}
}

// --- Minimal JSON-schema view (typebox schemas ARE JSON Schema at runtime) -----

interface JsonSchema {
	type?: string | string[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema | JsonSchema[];
	enum?: unknown[];
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	nullable?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSchema(value: unknown): JsonSchema | undefined {
	return typeof value === "object" && value !== null ? (value as JsonSchema) : undefined;
}

function typeList(t: string | string[] | undefined): string[] {
	if (typeof t === "string") return [t];
	if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
	return [];
}

/** All JSON types a schema admits directly or through a union branch. */
function effectiveTypes(schema: JsonSchema): string[] {
	const set = new Set<string>(typeList(schema.type));
	for (const branch of [schema.anyOf, schema.oneOf]) {
		if (!Array.isArray(branch)) continue;
		for (const member of branch) {
			const sub = asSchema(member);
			if (sub) for (const t of typeList(sub.type)) set.add(t);
		}
	}
	return [...set];
}

function isNullable(schema: JsonSchema): boolean {
	return schema.nullable === true || effectiveTypes(schema).includes("null");
}

function jsonKind(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	const t = typeof value;
	if (t === "number") return Number.isInteger(value) ? "integer" : "number";
	return t;
}

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return isRecord(value);
		default:
			return false;
	}
}

/** Item schema for an array field. Tuple `items` handled per-index by the caller. */
function itemSchemaFor(schema: JsonSchema, index: number): JsonSchema | undefined {
	if (Array.isArray(schema.items)) return asSchema(schema.items[index]);
	return asSchema(schema.items);
}

// --- Structural helpers -------------------------------------------------------

const FENCE_RE = /^\s*```[^\n`]*\n?([\s\S]*?)\n?\s*```\s*$/;

/** Strip a single surrounding markdown code fence. Returns whether it stripped. */
function stripFences(text: string): { text: string; stripped: boolean } {
	const m = text.match(FENCE_RE);
	if (m && typeof m[1] === "string") return { text: m[1], stripped: true };
	return { text, stripped: false };
}

/** JSON.parse, then a `jsonrepair` fallback. Returns undefined when both fail. */
function structuralParse(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		// fall through
	}
	try {
		return JSON.parse(jsonrepair(trimmed));
	} catch {
		return undefined;
	}
}

/**
 * Extract the first balanced `open…close` region, respecting quoted strings so
 * a bracket inside a string literal does not unbalance the scan. Surrogate-safe:
 * every character compared/sliced on is ASCII (`[ ] { } " \`), never part of a
 * surrogate pair, so scanning by UTF-16 code unit cannot split an astral char.
 */
function extractBalanced(text: string, open: string, close: string): string | undefined {
	const start = text.indexOf(open);
	if (start === -1) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
			continue;
		}
		if (c === open) depth++;
		else if (c === close) {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return undefined;
}

/** Strict numeric-string test (no hex, no whitespace-only, finite). */
function strictNumeric(value: string, requireInteger: boolean): number | undefined {
	const t = value.trim();
	if (!/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return undefined;
	const n = Number(t);
	if (!Number.isFinite(n)) return undefined;
	if (requireInteger && !Number.isInteger(n)) return undefined;
	// Refuse to coerce when the number cannot round-trip to its source text:
	// large integers past 2^53 lose precision, and forms like "007"/"+5"/"1e3"
	// would change surface value. Leave the string for validation instead.
	if (requireInteger && !Number.isSafeInteger(n)) return undefined;
	if (String(n) !== t) return undefined;
	return n;
}

function boolLiteral(value: string): boolean | undefined {
	const t = value.trim().toLowerCase();
	if (t === "true") return true;
	if (t === "false") return false;
	return undefined;
}

// --- Coercion walker ----------------------------------------------------------

function coerceEnum(value: unknown, members: unknown[]): ToolArgRepairResult {
	// Never coerce enums except an exact case-insensitive match to a member.
	if (members.includes(value)) return { args: value, repairs: [] };
	if (typeof value === "string") {
		const lower = value.toLowerCase();
		const match = members.find((m) => typeof m === "string" && m.toLowerCase() === lower);
		if (match !== undefined) return { args: match, repairs: ["enum_case_fix"] };
	}
	return { args: value, repairs: [] };
}

/** Parse a string into an array for an array-typed field, else undefined. */
function stringToArray(value: string, schema: JsonSchema): ToolArgRepairResult | undefined {
	const repairs: ToolArgRepairKind[] = [];
	const fence = stripFences(value);
	const text = fence.text;
	if (fence.stripped) repairs.push("fence_strip");

	// Direct + double-encoded parse.
	let parsed = structuralParse(text);
	let depth = 0;
	while (typeof parsed === "string" && depth < 4) {
		const next = structuralParse(parsed);
		if (next === undefined) break;
		parsed = next;
		depth++;
	}
	if (Array.isArray(parsed)) {
		repairs.push("json_string_to_array");
		if (depth > 0) repairs.push("unwrap_double_encoded");
		return descendArray(parsed, schema, repairs);
	}

	// Array embedded in surrounding garbage: "prefix[1,2]suffix".
	const extracted = extractBalanced(text, "[", "]");
	if (extracted) {
		const g = structuralParse(extracted);
		if (Array.isArray(g)) {
			repairs.push("array_from_garbage");
			return descendArray(g, schema, repairs);
		}
	}

	// Single value → [value] when the coerced element fits the item type.
	const itemSchema = itemSchemaFor(schema, 0);
	const elem = itemSchema ? coerceValue(value, itemSchema) : { args: value, repairs: [] as ToolArgRepairKind[] };
	const itemTypes = itemSchema ? effectiveTypes(itemSchema) : [];
	const fits = itemTypes.length === 0 || itemTypes.some((t) => matchesType(elem.args, t));
	if (fits) {
		return { args: [elem.args], repairs: [...repairs, "wrap_single_in_array", ...elem.repairs] };
	}
	return undefined;
}

/** Parse a string into an object for an object-typed field, else undefined. */
function stringToObject(value: string, schema: JsonSchema): ToolArgRepairResult | undefined {
	const repairs: ToolArgRepairKind[] = [];
	const fence = stripFences(value);
	const text = fence.text;
	if (fence.stripped) repairs.push("fence_strip");

	let parsed = structuralParse(text);
	let depth = 0;
	while (typeof parsed === "string" && depth < 4) {
		const next = structuralParse(parsed);
		if (next === undefined) break;
		parsed = next;
		depth++;
	}
	if (isRecord(parsed)) {
		repairs.push("json_string_to_object");
		if (depth > 0) repairs.push("unwrap_double_encoded");
		return coerceObject(parsed, schema, repairs);
	}

	const extracted = extractBalanced(text, "{", "}");
	if (extracted) {
		const g = structuralParse(extracted);
		if (isRecord(g)) {
			repairs.push("json_string_to_object");
			return coerceObject(g, schema, repairs);
		}
	}
	return undefined;
}

function descendArray(value: unknown[], schema: JsonSchema, seed: ToolArgRepairKind[]): ToolArgRepairResult {
	const repairs = seed;
	let out: unknown[] | undefined;
	for (let i = 0; i < value.length; i++) {
		const itemSchema = itemSchemaFor(schema, i);
		if (!itemSchema) continue;
		const r = coerceValue(value[i], itemSchema);
		if (r.args !== value[i]) {
			if (!out) out = value.slice();
			out[i] = r.args;
		}
		if (r.repairs.length) repairs.push(...r.repairs);
	}
	return { args: out ?? value, repairs };
}

function coerceStringValue(value: string, schema: JsonSchema, types: string[]): ToolArgRepairResult {
	const wantsArray = types.includes("array") && !types.includes("string");
	if (wantsArray) {
		const r = stringToArray(value, schema);
		if (r) return r;
	}
	const wantsObject = types.includes("object") && !types.includes("string");
	if (wantsObject) {
		const r = stringToObject(value, schema);
		if (r) return r;
	}
	if ((types.includes("number") || types.includes("integer")) && !types.includes("string")) {
		const requireInteger = types.includes("integer") && !types.includes("number");
		const n = strictNumeric(value, requireInteger);
		if (n !== undefined) return { args: n, repairs: ["number_from_string"] };
	}
	if (types.includes("boolean") && !types.includes("string")) {
		const b = boolLiteral(value);
		if (b !== undefined) return { args: b, repairs: ["boolean_from_string"] };
	}
	return { args: value, repairs: [] };
}

/** Coerce a single value against a property schema. Returns same ref if untouched. */
function coerceValue(value: unknown, schema: JsonSchema): ToolArgRepairResult {
	if (Array.isArray(schema.enum)) return coerceEnum(value, schema.enum);

	const types = effectiveTypes(schema);

	// Already the right container shape → descend for nested coercion only.
	if (Array.isArray(value)) {
		if (types.includes("array")) return descendArray(value, schema, []);
		return { args: value, repairs: [] };
	}
	if (isRecord(value)) {
		if (types.includes("object")) return coerceObject(value, schema, []);
		return { args: value, repairs: [] };
	}

	// String source: structured parse, then primitive coercion.
	if (typeof value === "string") {
		return coerceStringValue(value, schema, types);
	}

	// Non-string primitive where an array is expected → wrap single value.
	if (types.includes("array") && !types.includes(jsonKind(value))) {
		const itemSchema = itemSchemaFor(schema, 0);
		const elem = itemSchema ? coerceValue(value, itemSchema) : { args: value, repairs: [] as ToolArgRepairKind[] };
		const itemTypes = itemSchema ? effectiveTypes(itemSchema) : [];
		const fits = itemTypes.length === 0 || itemTypes.some((t) => matchesType(elem.args, t));
		if (fits) return { args: [elem.args], repairs: ["wrap_single_in_array", ...elem.repairs] };
	}

	return { args: value, repairs: [] };
}

/** Walk an object's declared properties, coercing each present value. */
function coerceObject(
	obj: Record<string, unknown>,
	schema: JsonSchema,
	seed: ToolArgRepairKind[],
): ToolArgRepairResult {
	const properties = schema.properties;
	const repairs = seed;
	if (!properties) return { args: obj, repairs };
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	let out: Record<string, unknown> | undefined;
	const ensureOut = (): Record<string, unknown> => {
		if (!out) out = { ...obj };
		return out;
	};

	for (const key of Object.keys(obj)) {
		const propSchema = asSchema(properties[key]);
		if (!propSchema) continue; // unknown key — leave for validation / did-you-mean
		const val = obj[key];

		// Empty string → null (nullable) or omit (optional). A field that legitimately
		// accepts a string keeps "" (it is a valid value, not a misplaced placeholder).
		// An untyped field (schema `{}`) declares no concrete type, so "" is a valid
		// value there too — only fire when at least one concrete type is declared.
		const propTypes = effectiveTypes(propSchema);
		if (val === "" && propTypes.length > 0 && !propTypes.includes("string")) {
			if (isNullable(propSchema)) {
				ensureOut()[key] = null;
				repairs.push("empty_to_null");
				continue;
			}
			if (!required.has(key)) {
				delete ensureOut()[key];
				repairs.push("empty_to_undefined");
				continue;
			}
			// Required, non-nullable, non-string field with "" — leave for validation.
		}

		const r = coerceValue(val, propSchema);
		if (r.args !== val) ensureOut()[key] = r.args;
		if (r.repairs.length) repairs.push(...r.repairs);
	}

	return { args: out ?? obj, repairs };
}

// --- Public entry -------------------------------------------------------------

/**
 * Repair a tool call's raw arguments before validation. Two tiers:
 *   (A) structural — only when `rawArgs` is a STRING (defensive; normally the
 *       provider already parsed it — see the module-level limitation);
 *   (B) schema coercion — walk the parsed args against `schema` and fix type
 *       mismatches per the forge coercion table.
 *
 * Returns the same `args` reference when nothing changed (so the caller's
 * validation fast-path and repair-note diff both see an untouched object). Never
 * throws — any internal parse failure leaves the value for `validateToolArguments`
 * to report. Records per-(tool, kind) stats + one diagnostic line per repair.
 */
export function repairToolArguments(rawArgs: unknown, schema: unknown, toolName: string): ToolArgRepairResult {
	if (isToolCallRepairDisabled()) return { args: rawArgs, repairs: [] };

	const repairs: ToolArgRepairKind[] = [];
	let args = rawArgs;

	// Tier A: structural repair of a whole-arguments STRING.
	if (typeof args === "string") {
		const fence = stripFences(args);
		const parsed = structuralParse(fence.text);
		if (isRecord(parsed)) {
			if (fence.stripped) repairs.push("fence_strip");
			repairs.push("structural_json");
			args = parsed;
		} else {
			// Unparseable — leave the original for validation to report.
			return { args: rawArgs, repairs: [] };
		}
	}

	// Tier B: schema coercion.
	const schemaObj = asSchema(schema);
	if (isRecord(args) && schemaObj?.properties) {
		const r = coerceObject(args, schemaObj, repairs);
		args = r.args;
	}

	if (repairs.length > 0) recordRepairs(toolName, repairs);
	return { args, repairs };
}
