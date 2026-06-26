import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";

// The schema-validation error echoes the received arguments back to the model so
// it can self-correct. For large-payload tools (write/edit/code/ast_edit) a
// recoverable failure (extra key, stream corruption) would otherwise echo the
// ENTIRE file/program — often re-sent right after, costing 2-3x tokens — while
// the actionable parts (error path, "Did you mean", schema summary) need only the
// KEYS, not the long values. Truncate only long string VALUES to head+tail,
// preserving every key and the object structure. Splits on code points (Array.from)
// so an astral char (emoji / CJK ext) is never cut into a lone surrogate.
const ECHO_MAX_STRING_POINTS = 600;
const ECHO_HEAD_POINTS = 420;
const ECHO_TAIL_POINTS = 120;

function truncateEchoedString(value: string): string {
	const points = Array.from(value);
	if (points.length <= ECHO_MAX_STRING_POINTS) return value;
	const head = points.slice(0, ECHO_HEAD_POINTS).join("");
	const tail = points.slice(points.length - ECHO_TAIL_POINTS).join("");
	const omitted = points.length - ECHO_HEAD_POINTS - ECHO_TAIL_POINTS;
	return `${head} …[${omitted} chars truncated]… ${tail}`;
}

/** JSON.stringify of args with long string VALUES truncated; keys/structure intact. */
function formatEchoedArguments(args: unknown): string {
	return JSON.stringify(args, (_key, value) => (typeof value === "string" ? truncateEchoedString(value) : value), 2);
}

const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

interface JsonSchemaObject {
	type?: string | string[];
	properties?: Record<string, JsonSchemaObject>;
	items?: JsonSchemaObject | JsonSchemaObject[];
	additionalProperties?: boolean | JsonSchemaObject;
	allOf?: JsonSchemaObject[];
	anyOf?: JsonSchemaObject[];
	oneOf?: JsonSchemaObject[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
	return isRecord(value);
}

function hasTypeBoxMetadata(schema: unknown): boolean {
	return isRecord(schema) && Object.getOwnPropertySymbols(schema).includes(TYPEBOX_KIND);
}

function getSchemaTypes(schema: JsonSchemaObject): string[] {
	if (typeof schema.type === "string") {
		return [schema.type];
	}
	if (Array.isArray(schema.type)) {
		return schema.type.filter((type): type is string => typeof type === "string");
	}
	return [];
}

function matchesJsonType(value: unknown, type: string): boolean {
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
			return isRecord(value) && !Array.isArray(value);
		default:
			return false;
	}
}

function isValidatorSchema(value: unknown): value is Tool["parameters"] {
	return isRecord(value);
}

function getSubSchemaValidator(schema: JsonSchemaObject): ReturnType<typeof Compile> | undefined {
	if (!isValidatorSchema(schema)) {
		return undefined;
	}
	try {
		return getValidator(schema);
	} catch {
		return undefined;
	}
}

/**
 * Union coercion order: numeric types are attempted before boolean so a numeric
 * string ("1"/"0") coerces to a number, not the boolean "1"->true / "0"->false
 * form (preserves e.g. ["boolean","number"] + "1" -> 1). Single-type schemas are
 * unaffected — the boolean "1"/"0" coercion only kicks in when boolean is the
 * sole type.
 */
function coercionTypeRank(type: string): number {
	return type === "number" || type === "integer" ? 0 : 1;
}

function coercePrimitiveByType(value: unknown, type: string): unknown {
	switch (type) {
		case "number": {
			if (value === null) {
				return 0;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) {
					return parsed;
				}
			}
			if (typeof value === "boolean") {
				return value ? 1 : 0;
			}
			return value;
		}
		case "integer": {
			if (value === null) {
				return 0;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isInteger(parsed)) {
					return parsed;
				}
			}
			if (typeof value === "boolean") {
				return value ? 1 : 0;
			}
			return value;
		}
		case "boolean": {
			if (value === null) {
				return false;
			}
			if (typeof value === "string") {
				if (value === "true" || value === "1") {
					return true;
				}
				if (value === "false" || value === "0") {
					return false;
				}
			}
			if (typeof value === "number") {
				if (value === 1) {
					return true;
				}
				if (value === 0) {
					return false;
				}
			}
			return value;
		}
		case "string": {
			if (value === null) {
				return "";
			}
			if (typeof value === "number" || typeof value === "boolean") {
				return String(value);
			}
			return value;
		}
		case "null": {
			if (value === "" || value === 0 || value === false) {
				return null;
			}
			return value;
		}
		default:
			return value;
	}
}

