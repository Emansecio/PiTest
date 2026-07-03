/**
 * Shared argument-preparation helpers for built-in tools.
 *
 * These run BEFORE TypeBox validation in `prepareToolCall`. Their job is to
 * absorb common, non-malicious deviations from the canonical schema that LLMs
 * still produce frequently (e.g. `file_path` instead of `path`, an `edits`
 * array passed as a JSON-encoded string). Each helper is conservative:
 *
 * - never overwrites an existing canonical key,
 * - never reaches into nested structures it does not own,
 * - returns the input untouched if it does not look like a plain object.
 *
 * Tools opt in by composing the helpers they want inside their own
 * `prepareArguments`. This keeps every transformation auditable per-tool and
 * lets us add new aliases without touching the agent loop.
 */

import { resolve as nodeResolve } from "node:path";
import { stripNullishOptionalArgs } from "@pit/ai";
import { expandPath } from "./path-utils.ts";

/** Map of alias -> canonical key used by `applyKeyAliases`. */
export type KeyAliasMap = Record<string, string>;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Rename keys per the alias map, skipping any alias whose canonical key is
 * already present (canonical wins). Returns the same reference when nothing
 * changed so equality checks downstream stay cheap.
 */
export function applyKeyAliases<T extends Record<string, unknown>>(input: T, aliases: KeyAliasMap): T {
	let mutated = false;
	let output: Record<string, unknown> = input;
	for (const [alias, canonical] of Object.entries(aliases)) {
		if (!(alias in output)) continue;
		if (canonical in output) {
			// Canonical already set: drop the alias entirely so additionalProperties:false
			// validation does not fail. Choosing canonical is consistent with "first match wins"
			// at the schema level.
			if (!mutated) {
				output = { ...output };
				mutated = true;
			}
			delete output[alias];
			continue;
		}
		if (!mutated) {
			output = { ...output };
			mutated = true;
		}
		output[canonical] = output[alias];
		delete output[alias];
	}
	return (mutated ? output : input) as T;
}

/**
 * If `key` holds a string that parses to an array, replace it with the parsed
 * array. Used for models that JSON-encode array arguments (Opus 4.6, GLM-5.1
 * have done this with `edits`). No-op otherwise.
 */
export function coerceJsonArrayField<T extends Record<string, unknown>>(input: T, key: keyof T & string): T {
	const value = input[key];
	if (typeof value !== "string") return input;
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed)) return input;
		const next = { ...input } as Record<string, unknown>;
		next[key] = parsed;
		return next as T;
	} catch {
		return input;
	}
}

/**
 * Convenience: run a sequence of preparers in order. Each preparer must be a
 * pure (input,) => output function. Returns the same reference as the input if
 * no step mutated.
 */
export function composePreparers<T>(...steps: Array<(input: T) => T>): (input: T) => T {
	return (input: T) => {
		let current = input;
		for (const step of steps) {
			current = step(current);
		}
		return current;
	};
}

/**
 * Path-bearing tools share the same alias set. Centralized so every tool
 * agrees on the canonical name (`path`).
 */
export const PATH_KEY_ALIASES: KeyAliasMap = {
	file_path: "path",
	filepath: "path",
	filename: "path",
	file: "path",
};

/**
 * Edit-block key aliases sent by other harnesses for the find/replace fields:
 * Anthropic-native `old_string`/`new_string` and `old_str`/`new_str`,
 * Cursor-style `oldString`/`newString`, all map to this tool's canonical
 * `oldText`/`newText`. Applied both to a flat top-level edit and inside each
 * `edits[]` element so cross-harness models self-correct without a failed call.
 */
export const EDIT_KEY_ALIASES: KeyAliasMap = {
	old_string: "oldText",
	oldString: "oldText",
	old_str: "oldText",
	new_string: "newText",
	newString: "newText",
	new_str: "newText",
};

/**
 * Generic envelope: if a tool only needs path aliasing, this is the function
 * to assign to `prepareArguments`. Returns input untouched for non-objects.
 *
 * Typed as a generic-return cast: the helper does not actually inspect the
 * shape of T — schema validation (which runs immediately after) is the
 * authority. This lets each call site keep its own Static<TParams>.
 */
export function prepareWithPathAliases<T>(input: unknown): T {
	if (!isPlainRecord(input)) return input as T;
	return applyKeyAliases(input, PATH_KEY_ALIASES) as T;
}

/**
 * Broad alias set used ONLY for loose-schema tools (MCP/custom) where the
 * canonical key isn't known ahead of time. Safe to keep wide because
 * {@link prepareArgsForLooseSchema} applies each entry conditionally on the
 * tool's own schema — never blindly.
 */
