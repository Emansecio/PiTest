/**
 * THE tool-argument coercion table — one implementation, two call sites.
 *
 * Before P2-9 the same job was done twice with divergent rules: the agent's
 * `repairToolArguments` (tier B of `@pit/agent-core`'s tool-arg-repair) walked the
 * JSON schema and fixed type mismatches, and then `validateToolArguments` ran a
 * SECOND, different pipeline whenever TypeBox's `Check` failed
 * (`stripNullishOptionalArgs` + JSON-string arrays + `Value.Convert` +
 * `coerceWithJsonSchema`). Rules existed on one side only (`enum_case_fix` only in
 * the repair, the `null`/`{}` placeholder drop only in validation), so the
 * repair-note attributed to "repair" what validation had actually done, and
 * `getToolArgRepairStats()` under-reported.
 *
 * This module is now the single table. Both layers consume it:
 *   - `@pit/agent-core` `repairToolArguments` — structural tier (whole-arguments
 *     string) + this table, before validation, with the `PIT_NO_TOOLCALL_REPAIR`
 *     kill-switch;
 *   - `validateToolArguments` — strict `Check` first; on failure ONE pass of this
 *     table, then (only if that is still not enough) the legacy aggressive
 *     `Value.Convert` / `coerceWithJsonSchema` fallback, counted under its own
 *     kind so nothing coerces off the books.
 *
 * Every coercion — from either side — is reported with the same
 * `ToolArgCoercionKind` taxonomy and funnels into one stats tally
 * (`getToolArgCoercionStats`, re-exported as `getToolArgRepairStats`).
 *
 * Pure functions plus a small process-global counter; no dependency on the agent
 * loop or on a provider, so it stays trivially testable.
 *
 * Design of the coercion table itself adapted from forgecode's `forge_json_repair`.
 */

import { jsonrepair } from "jsonrepair";
import { recordDiagnostic } from "./runtime-diagnostics.ts";
import { isEmptyPlainObject, type JsonSchemaObject, schemaAllowsKind } from "./validation-coerce.ts";

/** The distinct coercion operations this table can apply, for stats + notes. */
export type ToolArgCoercionKind =
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
	| "enum_case_fix"
	/**
	 * Explicit `null` placeholder dropped for an optional field whose schema does
	 * not accept null (was `stripNullishOptionalArgs`, validation-only until P2-9).
	 */
	| "null_to_undefined"
	/**
	 * Empty-object `{}` placeholder dropped for an optional field whose schema does
	 * not accept an object (was `stripNullishOptionalArgs`, validation-only).
	 */
	| "empty_object_to_undefined"
	/**
	 * The legacy aggressive validation fallback (`Value.Convert` +
	 * `coerceWithJsonSchema`) rescued the call after this table was not enough —
	 * e.g. `null`→`0`, `true`→`1`, `1`→`true`, `null`→`""`. Deliberately kept as a
	 * single opaque kind: those rules are lossy by design and only run on the
	 * would-otherwise-fail path, so they are counted, not itemized.
	 */
	| "schema_convert_fallback";

export interface ToolArgCoercionResult {
	/** The coerced arguments. Same reference as the input when nothing changed. */
	args: unknown;
	/** The coercions applied, in application order. Empty when untouched. */
	coercions: ToolArgCoercionKind[];
}

// --- Stats / observability ----------------------------------------------------

export interface ToolArgCoercionStats {
	/** Total coercion operations recorded since the last reset. */
	total: number;
	/** Per-tool → per-kind counts. */
	byTool: Record<string, Partial<Record<ToolArgCoercionKind, number>>>;
	/** Per-kind totals across all tools. */
	byKind: Partial<Record<ToolArgCoercionKind, number>>;
}

interface CoercionStatsState {
	total: number;
	byTool: Map<string, Map<ToolArgCoercionKind, number>>;
	byKind: Map<ToolArgCoercionKind, number>;
}

// Process-global singleton (mirrors runtime-diagnostics): dist and src copies of
// this module under test still share one tally rather than each keeping a
// private, invisible one. Key kept at its pre-P2-9 name so an already-running
// process that mixes builds keeps counting into the same place.
const GLOBAL_KEY = "__pitToolArgRepairStats__";

function getStatsState(): CoercionStatsState {
	const holder = globalThis as typeof globalThis & { [GLOBAL_KEY]?: CoercionStatsState };
	let state = holder[GLOBAL_KEY];
	if (!state) {
		state = { total: 0, byTool: new Map(), byKind: new Map() };
		holder[GLOBAL_KEY] = state;
	}
	return state;
}

