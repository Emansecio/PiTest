/**
 * Destructive-Command Guard — pre-execution speed-bump for destructive-but-not
 * catastrophic shell commands.
 *
 * PURE, decoupled pre-execution logic. The permission deny-floor
 * (`BUILTIN_DANGEROUS_COMMANDS`) already HARD-BLOCKS the catastrophic tier
 * (`rm -rf /`, `rm -rf ~`, fork bomb, `mkfs`/`dd of=/dev/…`, `chmod 777 /`). The
 * permission system is binary (allow/deny) with no "ask" tier, so the MIDDLE tier
 * — significant-but-recoverable destruction (`rm -rf ./src`, `git reset --hard`,
 * `git clean -fd`, `git checkout .`, `git push --force`) — otherwise runs with no
 * friction at all under `auto` mode.
 *
 * This guard closes that gap WITHOUT removing capability: it returns a one-time
 * block carrying an impact/reversibility note; the wiring adapter is fire-once, so
 * re-issuing the identical command runs it. It is a confirmation speed-bump, never
 * a wedge.
 *
 * LOAD-BEARING INVARIANTS (same posture as the grounding guards):
 *   - FAIL-OPEN absolutely. Any throw / non-string command -> { action: "allow" }.
 *   - ADVISORY: block-only and fire-once at the wiring layer; never rewrites the
 *     command and never hard-blocks (re-issue runs it).
 *   - NO I/O. Reversibility is inferred from the command text alone (no filesystem
 *     walk to count files) so it stays cheap on the hot path.
 *   - Defers the catastrophic tier to the permission deny-floor: targets `/` and
 *     `~` are NOT handled here (the deny-floor owns them).
 */

import { isTruthyEnvFlag } from "../utils/env-flags.ts";

export type DestructiveCommandDecision = { action: "allow" } | { action: "block"; message: string };

export interface DestructiveCommandInput {
	command: string;
}

/**
 * Directory names that are cheap to regenerate, so a recursive delete of ONLY
 * these is routine and gets no speed-bump (avoids noise on the very common
 * `rm -rf node_modules dist`). Matched on the target's last path segment.
 */
const REGENERABLE_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	".svelte-kit",
	"target",
	"coverage",
	".cache",
	".turbo",
	".parcel-cache",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".gradle",
]);

/** Shell separators that end one command segment. */
const SEGMENT_SPLIT = /&&|\|\||;|\||\n/;

/**
 * Command wrappers stripped before anchoring, so the destructive verb is matched
 * at the segment's COMMAND position (not anywhere in the text). This stops a
 * benign `echo rm -rf src` / `echo git push --force` from tripping the guard.
 */
const COMMAND_PREFIX =
	/^(?:sudo\s+|doas\s+|command\s+|time\s+|nohup\s+|nice\s+(?:-n\s+\S+\s+)?|env\s+(?:\S+=\S+\s+)+)+/i;

/** Strip surrounding single/double quotes and a trailing slash from a path token. */
function cleanToken(token: string): string {
	let t = token;
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
	return t.replace(/[/\\]+$/, "");
}