function applySchemaObjectCoercion(value: Record<string, unknown>, schema: JsonSchemaObject): void {
	const properties = schema.properties;
	const definedKeys = new Set<string>(properties ? Object.keys(properties) : []);

	if (properties) {
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (!(key in value)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(value[key], propertySchema);
		}
	}

	if (schema.additionalProperties && isJsonSchemaObject(schema.additionalProperties)) {
		for (const [key, propertyValue] of Object.entries(value)) {
			if (definedKeys.has(key)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(propertyValue, schema.additionalProperties);
		}
	}
}

function applySchemaArrayCoercion(value: unknown[], schema: JsonSchemaObject): void {
	if (Array.isArray(schema.items)) {
		for (let index = 0; index < value.length; index++) {
			const itemSchema = schema.items[index];
			if (!itemSchema) {
				continue;
			}
			value[index] = coerceWithJsonSchema(value[index], itemSchema);
		}
		return;
	}

	if (isJsonSchemaObject(schema.items)) {
		for (let index = 0; index < value.length; index++) {
			value[index] = coerceWithJsonSchema(value[index], schema.items);
		}
	}
}

function coerceWithUnionSchema(value: unknown, schemas: JsonSchemaObject[]): unknown {
	for (const schema of schemas) {
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(value)) {
			return value;
		}
	}
	// Try coercion — clone once via structuredClone (faster than JSON round-trip).
	const cloneSource = isPrimitive(value) ? null : value;
	for (const schema of schemas) {
		const candidate = cloneSource === null ? value : structuredClone(cloneSource);
		const coerced = coerceWithJsonSchema(candidate, schema);
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(coerced)) {
			return coerced;
		}
	}
	return value;
}

function isPrimitive(value: unknown): boolean {
	return value === null || typeof value !== "object";
}

function coerceWithJsonSchema(value: unknown, schema: JsonSchemaObject): unknown {
	let nextValue = value;

	if (Array.isArray(schema.allOf)) {
		for (const nested of schema.allOf) {
			nextValue = coerceWithJsonSchema(nextValue, nested);
		}
	}

	if (Array.isArray(schema.anyOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
	}

	if (Array.isArray(schema.oneOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
	}

	const schemaTypes = getSchemaTypes(schema);
	const matchesUnionMember =
		schemaTypes.length > 1 && schemaTypes.some((schemaType) => matchesJsonType(nextValue, schemaType));
	if (schemaTypes.length > 0 && !matchesUnionMember) {
		const ordered =
			schemaTypes.length > 1
				? [...schemaTypes].sort((a, b) => coercionTypeRank(a) - coercionTypeRank(b))
				: schemaTypes;
		for (const schemaType of ordered) {
			const candidate = coercePrimitiveByType(nextValue, schemaType);
			if (candidate !== nextValue) {
				nextValue = candidate;
				break;
			}
		}
	}

	if (schemaTypes.includes("object") && isRecord(nextValue) && !Array.isArray(nextValue)) {
		applySchemaObjectCoercion(nextValue, schema);
	}

	if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
		applySchemaArrayCoercion(nextValue, schema);
	}

	return nextValue;
}

/**
 * True when `schema` (directly, or through a union/intersection branch, or by
 * shape) admits a value of JSON `kind`. Used by {@link stripNullishOptionalArgs}
 * so a field that legitimately accepts `null` (a nullable field) or `{}` (an
 * object field) is never mistaken for a misplaced placeholder.
 */
function schemaAllowsKind(schema: JsonSchemaObject, kind: "null" | "object"): boolean {
	if (getSchemaTypes(schema).includes(kind)) return true;
	if (kind === "object" && (schema.properties !== undefined || schema.additionalProperties !== undefined)) {
		return true;
	}
	if (kind === "null" && (schema as { nullable?: boolean }).nullable === true) return true;
	for (const branch of [schema.anyOf, schema.oneOf, schema.allOf]) {
		if (Array.isArray(branch) && branch.some((s) => isJsonSchemaObject(s) && schemaAllowsKind(s, kind))) {
			return true;
		}
	}
	return false;
}

function isEmptyPlainObject(value: unknown): boolean {
	return isRecord(value) && !Array.isArray(value) && Object.keys(value).length === 0;
}

/**
 * Drop optional fields whose value is a misplaced placeholder — an explicit
 * `null`, or an empty object `{}` — when the field's schema does NOT accept that
 * kind. Weak models frequently emit `null`/`{}` for an optional argument they
 * mean to omit; forwarding it trips strict validation (or, after coercion,
 * silently becomes `""`/`0`). Omitting the key is the lossless fix.
 *
 * Conservative by construction:
 *  - only touches keys DECLARED in `schema.properties` (never additionalProperties),
 *  - never touches a REQUIRED key — dropping it just trades one error for another,
 *  - never drops a value the field legitimately accepts (`null` for a nullable
 *    field, `{}` for an object field): those are intentional.
 *
 * Pure: returns the same reference when nothing is dropped, otherwise a shallow
 * clone without the dropped keys. No-op for non-object input or a schema without
 * `properties`.
 */
export function stripNullishOptionalArgs<T>(args: T, schema: unknown): T {
	if (!isRecord(args) || Array.isArray(args)) return args;
	if (!isJsonSchemaObject(schema) || !schema.properties) return args;
	const properties = schema.properties;
	const requiredList = (schema as { required?: unknown }).required;
	const required = new Set<string>(
		Array.isArray(requiredList) ? requiredList.filter((k): k is string => typeof k === "string") : [],
	);
	let out: Record<string, unknown> | undefined;
	for (const key of Object.keys(args)) {
		const propSchema = properties[key];
		if (!propSchema || required.has(key)) continue;
		const value = args[key];
		const drop =
			(value === null && !schemaAllowsKind(propSchema, "null")) ||
			(isEmptyPlainObject(value) && !schemaAllowsKind(propSchema, "object"));
		if (!drop) continue;
		if (!out) out = { ...args };
		delete out[key];
	}
	return (out ?? args) as T;
}

function getValidator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
	const key = schema as object;
	const cached = validatorCache.get(key);
	if (cached) {
		return cached;
	}
	const validator = Compile(schema);
	validatorCache.set(key, validator);
	return validator;
}