/** Snapshot of coercion counts per (tool, kind). Safe to call anytime. */
export function getToolArgCoercionStats(): ToolArgCoercionStats {
	const state = getStatsState();
	const byTool: ToolArgCoercionStats["byTool"] = {};
	for (const [tool, kinds] of state.byTool) {
		const entry: Partial<Record<ToolArgCoercionKind, number>> = {};
		for (const [kind, count] of kinds) entry[kind] = count;
		byTool[tool] = entry;
	}
	const byKind: Partial<Record<ToolArgCoercionKind, number>> = {};
	for (const [kind, count] of state.byKind) byKind[kind] = count;
	return { total: state.total, byTool, byKind };
}

/** Reset the tally. Intended for tests. */
export function resetToolArgCoercionStats(): void {
	const state = getStatsState();
	state.total = 0;
	state.byTool.clear();
	state.byKind.clear();
}

/**
 * Record coercions applied to `toolName`'s arguments. Called by BOTH layers
 * (agent repair and validation fallback) so the tally is complete; `source`
 * identifies which one on the diagnostics channel.
 */
export function recordToolArgCoercions(toolName: string, kinds: ToolArgCoercionKind[], source: string): void {
	if (kinds.length === 0) return;
	const state = getStatsState();
	let toolMap = state.byTool.get(toolName);
	if (!toolMap) {
		toolMap = new Map();
		state.byTool.set(toolName, toolMap);
	}
	for (const kind of kinds) {
		state.total += 1;
		toolMap.set(kind, (toolMap.get(kind) ?? 0) + 1);
		state.byKind.set(kind, (state.byKind.get(kind) ?? 0) + 1);
		// One observable line per coercion on the shared diagnostics channel;
		// `getToolArgCoercionStats()` is the typed, first-class observability API.
		recordDiagnostic({
			category: "tool.arg-repair",
			level: "info",
			source,
			context: { toolName, mechanism: kind },
		});
	}
}

// --- Minimal JSON-schema view (typebox schemas ARE JSON Schema at runtime) -----

