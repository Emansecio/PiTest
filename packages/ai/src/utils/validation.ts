import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";
import {
	coerceToolArguments,
	recordToolArgCoercions,
	stripNullishOptionalArgs,
	type ToolArgCoercionKind,
} from "./arg-coercion.ts";
import { coerceWithJsonSchema, isJsonSchemaObject, isRecord, type JsonSchemaObject } from "./validation-coerce.ts";

// `stripNullishOptionalArgs` moved into the shared coercion table (P2-9) — it is
// one of that table's kinds now (`null_to_undefined` / `empty_object_to_undefined`).
// Re-exported from its historical home so standalone callers (MCP argument prep)
// and tests keep their import path.
export { stripNullishOptionalArgs };

/** Where validation-side coercions are attributed on the diagnostics channel. */
const COERCION_SOURCE = "ai.validateToolArguments";

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

function hasTypeBoxMetadata(schema: unknown): boolean {
	return isRecord(schema) && Object.getOwnPropertySymbols(schema).includes(TYPEBOX_KIND);
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

function orderedNamePair(a: string, b: string): { longer: string; shorter: string } {
	if (a.length >= b.length) return { longer: a, shorter: b };
	return { longer: b, shorter: a };
}

/** True when `shorter` is a long-enough substring of `longer` (affix fallback). */
function affixOverlapQualifies(longer: string, shorter: string, prefixMinOverlap: number): boolean {
	return shorter.length >= prefixMinOverlap && longer.includes(shorter);
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
		const lenDiff = Math.abs(lower.length - candidateLower.length);
		const { longer, shorter } = orderedNamePair(lower, candidateLower);
		if (lenDiff > options.maxDistance && !affixOverlapQualifies(longer, shorter, options.prefixMinOverlap)) {
			continue;
		}
		const distance = levenshteinKey(lower, candidateLower);
		let score = distance;
		if (distance > options.maxDistance) {
			if (!affixOverlapQualifies(longer, shorter, options.prefixMinOverlap)) continue;
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
 * Validates tool call arguments against the tool's TypeBox schema.
 *
 * Since P2-9 this is strict-check + report, with ONE coercion pass in between:
 *  1. `Check` the raw arguments — the overwhelmingly common case, no clone;
 *  2. on failure, one pass of the SHARED coercion table (`arg-coercion.ts`) — the
 *     same table the agent's `repairToolArguments` runs before us, so a call that
 *     already went through the repair layer normally lands on step 1 and this pass
 *     is a no-op rather than a second, differently-behaved coercion;
 *  3. only if that is still not enough, the legacy aggressive fallback
 *     (`Value.Convert` + `coerceWithJsonSchema`: null→0, true→1, 1→true, …),
 *     counted as one `schema_convert_fallback` so nothing coerces off the books.
 *
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	const validator = getValidator(tool.parameters);

	// Fast path: well-formed args from the LLM usually validate without
	// coercion. structuredClone of a multi-KB edit payload is wasted work on
	// the hot path. If Check passes the raw arguments, skip clone + the table
	// + Convert + coerceWithJsonSchema entirely.
	if (validator.Check(toolCall.arguments)) {
		return toolCall.arguments;
	}

	// Step 2 — the shared table. Operates on a clone, so the echoed
	// `toolCall.arguments` below still shows what the model actually sent.
	const table = coerceToolArguments(structuredClone(toolCall.arguments), tool.parameters);
	const coercions: ToolArgCoercionKind[] = [...table.coercions];
	const args = table.args as any;
	if (validator.Check(args)) {
		recordToolArgCoercions(toolCall.name, coercions, COERCION_SOURCE);
		return args;
	}

	// Step 3 — legacy aggressive fallback.
	Value.Convert(tool.parameters, args);

	if (!hasTypeBoxMetadata(tool.parameters) && isJsonSchemaObject(tool.parameters)) {
		const coerced = coerceWithJsonSchema(args, tool.parameters, getSubSchemaValidator);
		if (coerced !== args) {
			if (isRecord(args) && isRecord(coerced)) {
				for (const key of Object.keys(args)) {
					delete args[key];
				}
				Object.assign(args, coerced);
			} else if (validator.Check(coerced)) {
				coercions.push("schema_convert_fallback");
				recordToolArgCoercions(toolCall.name, coercions, COERCION_SOURCE);
				return coerced;
			}
		}
	}

	if (validator.Check(args)) {
		coercions.push("schema_convert_fallback");
		recordToolArgCoercions(toolCall.name, coercions, COERCION_SOURCE);
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
