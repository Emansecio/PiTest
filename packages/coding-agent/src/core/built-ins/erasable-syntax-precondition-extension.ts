/**
 * Built-in erasable-syntax precondition extension (thin adapter).
 *
 * Pre-exec counterpart for emit-bearing TS syntax in a `write`/`edit`: when the
 * NEW content introduces an `enum`, a `namespace`/`module` body, or a constructor
 * parameter property, AND the project's tsconfig sets `erasableSyntaxOnly`, this
 * blocks ONCE with a copy-pasteable rewrite hint — BEFORE the write lands and the
 * project `check` command rejects it a round trip later. The decision logic lives
 * in the pure `../erasable-syntax-grounding.ts`; this adapter only gates on the
 * project config, harvests {targetFile, content} from the tool input, and applies
 * the fire-once / fail-open invariants shared by the grounding guards.
 *
 * Gated by `projectEnforcesErasableSyntax(cwd)` so it stays completely silent on
 * any project that legitimately allows enums. Opt out with PIT_NO_ERASABLE_PREFLIGHT.
 */

import { recordDiagnostic } from "@pit/ai";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import { detectNonErasableSyntax } from "../erasable-syntax-grounding.ts";
import type { ExtensionAPI } from "../extensions/index.js";
import { projectEnforcesErasableSyntax } from "../project-config-context.ts";
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
		// Resolve the gate once per session (reading tsconfig is best-effort).
		let enforced: boolean | undefined;
		const isEnforced = (): boolean => {
			if (enforced === undefined) {
				try {
					enforced = projectEnforcesErasableSyntax(options.cwd);
				} catch {
					enforced = false;
				}
			}
			return enforced;
		};

		pi.on("tool_call", async (event) => {
			try {
				if (isTruthyEnvFlag(process.env.PIT_NO_ERASABLE_PREFLIGHT)) return undefined;
				if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

				const input = event.input as Record<string, unknown>;
				const path = extractPathArg(input);
				if (path === undefined || !TS_PATH_RE.test(path)) return undefined;
				if (!isEnforced()) return undefined;

				const content = extractNewContent(event.toolName, input);
				if (content === undefined || content.length === 0) return undefined;

				const finding = detectNonErasableSyntax(content);
				if (!finding) return undefined;

				const key = stableToolCallKey(event.toolName, input);
				const note = `${finding.construct}:${event.toolName}`;
				if (fired.has(key)) {
					// Model is OVERRIDING the fire-once advisory by re-issuing the identical
					// call — record acceptance so override-rate is measurable, then let it run.
					recordDiagnostic({
						category: "guard.erasable-syntax",
						level: "info",
						source: "erasable-syntax-precondition-extension",
						context: { note, outcome: "overridden" },
					});
					return undefined;
				}
				fired.add(key);
				recordDiagnostic({
					category: "guard.erasable-syntax",
					level: "info",
					source: "erasable-syntax-precondition-extension",
					context: { note, outcome: "blocked" },
				});
				return {
					block: true,
					reason: `Erasable-syntax precondition (no write attempted): ${finding.hint}`,
				};
			} catch {
				// emitToolCall has no per-handler try/catch; a throw out of beforeToolCall
				// would hard-block the call. Fail-open is the invariant -> swallow.
				return undefined;
			}
		});
	};
}
