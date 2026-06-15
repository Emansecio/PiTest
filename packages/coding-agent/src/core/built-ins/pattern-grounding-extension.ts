/**
 * Built-in pattern-grounding extension (thin adapter).
 *
 * Pre-exec counterpart for a `grep`/`find` search PATTERN/GLOB: when the regex or
 * glob is structurally malformed (unbalanced bracket/group/brace), this blocks
 * with an actionable message — BEFORE the search runs and returns a post-spawn
 * error (grep) or a silent 0-match that reads as success (glob). All the decision
 * logic lives in the pure `../pattern-grounding.ts`; this adapter only gates the
 * tool and translates the verdict.
 *
 * Session state: a fire-once set so an insistent model re-issuing the identical
 * blocked call runs it (advises, never wedges). The whole handler is wrapped in
 * try/catch because `emitToolCall` has no per-handler isolation and a throw out of
 * beforeToolCall would hard-block the call — fail-open is load-bearing. Opt out
 * with PIT_NO_PATTERN_GROUNDING.
 */

import { recordDiagnostic } from "@pit/ai";
import type { ExtensionAPI } from "../extensions/index.js";
import { groundPattern, isPatternGroundingDisabled } from "../pattern-grounding.ts";

export function createPatternGroundingExtension() {
	return (pi: ExtensionAPI) => {
		const fired = new Set<string>();

		pi.on("tool_call", (event) => {
			try {
				if (isPatternGroundingDisabled()) return undefined;
				if (event.toolName !== "grep" && event.toolName !== "find") return undefined;

				const input = event.input as Record<string, unknown>;
				const decision = groundPattern({ toolName: event.toolName, args: input });
				if (decision.action === "block") {
					// Stable key (sorted top-level arg keys) so a verbatim re-issue with
					// reordered keys still matches the fire-once escape.
					const key = `${event.toolName}:${JSON.stringify(input, Object.keys(input).sort())}`;
					if (fired.has(key)) return undefined; // already advised once -> let it run
					fired.add(key);
					recordDiagnostic({
						category: "guard.pattern-grounding",
						level: "info",
						source: "pattern-grounding-extension",
						context: { note: event.toolName },
					});
					return { block: true, reason: decision.message };
				}
				return undefined;
			} catch {
				// emitToolCall has no per-handler try/catch; a throw out of beforeToolCall
				// would hard-block the call. Fail-open is the invariant -> swallow.
				return undefined;
			}
		});
	};
}
