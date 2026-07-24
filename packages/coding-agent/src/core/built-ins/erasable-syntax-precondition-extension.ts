/**
 * Built-in TS preflight precondition extension (thin adapter).
 *
 * Pre-exec counterpart for TS that passes the tool but fails the project's `check`
 * command a round trip later. Two independently-gated checks on a `write`/`edit`'s
 * NEW content:
 *   - emit-bearing syntax (`enum` / `namespace` body / constructor parameter
 *     property) when the tsconfig sets `erasableSyntaxOnly`; and
 *   - nested ternaries when biome's `noNestedTernary` rule is active.
 * Either match blocks ONCE with a copy-pasteable rewrite hint. The decision logic
 * lives in the pure `../erasable-syntax-grounding.ts`; this adapter only gates on
 * the project config, harvests {targetFile, content} from the tool input, and
 * applies the fire-once / fail-open invariants shared by the grounding guards.
 *
 * Each check stays completely silent on any project that doesn't enforce its rule,
 * so it never mis-fires where enums or nested ternaries are allowed. Opt out with
 * PIT_NO_ERASABLE_PREFLIGHT.
 */

import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import { detectNestedTernary, detectNonErasableSyntax, type NonErasableFinding } from "../erasable-syntax-grounding.ts";
import type { ExtensionAPI } from "../extensions/index.js";
import { projectEnforcesErasableSyntax, projectEnforcesNoNestedTernary } from "../project-config-context.ts";
import { extractEdits, extractPathArg } from "../tools/argument-prep.ts";
import { createGuard, type GuardDecision } from "./grounding-fire-once.ts";

/** Aliases the write tool accepts for the content body (WRITE_KEY_ALIASES in write.ts). */
const CONTENT_KEYS = ["content", "text", "body", "data"] as const;

/** Only TS source carries these constructs; .js/.jsx/.mjs/.cjs cannot. */
const TS_PATH_RE = /\.(?:[cm]?tsx?)$/i;

/** New content to scan: a write's full body, or the concatenation of an edit's newText. */
function extractNewContent(toolName: string, input: Record<string, unknown>): string | undefined {
	if (toolName === "write") {
		for (const key of CONTENT_KEYS) {
			const value = input[key];
			if (typeof value === "string") return value;
		}
		return undefined;
	}
	const edits = extractEdits(input);
	if (!edits) return undefined;
	return edits.map((e) => e.newText).join("\n");
}

export function createErasableSyntaxPreconditionExtension(options: { cwd: string }): (pi: ExtensionAPI) => void {
	// Resolve each gate once per session (reading the configs is best-effort).
	let erasableGate: boolean | undefined;
	let ternaryGate: boolean | undefined;
	const erasableEnforced = (): boolean => {
		if (erasableGate === undefined) {
			try {
				erasableGate = projectEnforcesErasableSyntax(options.cwd);
			} catch {
				erasableGate = false;
			}
		}
		return erasableGate;
	};
	const ternaryEnforced = (): boolean => {
		if (ternaryGate === undefined) {
			try {
				ternaryGate = projectEnforcesNoNestedTernary(options.cwd);
			} catch {
				ternaryGate = false;
			}
		}
		return ternaryGate;
	};

	return createGuard({
		category: "guard.erasable-syntax",
		source: "erasable-syntax-precondition-extension",
		// Never used: every block below carries the construct it found as its id.
		// Kept as the spec-level fallback the seam requires.
		ruleId: "non-erasable-syntax",
		disabled: () => isTruthyEnvFlag(process.env.PIT_NO_ERASABLE_PREFLIGHT),
		appliesTo: (toolName) => toolName === "write" || toolName === "edit",
		async decide(event): Promise<GuardDecision | undefined> {
			const input = event.input as Record<string, unknown>;
			const path = extractPathArg(input);
			if (path === undefined || !TS_PATH_RE.test(path)) return undefined;
			const wantErasable = erasableEnforced();
			const wantTernary = ternaryEnforced();
			if (!wantErasable && !wantTernary) return undefined;

			const content = extractNewContent(event.toolName, input);
			if (content === undefined || content.length === 0) return undefined;

			let finding: NonErasableFinding | undefined = wantErasable ? detectNonErasableSyntax(content) : undefined;
			if (!finding && wantTernary) finding = detectNestedTernary(content);
			if (!finding) return undefined;

			return {
				action: "block",
				reason: `TS preflight (no write attempted): ${finding.hint}`,
				note: `${finding.construct}:${event.toolName}`,
				// The specific construct (enum/namespace/parameter-property/nested-ternary)
				// is a stable, lowercase-kebab check id — key per-construct efficacy on it.
				ruleId: finding.construct,
			};
		},
	});
}
