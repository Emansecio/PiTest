/**
 * Erasable-syntax detector (pure).
 *
 * Under `erasableSyntaxOnly` (or Node's native type-stripping) the TypeScript
 * compiler rejects emit-bearing syntax: `enum`, `namespace`/`module` blocks with
 * a runtime body, and constructor parameter properties. A `write`/`edit` that
 * introduces one passes the tool but fails the project's `check` command a round
 * trip later. This finds the construct in NEW content so the preflight adapter
 * can block ONCE with an actionable rewrite hint, before the failure.
 *
 * Ambient declarations (`declare enum`, `declare namespace`/`declare module`) are
 * type-only and fully erased, so they are NOT flagged.
 *
 * Robustness: scans a copy with comments and string/template literals blanked, so
 * the word "enum" inside a comment or string never mis-fires. Pure + fail-open by
 * construction — the adapter wraps the call and treats any throw as "allow".
 */

export type NonErasableConstruct = "enum" | "namespace" | "parameter-property" | "nested-ternary";

export interface NonErasableFinding {
	construct: NonErasableConstruct;
	/** Actionable, copy-pasteable rewrite guidance for the model. */
	hint: string;
}

/**
 * Replace the bodies of line/block comments and string/template literals with
 * spaces (length-preserving for char counts is unnecessary; we only need keyword
 * boundaries to survive). Keeps code structure — braces, parens, keywords — so the
 * construct regexes see only real code.
 */
