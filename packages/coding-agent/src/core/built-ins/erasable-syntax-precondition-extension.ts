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

import { recordDiagnostic } from "@pit/ai";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import { detectNestedTernary, detectNonErasableSyntax, type NonErasableFinding } from "../erasable-syntax-grounding.ts";
import type { ExtensionAPI } from "../extensions/index.js";
import { projectEnforcesErasableSyntax, projectEnforcesNoNestedTernary } from "../project-config-context.ts";
import { extractEdits, extractPathArg } from "../tools/argument-prep.ts";
import { stableToolCallKey } from "./grounding-fire-once.ts";

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

export function createErasableSyntaxPreconditionExtension(options: { cwd: string }) {
	return (pi: ExtensionAPI) => {
		const fired = new Set<string>();
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

		pi.on("tool_call", async (event) => {
			try {
				if (isTruthyEnvFlag(process.env.PIT_NO_ERASABLE_PREFLIGHT)) return undefined;
				if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

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

				const key = stableToolCallKey(event.toolName, input);
				const note = `${finding.construct}:${event.toolName}`;
				// The specific construct (enum/namespace/parameter-property/nested-ternary)
				// is a stable, lowercase-kebab check id — key per-construct efficacy on it.
				const ruleId = finding.construct;
				if (fired.has(key)) {
					// Model is OVERRIDING the fire-once advisory by re-issuing the identical
					// call — record acceptance so override-rate is measurable, then let it run.
					recordDiagnostic({
						category: "guard.erasable-syntax",
						level: "info",
						source: "erasable-syntax-precondition-extension",
						context: {
							note,
							outcome: "overridden",
							ruleId,
							toolName: event.toolName,
							toolCallId: event.toolCallId,
						},
					});
					return undefined;
				}
				fired.add(key);
				recordDiagnostic({
					category: "guard.erasable-syntax",
					level: "info",
					source: "erasable-syntax-precondition-extension",
					context: { note, outcome: "blocked", ruleId, toolName: event.toolName, toolCallId: event.toolCallId },
				});
				return {
					block: true,
					reason: `TS preflight (no write attempted): ${finding.hint}`,
				};
			} catch {
				// Defense-in-depth: emitToolCall already isolates per-handler throws.
				return undefined;
			}
		});
	};
}
