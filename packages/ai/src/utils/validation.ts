import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";

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

	const args = structuredClone(toolCall.arguments);
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
	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}${schemaSummary}${extraKeyHint}${emptyHint}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

	throw new Error(errorMessage);
}
