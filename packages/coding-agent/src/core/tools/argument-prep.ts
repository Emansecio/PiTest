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
