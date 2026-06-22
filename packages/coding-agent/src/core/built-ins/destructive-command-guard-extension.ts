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
 * blocked call runs it (advises, never wedges — re-issue = confirmation). The
 * whole handler is wrapped in try/catch because `emitToolCall` has no per-handler
 * isolation and a throw out of beforeToolCall would hard-block the call — fail-open
 * is load-bearing. Opt out with PIT_NO_DESTRUCTIVE_GUARD.
 */

import { recordDiagnostic } from "@pit/ai";
import { groundDestructiveCommand, isDestructiveCommandGuardDisabled } from "../destructive-command-guard.ts";
import type { ExtensionAPI } from "../extensions/index.js";
import { stableToolCallKey } from "./grounding-fire-once.ts";

export function createDestructiveCommandGuardExtension() {
	return (pi: ExtensionAPI) => {
		const fired = new Set<string>();

		pi.on("tool_call", (event) => {
			try {
				if (isDestructiveCommandGuardDisabled()) return undefined;
				if (event.toolName !== "bash") return undefined;

				const input = event.input as Record<string, unknown>;
				const command = input.command;
				if (typeof command !== "string") return undefined;

				const decision = groundDestructiveCommand({ command });
				if (decision.action === "block") {
					const key = stableToolCallKey(event.toolName, input);
					if (fired.has(key)) return undefined; // already advised once -> let it run
					fired.add(key);
					recordDiagnostic({
						category: "guard.destructive-command",
						level: "info",
						source: "destructive-command-guard-extension",
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
