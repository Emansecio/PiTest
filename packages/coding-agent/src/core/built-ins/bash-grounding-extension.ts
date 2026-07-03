/**
 * Built-in bash-grounding extension (thin adapter).
 *
 * Pre-exec counterpart for an explicit `npm/pnpm/yarn run <script>` bash command:
 * when the `<script>` is not defined in the project's package.json but is a close
 * typo of one that is (`npm run biuld` -> `build`), this blocks with the close
 * candidate — BEFORE the runner spawns and fails with "Missing script" (and, on
 * some runners, a non-zero exit the model reads as a real build failure). All the
 * decision logic (the runner/`run` detection, the script lookup, the block-only /
 * fail-open invariants) lives in the pure `../bash-grounding.ts`; this adapter
 * only wires the script reader + fuzzy matcher and harvests the command string.
 *
 * Session state: a fire-once set so an insistent model re-issuing the identical
 * blocked call runs it (advises, never wedges). Opt out with PIT_NO_BASH_GROUNDING.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { suggestClosest } from "@pit/ai";
import { groundBashScript, isBashGroundingDisabled } from "../bash-grounding.ts";
import type { ExtensionAPI } from "../extensions/index.js";
import { createFireOnceBlockGuard } from "./grounding-fire-once.ts";

/** Read the `scripts` keys from the cwd's package.json. Any error -> [] (fail-open). */
function readScriptsOf(cwd: string): string[] {
	try {
		const raw = readFileSync(join(resolve(cwd), "package.json"), "utf-8");
		const parsed = JSON.parse(raw);
		const scripts = parsed?.scripts;
		if (scripts && typeof scripts === "object") return Object.keys(scripts as Record<string, unknown>);
		return [];
	} catch {
		return [];
	}
}

export function createBashGroundingExtension(options: { cwd: string }): (pi: ExtensionAPI) => void {
	let scriptsCache: string[] | undefined;
	const readScripts = (): string[] => {
		if (scriptsCache === undefined) scriptsCache = readScriptsOf(options.cwd);
		return scriptsCache;
	};

	return createFireOnceBlockGuard({
		category: "guard.bash-grounding",
		source: "bash-grounding-extension",
		ruleId: "script-not-found",
		decide(event) {
			if (isBashGroundingDisabled()) return undefined;
			if (event.toolName !== "bash") return undefined;

			const input = event.input as Record<string, unknown>;
			const command = input.command;
			if (typeof command !== "string") return undefined;

			const decision = groundBashScript({ command }, { readScripts, fuzzy: suggestClosest });
			if (decision.action === "block") {
				return { block: true, reason: decision.message };
			}
			return undefined;
		},
	});
}