function blankNonCode(src: string): string {
	let out = "";
	let i = 0;
	const n = src.length;
	while (i < n) {
		const ch = src[i];
		const next = src[i + 1];
		// Line comment.
		if (ch === "/" && next === "/") {
			while (i < n && src[i] !== "\n") i++;
			continue;
		}
		// Block comment.
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		// String / template literal. Templates may embed `${...}` code, but flagged
		// constructs inside an interpolation are vanishingly rare; treating the whole
		// literal as opaque favors zero false-positives over that edge.
		if (ch === '"' || ch === "'" || ch === "`") {
			const quote = ch;
			i++;
			while (i < n) {
				if (src[i] === "\\") {
					i += 2;
					continue;
				}
				if (src[i] === quote) {
					i++;
					break;
				}
				i++;
			}
			out += " ";
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/** True when `declare` sits in the modifier run immediately before `index`. */
function precededByDeclare(code: string, index: number): boolean {
	const before = code.slice(Math.max(0, index - 48), index);
	// Only word chars + whitespace may sit between `declare` and the keyword
	// (export/declare/const). A statement boundary or any other token breaks it.
	return /\bdeclare\b[\sA-Za-z]*$/.test(before);
}

const ENUM_RE = /(?<![.\w$])(?:export\s+)?(?:const\s+)?enum\s+[A-Za-z_$]/g;
const NAMESPACE_RE = /(?<![.\w$])(?:export\s+)?(?:namespace|module)\s+[\w.$]+\s*\{/g;
const CONSTRUCTOR_RE = /(?<![.\w$])constructor\s*\(([^)]*)\)/g;
const PARAM_PROPERTY_RE = /(?:^|,)\s*(?:public|private|protected|readonly)\s+[A-Za-z_$]/;

/**
 * Find the first non-erasable construct in `content`, or undefined when clean.
 * Order: enum -> namespace/module -> parameter property (deterministic, reports
 * the most common offender first).
 */
export function detectNonErasableSyntax(content: string): NonErasableFinding | undefined {
	if (!content) return undefined;
	const code = blankNonCode(content);

	ENUM_RE.lastIndex = 0;
	for (let m = ENUM_RE.exec(code); m !== null; m = ENUM_RE.exec(code)) {
		if (!precededByDeclare(code, m.index)) {
			return {
				construct: "enum",
				hint:
					"`enum` is not erasable TypeScript (this project sets erasableSyntaxOnly). " +
					"Replace it with a `const` object + a union type, e.g. " +
					"`const Color = { Red: 'red', Blue: 'blue' } as const; type Color = (typeof Color)[keyof typeof Color];`.",
			};
		}
	}

	NAMESPACE_RE.lastIndex = 0;
	for (let m = NAMESPACE_RE.exec(code); m !== null; m = NAMESPACE_RE.exec(code)) {
		if (!precededByDeclare(code, m.index)) {
			return {
				construct: "namespace",
				hint:
					"`namespace`/`module` blocks are not erasable TypeScript (this project sets erasableSyntaxOnly). " +
					"Use a plain ES module (top-level exports) instead, or a `const` object for grouping values.",
			};
		}
	}

	CONSTRUCTOR_RE.lastIndex = 0;
	for (let m = CONSTRUCTOR_RE.exec(code); m !== null; m = CONSTRUCTOR_RE.exec(code)) {
		const params = m[1] ?? "";
		if (PARAM_PROPERTY_RE.test(params)) {
			return {
				construct: "parameter-property",
				hint:
					"Constructor parameter properties (`constructor(private x: T)`) are not erasable TypeScript " +
					"(this project sets erasableSyntaxOnly). Declare the field explicitly and assign it in the body: " +
					"`private x: T; constructor(x: T) { this.x = x; }`.",
			};
		}
	}

	return undefined;
}

/**
 * Heuristic nested-ternary detector — gated separately from erasable syntax by
 * the project's biome `noNestedTernary` rule. Returns a finding when a value-level
 * conditional is nested inside another (`a ? b : c ? d : e`, `a ? b ? c : d : e`).
 *
 * Precision-tuned, not a parser. It counts ternary `?` operators per bracket depth
 * within a statement and flags two-at-the-same-depth — which catches the common
 * unparenthesized then-/else-nesting the model writes, while excluding the usual
 * false positives: optional chaining (`a?.b`), nullish (`a ?? b`), TS optional
 * markers (`x?: T`), object/type colons, and two independent ternaries (separated
 * by `;` or `,`). It deliberately MISSES parenthesized inner ternaries and
 * conditional TYPES — false negatives are harmless (the project's biome catches
 * them at check time); the goal is to catch the obvious case one round-trip early.
 */
export function detectNestedTernary(content: string): NonErasableFinding | undefined {
	if (!content) return undefined;
	const code = blankNonCode(content);
	let depth = 0;
	// depth -> count of ternary `?` seen in the current statement at that depth.
	const ternaryCount = new Map<number, number>();

	for (let i = 0; i < code.length; i++) {
		const ch = code[i];
		if (ch === "(" || ch === "[" || ch === "{") {
			depth++;
			continue;
		}
		if (ch === ")" || ch === "]" || ch === "}") {
			ternaryCount.delete(depth); // leaving this scope resets its tally
			if (depth > 0) depth--;
			continue;
		}
		if (ch === ";") {
			ternaryCount.clear(); // statement boundary
			continue;
		}
		if (ch === ",") {
			ternaryCount.set(depth, 0); // sibling expression (e.g. another call arg)
			continue;
		}
		if (ch !== "?") continue;

		const next = code[i + 1];
		if (next === "?") {
			i++; // nullish `??` — consume both
			continue;
		}
		if (next === ".") continue; // optional chain `?.`
		// TS optional marker `x?:` — `?` then optional whitespace then `:`.
		let j = i + 1;
		while (j < code.length && (code[j] === " " || code[j] === "\t")) j++;
		if (code[j] === ":") continue;

		const count = (ternaryCount.get(depth) ?? 0) + 1;
		ternaryCount.set(depth, count);
		if (count >= 2) {
			return {
				construct: "nested-ternary",
				hint:
					"Nested ternaries are disallowed by this project's lint config (biome noNestedTernary). " +
					"Extract the inner conditional into a variable, an early return, or an if/else — e.g. " +
					"`const inner = q ? a : b; return p ? inner : c;`.",
			};
		}
	}
	return undefined;
}