function formatSubschemaTypes(label: string, subs: JsonSchemaObject[]): string {
	const types = subs.map((s) => (s.type as string) || "object");
	return `${label}: [${types.join(", ")}]`;
}

function summarizeSchemaParams(schema: Tool["parameters"]): string {
	if (!isJsonSchemaObject(schema) || !schema.properties) return "";
	const required = new Set<string>((schema as any).required ?? []);
	const lines: string[] = [];
	for (const [key, prop] of Object.entries(schema.properties)) {
		const parts: string[] = [key];
		if (prop.type) {
			parts.push(`[${Array.isArray(prop.type) ? prop.type.join("|") : prop.type}]`);
		}
		if ((prop as any).enum) {
			parts.push(`enum: ${JSON.stringify((prop as any).enum)}`);
		}
		if (prop.anyOf) {
			parts.push(formatSubschemaTypes("anyOf", prop.anyOf));
		}
		if (prop.oneOf) {
			parts.push(formatSubschemaTypes("oneOf", prop.oneOf));
		}
		if (required.has(key)) {
			parts.push("(required)");
		}
		lines.push(`    ${parts.join(" ")}`);
	}
	return lines.length > 0 ? `\n  Expected parameters:\n${lines.join("\n")}` : "";
}

// --- Levenshtein-based "did you mean" for invalid argument keys --------------
//
// When the LLM passes a key not in the schema (e.g. `start_line` instead of
// `offset`), TypeBox surfaces an `additionalProperties` error but does not
// suggest the correct key. Without that suggestion the model typically re-
// sends the same wrong key. We compute the closest valid key and append a
// "Did you mean X?" line so the model corrects in one round-trip.

const KEY_DYM_MAX_DISTANCE = 4;
const KEY_DYM_PREFIX_MIN_OVERLAP = 3;

function levenshteinKey(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let prev = new Array<number>(b.length + 1);
	let curr = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[b.length];
}

/**
 * "Did you mean X?" matcher shared across packages (key hints here, unknown-tool
 * hints in the agent loop). Scores candidates by Levenshtein distance, with an
 * affix fallback (substring overlap) for queries beyond `maxDistance`. Returns
 * the closest candidate name, or undefined when none qualifies.
 */
export function suggestClosest(
	name: string,
	candidates: string[],
	options: { maxDistance: number; prefixMinOverlap: number },
): string | undefined {
	return suggestClosestN(name, candidates, options, 1)[0];
}

/**
 * Top-N variant of {@link suggestClosest}. Scores every candidate with the same
 * Levenshtein/affix logic, then returns up to `limit` candidate names ordered by
 * ascending score. The sort is stable (V8), so candidates that tie keep their
 * original insertion order — matching the strict `< best.score` tie-breaking of
 * the single-result path.
 */
