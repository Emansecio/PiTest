/**
 * Decide whether a backgrounded bash command is a TEST/CHECK whose result must
 * be known before the agent can report the task done or suggest a commit. Pure +
 * conservative: only commands that clearly run tests, a type-checker, or a linter
 * count, and long-lived watchers/servers are excluded (they never "finish", so
 * waiting on them would just stall). Backs the end-of-turn guard that refuses to
 * conclude while such a job is still running.
 */

import type { BashBackgroundJob } from "../tools/bash.ts";

// Watchers / servers never settle — never treat them as a check to wait on.
const WATCH_OR_SERVER = /\b(?:--?watch|watch|nodemon|dev|serve|server|start|preview)\b/i;

// Direct invocations of a test runner / type-checker / linter (also catches the
// `npx <runner>` / `pnpm dlx <runner>` form).
const DIRECT_RUNNER =
	/\b(?:vitest|jest|mocha|ava|playwright|cypress|pytest|tox|phpunit|rspec|tsc|tsgo|biome|eslint)\b/i;
const DIRECT_RUNNER_WORDS = /\b(?:go\s+test|cargo\s+test|cargo\s+check|gradle\s+test|mvn\s+test|dotnet\s+test)\b/i;

// Package-manager scripts whose name reads as a check: `npm test`, `npm run check`,
// `pnpm run typecheck`, `yarn lint`, etc.
const PM = /\b(?:npm|pnpm|yarn|bun)\b/i;
const CHECK_SCRIPT = /^(?:test|tests|check|lint|typecheck|tc|verify|ci|e2e|unit|integration|coverage|biome|tsc)\b/i;

/** True when `command` runs a test/check/lint whose pass/fail we must wait for. */
export function isVerificationJobCommand(command: string): boolean {
	if (!command) return false;
	const cmd = command.trim();
	if (WATCH_OR_SERVER.test(cmd)) return false;
	if (DIRECT_RUNNER.test(cmd) || DIRECT_RUNNER_WORDS.test(cmd)) return true;
	if (!PM.test(cmd)) return false;
	// `<pm> test` / `<pm> t` / `<pm> run <check-script>`, plus the bare-script form
	// (`yarn lint`, `pnpm typecheck`) that only yarn/pnpm/bun allow — npm needs `run`,
	// so the bare form is skipped for npm to avoid matching `npm ci`/`npm install`.
	for (const m of cmd.matchAll(/\b(npm|pnpm|yarn|bun)\b\s+([a-z][\w:.-]*)(?:\s+([a-z][\w:.-]*))?/gi)) {
		const pm = m[1].toLowerCase();
		const verb = m[2].toLowerCase();
		const arg = m[3] ?? "";
		if (verb === "test" || verb === "t") return true;
		if (verb === "run" && CHECK_SCRIPT.test(arg)) return true;
		if (pm !== "npm" && CHECK_SCRIPT.test(verb)) return true;
	}
	return false;
}

/** Background jobs that are STILL running and are verification commands. */
export function pendingVerificationJobs(jobs: readonly BashBackgroundJob[]): BashBackgroundJob[] {
	return jobs.filter((j) => !j.exited && isVerificationJobCommand(j.command));
}
