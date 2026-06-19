/**
 * Bash Grounding — pre-execution grounding of `npm/pnpm/yarn run <script>`.
 *
 * PURE, decoupled pre-execution logic. When a `bash` command is about to run an
 * EXPLICIT package-script (`npm run build`, `pnpm run check`, `yarn run test`),
 * it checks the requested `<script>` against the project's package.json scripts
 * and returns:
 *
 *   (1) the script exists / nothing groundable      -> { action: "allow" }
 *   (2) the script is absent BUT a close name exists -> { action: "block", message }
 *
 * A typo'd script name (`npm run biuld`) otherwise fails post-spawn with a noisy
 * "Missing script" error and, on some runners, a non-zero exit the model reads as
 * a real build failure. Catching it one round-trip earlier with the close
 * candidate is cheap and high-signal.
 *
 * THREE LOAD-BEARING INVARIANTS (same posture as pattern/import grounding):
 *   - FAIL-OPEN absolutely. Any throw / non-string command / shell metacharacter /
 *     unreadable scripts / no close candidate -> { action: "allow" }.
 *   - SCOPE: ONLY the explicit `<runner> run <script>` form (runner in
 *     {npm,pnpm,yarn}). A manager subcommand (`npm install`, `npm test`,
 *     `npm ci`, `npm start`) is NOT grounded — those are high-noise and not a
 *     `run <script>` lookup. A command with ANY shell metacharacter
 *     (`&&`, `;`, `|`, `$(…)`, redirects) is passed through untouched.
 *   - BLOCK-only — never rewrites the command (the fix is the model's: re-issue
 *     with the correct script name).
 *
 * This module touches NO agent-session / registries. It takes injectable deps
 * (readScripts / fuzzy), each fail-open, wired by the thin adapter.
 */

import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import { parseSimpleArgv } from "./simple-argv.ts";

// ============================================================================
// Public verdict / input shapes
// ============================================================================

export type BashGroundingDecision = { action: "allow" } | { action: "block"; message: string };

/** The bash command about to run. */
export interface BashGroundingInput {
	command: string;
}

/**
 * Closest-name matcher (the same `suggestClosest` from `@pit/ai` the import/
 * pattern guards use). Returns the single best candidate name, or `undefined`.
 */
export type FuzzyClosest = (
	name: string,
	candidates: string[],
	options: { maxDistance: number; prefixMinOverlap: number },
) => string | undefined;

export interface BashGroundingDeps {
	/**
	 * Names of the scripts declared in the project's package.json (`scripts` keys),
	 * or [] when the manifest can't be read. Wired by the adapter; fail-open.
	 */
	readScripts: () => string[];
	/** Fuzzy matcher (defaults to suggestClosest from @pit/ai). */
	fuzzy: FuzzyClosest;
}

// ============================================================================
// Tuning
// ============================================================================

/** The package runners whose `run <script>` form we ground. */
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn"]);

/**
 * Same "did you mean" calibration as the import grounding guard: a typo within
 * edit-distance 3 qualifies; prefixMinOverlap 64 disables suggestClosest's affix
 * (substring) fallback so a genuinely different script (`build` vs `build:prod`)
 * is NOT falsely suggested.
 */
const MAX_DISTANCE = 3;
const PREFIX_MIN_OVERLAP = 64;

function formatBlockMessage(script: string, candidate: string, scripts: string[]): string {
	return (
		`Bash grounding (no command run): script "${script}" is not defined in package.json. ` +
		`Did you mean: ${candidate}? (scripts: ${scripts.join(", ")}) Fix the script name, ` +
		"or re-issue the identical call to run it anyway."
	);
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Ground an `npm/pnpm/yarn run <script>` bash command against the project's
 * package.json scripts. Pure — script enumeration + fuzzy matching come from
 * injected deps. Returns allow, or block with an actionable message on a close
 * typo of a real script.
 */
export function groundBashScript(input: BashGroundingInput, deps: BashGroundingDeps): BashGroundingDecision {
	try {
		const { command } = input;
		if (typeof command !== "string" || command.trim().length === 0) return { action: "allow" };

		const argv = parseSimpleArgv(command);
		// Shell metacharacter / unparseable -> pass through (fail-open).
		if (argv === undefined) return { action: "allow" };

		// ONLY the explicit `<runner> run <script>` form.
		const [runner, sub, script] = argv;
		if (runner === undefined || !SCRIPT_RUNNERS.has(runner)) return { action: "allow" };
		if (sub !== "run") return { action: "allow" };
		if (script === undefined || script.length === 0) return { action: "allow" };

		const scripts = deps.readScripts();
		if (scripts.length === 0) return { action: "allow" }; // unreadable / no scripts -> fail-open
		if (scripts.includes(script)) return { action: "allow" };

		// Unknown script: only block when a close real script name exists (a typo).
		// No near match -> ALLOW (fail-open; the script may be added concurrently).
		const candidate = deps.fuzzy(script, scripts, {
			maxDistance: MAX_DISTANCE,
			prefixMinOverlap: PREFIX_MIN_OVERLAP,
		});
		if (candidate === undefined) return { action: "allow" };
		return { action: "block", message: formatBlockMessage(script, candidate, scripts) };
	} catch {
		// Any unexpected throw anywhere -> FAIL-OPEN.
		return { action: "allow" };
	}
}

// ============================================================================
// Opt-out
// ============================================================================

/** Opt-out: PIT_NO_BASH_GROUNDING disables bash-script grounding entirely (FAIL-OPEN). */
export function isBashGroundingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_NO_BASH_GROUNDING);
}

/* ============================================================================
 * WIRING — new built-in adapter (bash-grounding-extension.ts), gated to `bash`,
 * fire-once anti-wedge, handler-wide try/catch (emitToolCall has no per-handler
 * isolation), opt-out PIT_NO_BASH_GROUNDING; registered in the built-ins
 * factories array after pattern-grounding. The adapter wires
 * readScripts = (cached) package.json scripts of the cwd, fuzzy = suggestClosest.
 * ========================================================================== */