const LOOSE_SCHEMA_KEY_ALIASES: KeyAliasMap = {
	file_path: "path",
	filepath: "path",
	filename: "path",
	cmd: "command",
	script: "command",
	text: "content",
	body: "content",
	old_string: "oldText",
	oldString: "oldText",
	old_str: "oldText",
	new_string: "newText",
	newString: "newText",
	new_str: "newText",
};

function schemaTypeIsArray(propSchema: unknown): boolean {
	if (!isPlainRecord(propSchema)) return false;
	const t = propSchema.type;
	return t === "array" || (Array.isArray(t) && t.includes("array"));
}

/**
 * Schema-AWARE preparer for tools whose schema is arbitrary (MCP / custom),
 * which until now forwarded `(args ?? {})` untouched while every built-in
 * normalizes aliases + array-strings via prepareArguments. Unlike the built-in
 * preparers (which know their canonical keys), this consults the tool's OWN
 * schema so it is safe on a server whose real parameter happens to BE an alias:
 *
 *   - key alias -> canonical: applied only when the schema declares the canonical
 *     and NOT the alias (so a tool whose real param is `file_path` is never
 *     rewritten to `path`).
 *   - JSON-stringified array -> array: applied only to a field the schema types
 *     as `array` (a model that emits `["a"]` as a string self-corrects).
 *
 * Type coercion (string->number/boolean) already happens downstream in
 * validateToolArguments via the schema, so it is intentionally not duplicated
 * here. No-op for non-object input or a schema without `properties`.
 */
export function prepareArgsForLooseSchema(input: unknown, inputSchema: unknown): unknown {
	if (!isPlainRecord(input)) return input;
	const properties =
		isPlainRecord(inputSchema) && isPlainRecord(inputSchema.properties) ? inputSchema.properties : undefined;
	if (!properties) return input;

	let out = input;
	let mutated = false;
	const ensureClone = () => {
		if (!mutated) {
			out = { ...input };
			mutated = true;
		}
	};

	for (const [alias, canonical] of Object.entries(LOOSE_SCHEMA_KEY_ALIASES)) {
		if (alias in out && !(alias in properties) && canonical in properties && !(canonical in out)) {
			ensureClone();
			out[canonical] = out[alias];
			delete out[alias];
		}
	}

	for (const key of Object.keys(properties)) {
		if (typeof out[key] !== "string" || !schemaTypeIsArray(properties[key])) continue;
		const coerced = coerceJsonArrayField(out, key);
		if (coerced !== out) {
			ensureClone();
			out[key] = (coerced as Record<string, unknown>)[key];
		}
	}

	// Drop optional null/{} placeholders the server's schema doesn't accept. The
	// canonical TypeBox path does this in validateToolArguments; MCP/custom tools
	// validate against their own raw schema and never reach it, so apply it here.
	const stripped = stripNullishOptionalArgs(out, inputSchema);
	if (stripped !== out) {
		out = stripped;
		mutated = true;
	}

	return mutated ? out : input;
}

/**
 * Read a canonical field off a record, falling back to any alias that maps to
 * it — the centralized form of the `oldText ?? old_string ?? oldString ?? old_str`
 * chains the call sites used to hardcode. Semantics match that `??` chain exactly:
 * canonical first, then aliases in declaration order; the FIRST key with a
 * non-nullish value wins (a present-but-non-string value stops the chain, same as
 * `??`, and is reported as undefined). Returns the resolved string, or undefined
 * when the winning value is absent/nullish/non-string.
 */
function coalesceAliasedString(
	rec: Record<string, unknown>,
	canonical: string,
	aliases: KeyAliasMap,
): string | undefined {
	const pick = (value: unknown): { hit: true; value: string | undefined } | { hit: false } => {
		// `?? ` only advances past null/undefined; a non-nullish value (even a number)
		// terminates the chain. Mirror that so a non-string here yields undefined
		// rather than silently falling through to an alias.
		if (value === undefined || value === null) return { hit: false };
		return { hit: true, value: typeof value === "string" ? value : undefined };
	};
	const direct = pick(rec[canonical]);
	if (direct.hit) return direct.value;
	for (const [alias, target] of Object.entries(aliases)) {
		if (target !== canonical) continue;
		const candidate = pick(rec[alias]);
		if (candidate.hit) return candidate.value;
	}
	return undefined;
}

/**
 * Extract a path argument from raw tool input, accepting every alias in
 * PATH_KEY_ALIASES (path / file_path / filepath / filename / file). Returns
 * undefined when no recognised key holds a string. Used by the built-in guards
 * that run on `tool_call` (BEFORE prepareArguments), so they must agree with the
 * tool on which key wins — hence the shared single source of truth here.
 */
export function extractPathArg(input: Record<string, unknown>): string | undefined {
	return coalesceAliasedString(input, "path", PATH_KEY_ALIASES);
}

