/**
 * Built-in destructive-command guard extension (thin adapter).
 *
 * Pre-exec speed-bump for the MIDDLE tier of destructive bash commands —
 * significant-but-recoverable destruction (`rm -rf ./src`, `git reset --hard`,
 * `git clean -fd`, `git checkout .`, `git push --force`) that the permission
 * deny-floor (which only HARD-BLOCKS the catastrophic `/` `~` tier) lets run
 * with no friction under `auto` mode. All decision logic lives in the pure
 * `../destructive-command-guard.ts`; this adapter only harvests the command
 * string and applies the fire-once escape.
 *
 * Session state: a fire-once set so an insistent model re-issuing the identical
 * blocked call runs it (advises, never wedges — re-issue = confirmation). Opt out
 * with PIT_NO_DESTRUCTIVE_GUARD.
 */

import { groundDestructiveCommand, isDestructiveCommandGuardDisabled } from "../destructive-command-guard.ts";
import type { ExtensionAPI } from "../extensions/index.js";
import { createFireOnceBlockGuard } from "./grounding-fire-once.ts";

export function createDestructiveCommandGuardExtension(): (pi: ExtensionAPI) => void {
	return createFireOnceBlockGuard({
		category: "guard.destructive-command",
		source: "destructive-command-guard-extension",
		decide(event) {
			if (isDestructiveCommandGuardDisabled()) return undefined;
			if (event.toolName !== "bash") return undefined;

			const input = event.input as Record<string, unknown>;
			const command = input.command;
			if (typeof command !== "string") return undefined;

			const decision = groundDestructiveCommand({ command });
			if (decision.action === "block") {
				return { block: true, reason: decision.message };
			}
			return undefined;
		},
	});
}