/** The JSON-schema surface this table reads. */
export interface ArgCoercionSchema extends JsonSchemaObject {
	properties?: Record<string, ArgCoercionSchema>;
	items?: ArgCoercionSchema | ArgCoercionSchema[];
	anyOf?: ArgCoercionSchema[];
	oneOf?: ArgCoercionSchema[];
	required?: string[];
	enum?: unknown[];
	nullable?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSchema(value: unknown): ArgCoercionSchema | undefined {
	return typeof value === "object" && value !== null ? (value as ArgCoercionSchema) : undefined;
}

function typeList(t: string | string[] | undefined): string[] {
	if (typeof t === "string") return [t];
	if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
	return [];
}

/** All JSON types a schema admits directly or through a union branch. */
function effectiveTypes(schema: ArgCoercionSchema): string[] {
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

function isNullable(schema: ArgCoercionSchema): boolean {
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
function itemSchemaFor(schema: ArgCoercionSchema, index: number): ArgCoercionSchema | undefined {
	if (Array.isArray(schema.items)) return asSchema(schema.items[index]);
	return asSchema(schema.items);
}

// --- Structural helpers (shared with the agent's structural tier) --------------

const FENCE_RE = /^\s*```[^\n`]*\n?([\s\S]*?)\n?\s*```\s*$/;

/**
 * Strip a single surrounding markdown code fence. Returns whether it stripped.
 * Exported for the agent's structural tier so both tiers agree on what a fence is.
 */
export function stripJsonCodeFence(text: string): { text: string; stripped: boolean } {
	const m = text.match(FENCE_RE);
	if (m && typeof m[1] === "string") return { text: m[1], stripped: true };
	return { text, stripped: false };
}

/**
 * JSON.parse, then a `jsonrepair` fallback. Returns undefined when both fail.
 * Exported for the agent's structural tier — using the same loose parse on both
 * tiers is what keeps "repairable" from meaning two different things.
 */
export function parseLooseJson(text: string): unknown | undefined {
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

function coerceEnum(value: unknown, members: unknown[]): ToolArgCoercionResult {
	// Never coerce enums except an exact case-insensitive match to a member.
	if (members.includes(value)) return { args: value, coercions: [] };
	if (typeof value === "string") {
		const lower = value.toLowerCase();
		const match = members.find((m) => typeof m === "string" && m.toLowerCase() === lower);
		if (match !== undefined) return { args: match, coercions: ["enum_case_fix"] };
	}
	return { args: value, coercions: [] };
}

/** Direct + double-encoded loose parse of a string value (up to 4 levels). */
function parseNested(text: string): { value: unknown; depth: number } {
	let parsed = parseLooseJson(text);
	let depth = 0;
	while (typeof parsed === "string" && depth < 4) {
		const next = parseLooseJson(parsed);
		if (next === undefined) break;
		parsed = next;
		depth++;
	}
	return { value: parsed, depth };
}

/** Parse a string into an array for an array-typed field, else undefined. */
function stringToArray(value: string, schema: ArgCoercionSchema): ToolArgCoercionResult | undefined {
	const coercions: ToolArgCoercionKind[] = [];
	const fence = stripJsonCodeFence(value);
	const text = fence.text;
	if (fence.stripped) coercions.push("fence_strip");

	const { value: parsed, depth } = parseNested(text);
	if (Array.isArray(parsed)) {
		coercions.push("json_string_to_array");
		if (depth > 0) coercions.push("unwrap_double_encoded");
		return descendArray(parsed, schema, coercions);
	}

	// Array embedded in surrounding garbage: "prefix[1,2]suffix".
	const extracted = extractBalanced(text, "[", "]");
	if (extracted) {
		const g = parseLooseJson(extracted);
		if (Array.isArray(g)) {
			coercions.push("array_from_garbage");
			return descendArray(g, schema, coercions);
		}
	}

	// Single value → [value] when the coerced element fits the item type.
	const itemSchema = itemSchemaFor(schema, 0);
	const elem = itemSchema ? coerceValue(value, itemSchema) : { args: value, coercions: [] as ToolArgCoercionKind[] };
	const itemTypes = itemSchema ? effectiveTypes(itemSchema) : [];
	const fits = itemTypes.length === 0 || itemTypes.some((t) => matchesType(elem.args, t));
	if (fits) {
		return { args: [elem.args], coercions: [...coercions, "wrap_single_in_array", ...elem.coercions] };
	}
	return undefined;
}

/** Parse a string into an object for an object-typed field, else undefined. */
function stringToObject(value: string, schema: ArgCoercionSchema): ToolArgCoercionResult | undefined {
	const coercions: ToolArgCoercionKind[] = [];
	const fence = stripJsonCodeFence(value);
	const text = fence.text;
	if (fence.stripped) coercions.push("fence_strip");

	const { value: parsed, depth } = parseNested(text);
	if (isRecord(parsed)) {
		coercions.push("json_string_to_object");
		if (depth > 0) coercions.push("unwrap_double_encoded");
		return coerceObject(parsed, schema, coercions, 1);
	}

	const extracted = extractBalanced(text, "{", "}");
	if (extracted) {
		const g = parseLooseJson(extracted);
		if (isRecord(g)) {
			coercions.push("json_string_to_object");
			return coerceObject(g, schema, coercions, 1);
		}
	}
	return undefined;
}

function descendArray(value: unknown[], schema: ArgCoercionSchema, seed: ToolArgCoercionKind[]): ToolArgCoercionResult {
	const coercions = seed;
	let out: unknown[] | undefined;
	for (let i = 0; i < value.length; i++) {
		const itemSchema = itemSchemaFor(schema, i);
		if (!itemSchema) continue;
		const r = coerceValue(value[i], itemSchema);
		if (r.args !== value[i]) {
			if (!out) out = value.slice();
			out[i] = r.args;
		}
		if (r.coercions.length) coercions.push(...r.coercions);
	}
	return { args: out ?? value, coercions };
}

function coerceStringValue(value: string, schema: ArgCoercionSchema, types: string[]): ToolArgCoercionResult {
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
		if (n !== undefined) return { args: n, coercions: ["number_from_string"] };
	}
	if (types.includes("boolean") && !types.includes("string")) {
		const b = boolLiteral(value);
		if (b !== undefined) return { args: b, coercions: ["boolean_from_string"] };
	}
	return { args: value, coercions: [] };
}

/** Coerce a single value against a property schema. Returns same ref if untouched. */
function coerceValue(value: unknown, schema: ArgCoercionSchema): ToolArgCoercionResult {
	if (Array.isArray(schema.enum)) return coerceEnum(value, schema.enum);

	const types = effectiveTypes(schema);

	// Already the right container shape → descend for nested coercion only.
	if (Array.isArray(value)) {
		if (types.includes("array")) return descendArray(value, schema, []);
		return { args: value, coercions: [] };
	}
	if (isRecord(value)) {
		if (types.includes("object")) return coerceObject(value, schema, [], 1);
		return { args: value, coercions: [] };
	}

	// String source: structured parse, then primitive coercion.
	if (typeof value === "string") {
		return coerceStringValue(value, schema, types);
	}

	// Non-string primitive where an array is expected → wrap single value.
	if (types.includes("array") && !types.includes(jsonKind(value))) {
		const itemSchema = itemSchemaFor(schema, 0);
		const elem = itemSchema
			? coerceValue(value, itemSchema)
			: { args: value, coercions: [] as ToolArgCoercionKind[] };
		const itemTypes = itemSchema ? effectiveTypes(itemSchema) : [];
		const fits = itemTypes.length === 0 || itemTypes.some((t) => matchesType(elem.args, t));
		if (fits) return { args: [elem.args], coercions: ["wrap_single_in_array", ...elem.coercions] };
	}

	return { args: value, coercions: [] };
}

/**
 * Walk an object's declared properties, coercing each present value.
 *
 * `depth` is 0 for the arguments object itself. The `null` / `{}` placeholder
 * drops (formerly `stripNullishOptionalArgs`, which only ever ran on the
 * top-level arguments) stay scoped to depth 0 so unifying the two layers does not
 * silently change what a NESTED null means to a tool.
 */
function coerceObject(
	obj: Record<string, unknown>,
	schema: ArgCoercionSchema,
	seed: ToolArgCoercionKind[],
	depth: number,
): ToolArgCoercionResult {
	const properties = schema.properties;
	const coercions = seed;
	if (!properties) return { args: obj, coercions };
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

		// Misplaced placeholder for an OPTIONAL field the model meant to omit: an
		// explicit `null`, or an empty object `{}`, that the field's schema does not
		// accept. Forwarding it trips strict validation (or, after the legacy
		// fallback, silently becomes ""/0). Never fires on a required key —
		// dropping it just trades one error for another.
		if (depth === 0 && !required.has(key)) {
			if (val === null && !schemaAllowsKind(propSchema, "null")) {
				delete ensureOut()[key];
				coercions.push("null_to_undefined");
				continue;
			}
			if (isEmptyPlainObject(val) && !schemaAllowsKind(propSchema, "object")) {
				delete ensureOut()[key];
				coercions.push("empty_object_to_undefined");
				continue;
			}
		}

		// Empty string → null (nullable) or omit (optional). A field that legitimately
		// accepts a string keeps "" (it is a valid value, not a misplaced placeholder).
		// An untyped field (schema `{}`) declares no concrete type, so "" is a valid
		// value there too — only fire when at least one concrete type is declared.
		const propTypes = effectiveTypes(propSchema);
		if (val === "" && propTypes.length > 0 && !propTypes.includes("string")) {
			if (isNullable(propSchema)) {
				ensureOut()[key] = null;
				coercions.push("empty_to_null");
				continue;
			}
			if (!required.has(key)) {
				delete ensureOut()[key];
				coercions.push("empty_to_undefined");
				continue;
			}
			// Required, non-nullable, non-string field with "" — leave for validation.
		}

		const r = coerceValue(val, propSchema);
		if (r.args !== val) ensureOut()[key] = r.args;
		if (r.coercions.length) coercions.push(...r.coercions);
	}

	return { args: out ?? obj, coercions };
}

// --- Public entry -------------------------------------------------------------

/**
 * Apply the coercion table to a tool call's (already parsed) arguments against
 * its JSON schema — typebox schemas ARE JSON Schema at runtime, so the same walk
 * serves built-in and MCP tools.
 *
 * Returns the same `args` reference when nothing changed, so callers keep their
 * fast paths and their sent-vs-ran diffs. Never throws: an internal parse failure
 * leaves the value for validation to report. Does NOT record stats — the caller
 * decides (it knows the tool name and which layer it is).
 */
export function coerceToolArguments(args: unknown, schema: unknown): ToolArgCoercionResult {
	const schemaObj = asSchema(schema);
	if (!isRecord(args) || !schemaObj?.properties) return { args, coercions: [] };
	return coerceObject(args, schemaObj, [], 0);
}

/**
 * Drop optional `null` / `{}` placeholders from a tool call's top-level
 * arguments. Thin, kind-free view of the two placeholder rules inside
 * {@link coerceToolArguments}, kept as a named export because callers outside
 * validation use it standalone (e.g. the coding agent's MCP argument prep).
 *
 * Pure: returns the same reference when nothing is dropped.
 */
export function stripNullishOptionalArgs<T>(args: T, schema: unknown): T {
	if (!isRecord(args)) return args;
	const schemaObj = asSchema(schema);
	const properties = schemaObj?.properties;
	if (!properties) return args;
	const requiredList = schemaObj?.required;
	const required = new Set<string>(
		Array.isArray(requiredList) ? requiredList.filter((k): k is string => typeof k === "string") : [],
	);
	let out: Record<string, unknown> | undefined;
	for (const key of Object.keys(args)) {
		const propSchema = asSchema(properties[key]);
		if (!propSchema || required.has(key)) continue;
		const value = (args as Record<string, unknown>)[key];
		const drop =
			(value === null && !schemaAllowsKind(propSchema, "null")) ||
			(isEmptyPlainObject(value) && !schemaAllowsKind(propSchema, "object"));
		if (!drop) continue;
		if (!out) out = { ...(args as Record<string, unknown>) };
		delete out[key];
	}
	return (out ?? args) as T;
}