export function suggestClosestN(
	name: string,
	candidates: string[],
	options: { maxDistance: number; prefixMinOverlap: number },
	limit: number,
): string[] {
	const lower = name.toLowerCase();
	const scored: Array<{ name: string; score: number }> = [];
	for (const candidate of candidates) {
		const candidateLower = candidate.toLowerCase();
		const distance = levenshteinKey(lower, candidateLower);
		let score = distance;
		if (distance > options.maxDistance) {
			const longer = lower.length >= candidateLower.length ? lower : candidateLower;
			const shorter = lower.length >= candidateLower.length ? candidateLower : lower;
			if (shorter.length < options.prefixMinOverlap) continue;
			if (!longer.includes(shorter)) continue;
			score = longer.length - shorter.length;
		}
		scored.push({ name: candidate, score });
	}
	scored.sort((a, b) => a.score - b.score);
	return scored.slice(0, limit).map((entry) => entry.name);
}

function suggestKeyName(name: string, validKeys: string[]): string | undefined {
	return suggestClosest(name, validKeys, {
		maxDistance: KEY_DYM_MAX_DISTANCE,
		prefixMinOverlap: KEY_DYM_PREFIX_MIN_OVERLAP,
	});
}

/**
 * Inspect `args` for keys not present in `schema.properties` and return a
 * "Did you mean X?" hint line for each. Returns "" when no extra keys are
 * present or no valid candidates exist.
 */
function formatExtraKeyHints(args: unknown, schema: Tool["parameters"]): string {
	if (!isRecord(args)) return "";
	if (!isJsonSchemaObject(schema)) return "";
	const validKeys = schema.properties ? Object.keys(schema.properties) : [];
	if (validKeys.length === 0) return "";
	const extras = Object.keys(args).filter((key) => !validKeys.includes(key));
	if (extras.length === 0) return "";
	const lines: string[] = [];
	for (const extra of extras) {
		const suggestion = suggestKeyName(extra, validKeys);
		if (suggestion) {
			lines.push(`Did you mean "${suggestion}" instead of "${extra}"?`);
		}
	}
	return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
}

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	const validator = getValidator(tool.parameters);

	// Fast path: well-formed args from the LLM usually validate without
	// coercion. structuredClone of a multi-KB edit payload is wasted work on
	// the hot path. If Check passes the raw arguments, skip clone + Convert
	// + coerceWithJsonSchema entirely.
	if (validator.Check(toolCall.arguments)) {
		return toolCall.arguments;
	}

	// Drop optional `null`/`{}` placeholders BEFORE coercion so they are omitted
	// (the model's intent) rather than coerced to ""/0 by coercePrimitiveByType.
	// Operates on the clone, so the echoed `toolCall.arguments` below still shows
	// what the model actually sent.
	const args = stripNullishOptionalArgs(structuredClone(toolCall.arguments), tool.parameters);
	Value.Convert(tool.parameters, args);

	if (!hasTypeBoxMetadata(tool.parameters) && isJsonSchemaObject(tool.parameters)) {
		const coerced = coerceWithJsonSchema(args, tool.parameters);
		if (coerced !== args) {
			if (isRecord(args) && isRecord(coerced)) {
				for (const key of Object.keys(args)) {
					delete args[key];
				}
				Object.assign(args, coerced);
			} else if (validator.Check(coerced)) {
				return coerced;
			}
		}
	}

	if (validator.Check(args)) {
		return args;
	}

	const errors =
		validator
			.Errors(args)
			.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
			.join("\n") || "Unknown validation error";

	const schemaSummary = summarizeSchemaParams(tool.parameters);
	const streamCorrupted = (toolCall as any)._streamingParseError === true;
	const isEmptyArgs = isRecord(toolCall.arguments) && Object.keys(toolCall.arguments).length === 0;
	const hasRequired = ((tool.parameters as any)?.required as string[] | undefined)?.length;
	let emptyHint = "";
	if (streamCorrupted) {
		emptyHint =
			"\n\nWarning: Tool arguments were corrupted during streaming — some data was lost. Re-send the complete tool call.";
	} else if (isEmptyArgs && hasRequired) {
		emptyHint = "\n\nNote: Arguments object was empty. Re-send the tool call with all required arguments.";
	}

	const extraKeyHint = formatExtraKeyHints(toolCall.arguments, tool.parameters);
	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}${schemaSummary}${extraKeyHint}${emptyHint}\n\nReceived arguments:\n${formatEchoedArguments(toolCall.arguments)}`;

	throw new Error(errorMessage);
}
