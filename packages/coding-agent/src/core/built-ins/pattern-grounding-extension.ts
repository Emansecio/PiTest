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
 * blocked call runs it (advises, never wedges). Opt out with PIT_NO_PATTERN_GROUNDING.
 */

import type { ExtensionAPI } from "../extensions/index.js";
import { groundPattern, isPatternGroundingDisabled } from "../pattern-grounding.ts";
import { createFireOnceBlockGuard } from "./grounding-fire-once.ts";

export function createPatternGroundingExtension(): (pi: ExtensionAPI) => void {
	return createFireOnceBlockGuard({
		category: "guard.pattern-grounding",
		source: "pattern-grounding-extension",
		decide(event) {
			if (isPatternGroundingDisabled()) return undefined;
			if (event.toolName !== "grep" && event.toolName !== "find") return undefined;

			const input = event.input as Record<string, unknown>;
			const decision = groundPattern({ toolName: event.toolName, args: input });
			if (decision.action === "block") {
				return { block: true, reason: decision.message };
			}
			return undefined;
		},
	});
}