/**
 * Resolve a tool path argument against `cwd`, treating POSIX-absolute (`/…`) and
 * Windows drive-absolute (`C:\…`/`C:/…`) paths as already absolute and everything
 * else — including a bare Windows drive-relative prefix (`C:foo`, no separator
 * after the colon, which Windows resolves against that drive's OWN current
 * directory) — as cwd-relative.
 *
 * Runs `expandPath` first so the guards see the SAME normalization the tools do
 * (`~`/`@` expansion, unicode spaces, and a trailing `:line[:col]` suffix the
 * model copied from grep output) — otherwise a guard would resolve `~/x` or
 * `x.ts:42` to a different file than the tool and mis-fire. It intentionally
 * keeps its OWN absolute-path check (regex, not node's `isAbsolute`) rather than
 * routing through `resolveToCwd`, so `scheme://` URLs aren't special-cased here
 * — but the regex itself is written to agree with `isAbsolute` on drive-relative
 * paths: `C:foo` must resolve against `cwd` exactly like `resolveToCwd` (the
 * tools' own resolver, which uses node's `isAbsolute`) does, or the guard tracks
 * a different file than the tool actually touched.
 */
export function resolveToolPath(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	if (expanded.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(expanded)) return expanded;
	return nodeResolve(cwd, expanded);
}

/** {oldText,newText} edit block in canonical form. */
export interface ExtractedEdit {
	oldText: string;
	newText: string;
}

/**
 * Normalize raw tool input into canonical `{oldText,newText}[]`, accepting the
 * cross-harness aliases in EDIT_KEY_ALIASES (old_string/oldString/old_str and the
 * new_* variants). Supports both the `edits[]` array shape and the legacy flat
 * single-edit shape. Returns null for any shape we can't fully parse (edits as a
 * JSON string, a non-object array element, a missing oldText/newText) so callers
 * fail open rather than acting on a partially-understood payload.
 */
export function extractEdits(input: Record<string, unknown>): ExtractedEdit[] | null {
	const toEdit = (rec: Record<string, unknown>): ExtractedEdit | null => {
		const oldText = coalesceAliasedString(rec, "oldText", EDIT_KEY_ALIASES);
		const newText = coalesceAliasedString(rec, "newText", EDIT_KEY_ALIASES);
		return oldText !== undefined && newText !== undefined ? { oldText, newText } : null;
	};

	// Coerce a JSON-stringified `edits` ("[{...}]") back to an array first — some
	// models (Opus 4.6, GLM-5.1) emit it stringified. Without this the guard sees a
	// string, falls through to the flat shape, and silently extracts nothing.
	const coerced = coerceJsonArrayField(input, "edits");
	const edits = coerced.edits;
	if (Array.isArray(edits)) {
		const out: ExtractedEdit[] = [];
		for (const e of edits) {
			if (!e || typeof e !== "object") return null;
			const edit = toEdit(e as Record<string, unknown>);
			if (!edit) return null;
			out.push(edit);
		}
		return out.length > 0 ? out : null;
	}
	// Legacy flat single-edit shape.
	const flat = toEdit(coerced);
	return flat ? [flat] : null;
}

/**
 * Pull every non-empty `oldText` an `edit` call will try to match, accepting the
 * EDIT_KEY_ALIASES the tool normalizes later. Deliberately MORE lenient than
 * `extractEdits`: it does not require a matching `newText`, and it skips (rather
 * than rejects) non-object `edits[]` elements — the read-guard uses this for a
 * verbatim-match safety gate that should still fire on a `{oldText}`-only payload
 * where `extractEdits` would return null and drop the gate. Returns [] for shapes
 * with no readable oldText, which makes that gate fail open.
 */
export function extractEditOldTexts(input: Record<string, unknown>): string[] {
	// Mirror extractEdits: coerce a JSON-stringified `edits` to an array so the
	// read-guard's post-compaction verbatim check isn't silently skipped (empty
	// oldTexts -> `.some()` vacuously passes -> a stale-summary edit clobbers).
	const coerced = coerceJsonArrayField(input, "edits");
	const out: string[] = [];
	const pushIf = (v: string | undefined) => {
		if (v !== undefined && v.length > 0) out.push(v);
	};
	const edits = coerced.edits;
	if (Array.isArray(edits)) {
		for (const e of edits) {
			if (e && typeof e === "object") {
				pushIf(coalesceAliasedString(e as Record<string, unknown>, "oldText", EDIT_KEY_ALIASES));
			}
		}
	}
	// Legacy flat single-edit shape.
	pushIf(coalesceAliasedString(coerced, "oldText", EDIT_KEY_ALIASES));
	return out;
}
