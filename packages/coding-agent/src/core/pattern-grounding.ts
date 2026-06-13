/**
 * Pattern Grounding — pre-execution grounding of a search PATTERN/GLOB.
 *
 * PURE, decoupled pre-execution logic. When `grep`/`find` is about to run with a
 * structurally malformed regex or glob, it returns:
 *
 *   (1) the pattern is well-formed / nothing groundable  -> { action: "allow" }
 *   (2) an unbalanced bracket/group/brace                -> { action: "block", message }
 *
 * Why a hand-rolled BALANCE check instead of `new RegExp()` / `Minimatch.makeRe()`:
 *   - `Minimatch.makeRe()` NEVER fails on a malformed glob — it silently treats
 *     `src/[a-` as a literal, so the search returns 0 matches that READ AS SUCCESS
 *     (the worst failure mode: the model concludes "not found" and gives up). A
 *     dry-compile through Minimatch would catch nothing.
 *   - `new RegExp()` rejects valid-in-ripgrep constructs the JS engine doesn't
 *     support (e.g. `(?P<name>…)` Python-style groups), which would FALSE-BLOCK a
 *     legitimate ripgrep pattern.
 * A structural balance check (unterminated `(`/`[`/`{`, unmatched `)`/`}`),
 * respecting `\` escapes and `[...]` classes, is DIALECT-AGNOSTIC and
 * zero-false-positive: it flags only the dominant authoring mistake — an
 * unbalanced bracket (`foo(`, `a[i`, an unterminated brace) — and lets the rest run.
 *
 * THREE LOAD-BEARING INVARIANTS:
 *   - FAIL-OPEN absolutely. Any throw / non-string / unknown tool -> allow.
 *   - REFERENCE-only by nature (a pattern is consumed, nothing is created).
 *   - BLOCK-only — never rewrites the pattern (the fix is the model's: escape,
 *     set literal:true, or balance the bracket).
 */

// ============================================================================
// Public verdict / input shapes
// ============================================================================

export type PatternGroundingDecision = { action: "allow" } | { action: "block"; message: string };

export interface PatternGroundingInput {
	toolName: string;
	args: Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

// ============================================================================
// Structural balance check (dialect-agnostic, zero false-positive)
// ============================================================================

/**
 * Detect an unbalanced GROUP bracket (`open`/`close`) or character class (`[...]`)
 * in `pattern`, returning a short reason when malformed, undefined when balanced.
 *
 * Rules honored so a VALID pattern always passes:
 *   - `\x` escapes the next char (so `\(` / `\]` are literals, not delimiters),
 *   - inside a `[...]` character class, the group delimiters are literals — only a
 *     `]` closes the class (a balanced class like `[a-z]` or `[)(]` is fine),
 *   - named groups, alternations, quantifiers etc. are all balanced -> they pass.
 */
function unbalanced(pattern: string, open: string, close: string, groupLabel: string): string | undefined {
	let depth = 0;
	let inClass = false;
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "\\") {
			i++; // skip the escaped character
			continue;
		}
		if (inClass) {
			if (ch === "]") inClass = false;
			continue;
		}
		if (ch === "[") {
			inClass = true;
			continue;
		}
		if (ch === open) {
			depth++;
		} else if (ch === close) {
			depth--;
			if (depth < 0) return `unmatched '${close}'`;
		}
	}
	if (inClass) return "unterminated character class — a '[' is never closed by ']'";
	if (depth > 0) return `unterminated ${groupLabel} — a '${open}' is never closed by '${close}'`;
	return undefined;
}

/** Regex: balance `()` groups + `[]` classes. */
function regexStructuralError(pattern: string): string | undefined {
	return unbalanced(pattern, "(", ")", "group");
}

/** Glob: balance `{}` brace-expansion + `[]` classes. */
function globStructuralError(glob: string): string | undefined {
	return unbalanced(glob, "{", "}", "brace expansion");
}

function formatRegexBlock(pattern: string, reason: string): string {
	return (
		`Pattern grounding (no search run): regex "${pattern}" is malformed — ${reason}. ` +
		"Balance/escape the metacharacters, set literal:true to match the text literally, " +
		"or re-issue the identical call to search anyway."
	);
}

function formatGlobBlock(glob: string, reason: string): string {
	return (
		`Pattern grounding (no search run): glob "${glob}" is malformed — ${reason}. ` +
		"A malformed glob silently matches NOTHING (reads as a false 'not found'). " +
		"Balance/escape the bracket or brace, or re-issue the identical call to search anyway."
	);
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Ground the pattern/glob of a `grep`/`find` call. Pure — no I/O.
 *   - grep: `pattern` as regex (unless literal:true) + `glob` as a glob filter.
 *   - find: `pattern` as a glob.
 * Returns allow, or block with an actionable message on a structural malformation.
 */
export function groundPattern(input: PatternGroundingInput): PatternGroundingDecision {
	try {
		const { toolName, args } = input;

		if (toolName === "grep") {
			if (args.literal !== true) {
				const pattern = asString(args.pattern);
				if (pattern !== undefined) {
					const reason = regexStructuralError(pattern);
					if (reason !== undefined) return { action: "block", message: formatRegexBlock(pattern, reason) };
				}
			}
			const glob = asString(args.glob);
			if (glob !== undefined) {
				const reason = globStructuralError(glob);
				if (reason !== undefined) return { action: "block", message: formatGlobBlock(glob, reason) };
			}
			return { action: "allow" };
		}

		if (toolName === "find") {
			const glob = asString(args.pattern);
			if (glob !== undefined) {
				const reason = globStructuralError(glob);
				if (reason !== undefined) return { action: "block", message: formatGlobBlock(glob, reason) };
			}
			return { action: "allow" };
		}

		return { action: "allow" };
	} catch {
		return { action: "allow" };
	}
}

// ============================================================================
// Opt-out
// ============================================================================

/** Opt-out: PIT_NO_PATTERN_GROUNDING disables pattern grounding entirely (FAIL-OPEN). */
export function isPatternGroundingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.PIT_NO_PATTERN_GROUNDING;
	if (!value) return false;
	const v = value.toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

/* ============================================================================
 * WIRING — new built-in adapter (pattern-grounding-extension.ts), gated to
 * grep/find, fire-once anti-wedge, handler-wide try/catch (emitToolCall has no
 * per-handler isolation), opt-out PIT_NO_PATTERN_GROUNDING; registered in the
 * built-ins factories array after path-grounding.
 * ========================================================================== */