/** Last path segment of a cleaned token (its basename). */
function basenameOf(path: string): string {
	const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Inspect a single `rm` segment. Returns an impact string when it is a recursive
 * delete of at least one NON-regenerable, non-catastrophic target; undefined
 * otherwise. `/` and `~` targets are left to the permission deny-floor.
 */
function inspectRmSegment(segment: string): string | undefined {
	// Anchored: `segment` has already been trimmed and had command wrappers
	// (sudo/env/…) stripped, so `rm` must be the actual command here.
	const m = /^rm\s+(.+)$/i.exec(segment);
	if (!m) return undefined;
	const tokens = m[1].split(/\s+/).filter((t) => t.length > 0);

	let recursive = false;
	const targets: string[] = [];
	for (const token of tokens) {
		if (token === "--") continue;
		if (token.startsWith("-")) {
			// `--recursive`, or any short cluster containing `r` (-r, -rf, -fr, -Rf).
			if (token === "--recursive" || (!token.startsWith("--") && /r/i.test(token))) recursive = true;
			continue;
		}
		targets.push(cleanToken(token));
	}
	if (!recursive || targets.length === 0) return undefined;

	const risky: string[] = [];
	for (const target of targets) {
		// Catastrophic root/home targets belong to the deny-floor — skip here.
		// cleanToken strips a trailing slash, so "/" and "//" arrive as "" and "~/" as "~".
		if (target === "" || target === "~") continue;
		if (REGENERABLE_DIRS.has(basenameOf(target))) continue;
		risky.push(target);
	}
	if (risky.length === 0) return undefined;
	return `recursive delete of ${risky.map((t) => `\`${t}\``).join(", ")} — files removed this way are not sent to a trash and are not recoverable without a backup or a prior git commit`;
}

/** Whole-command git detectors that discard local work or rewrite remote history. */
const GIT_DESTRUCTIVE: ReadonlyArray<{ re: RegExp; impact: string }> = [
	{
		re: /^git\s+reset\b(?:\s+\S+)*\s+--hard\b/i,
		impact: "`git reset --hard` discards ALL uncommitted changes (staged and working tree) irreversibly",
	},
	{
		re: /^git\s+clean\b[^&|;]*\s-\S*f/i,
		impact: "`git clean -f…` permanently deletes untracked files/directories (not recoverable via git)",
	},
	{
		re: /^git\s+checkout\s+(?:--\s+)?\.(?:\s|$)/i,
		impact: "`git checkout .` discards uncommitted changes in the working tree irreversibly",
	},
	{
		re: /^git\s+restore\s+(?:--\S+\s+)*(?:--\s+)?\.(?:\s|$)/i,
		impact: "`git restore .` discards uncommitted working-tree changes irreversibly",
	},
	{
		re: /^git\s+push\b(?:\s+\S+)*\s+(?:-f|--force)\b/i,
		impact: "`git push --force` rewrites remote history and can drop others' commits (prefer --force-with-lease)",
	},
];

function formatBlock(impacts: string[]): string {
	const body = impacts.length === 1 ? impacts[0] : impacts.map((s) => `(${s})`).join("; ");
	return (
		`Destructive command guard (not run yet): ${body}. ` +
		"Confirm this is intended — if so, re-issue the identical call to run it. " +
		"If you only meant to remove regenerable build output, narrow the target."
	);
}

/**
 * Inspect a bash command for destructive-but-recoverable operations. Returns a
 * one-time block with an impact note, or allow. Pure — no I/O, never throws past
 * the outer guard.
 */
export function groundDestructiveCommand(input: DestructiveCommandInput): DestructiveCommandDecision {
	try {
		const { command } = input;
		if (typeof command !== "string" || command.trim().length === 0) return { action: "allow" };

		const impacts: string[] = [];

		for (const rawSegment of command.split(SEGMENT_SPLIT)) {
			const segment = rawSegment.trim().replace(COMMAND_PREFIX, "");
			if (segment.length === 0) continue;

			const rm = inspectRmSegment(segment);
			if (rm) impacts.push(rm);

			for (const { re, impact } of GIT_DESTRUCTIVE) {
				// `--force-with-lease` is the SAFE force-push; drop it before the
				// force-push detector so it never trips.
				const haystack = impact.includes("push") ? segment.replace(/--force-with-lease(?:=\S+)?/gi, "") : segment;
				if (re.test(haystack)) impacts.push(impact);
			}
		}

		if (impacts.length === 0) return { action: "allow" };
		return { action: "block", message: formatBlock(impacts) };
	} catch {
		return { action: "allow" };
	}
}

/** Opt-out: PIT_NO_DESTRUCTIVE_GUARD disables the destructive-command guard (FAIL-OPEN). */
export function isDestructiveCommandGuardDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_NO_DESTRUCTIVE_GUARD);
}
