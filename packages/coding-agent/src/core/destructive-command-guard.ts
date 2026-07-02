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

/**
 * Split a command on shell separators (`&&`, `||`, `;`, `|`, newline) while
 * honoring single/double quotes, so a separator INSIDE a quoted span (e.g.
 * `rm -rf "build;old"`) stays within one segment instead of mangling the target.
 *
 * Mirrors the previous `command.split(/&&|\|\||;|\||\n/)` exactly for unquoted
 * input; the only difference is that quoted metacharacters are preserved.
 */
function splitSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote = "";
	let i = 0;
	while (i < command.length) {
		const ch = command[i];
		if (quote !== "") {
			current += ch;
			if (ch === quote) quote = "";
			i += 1;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			i += 1;
			continue;
		}
		if (ch === "&" && command[i + 1] === "&") {
			segments.push(current);
			current = "";
			i += 2;
			continue;
		}
		if (ch === "|" && command[i + 1] === "|") {
			segments.push(current);
			current = "";
			i += 2;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "\n") {
			segments.push(current);
			current = "";
			i += 1;
			continue;
		}
		current += ch;
		i += 1;
	}
	segments.push(current);
	return segments;
}

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

/**
 * Split an argument string into tokens, keeping single/double-quoted spans
 * (including their spaces) together as one token so a quoted path with spaces
 * surfaces as a single coherent target instead of garbled fragments.
 */
function tokenizeArgs(args: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote = "";
	let started = false;
	for (const ch of args) {
		if (quote !== "") {
			current += ch;
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			started = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (started) tokens.push(current);
			current = "";
			started = false;
			continue;
		}
		current += ch;
		started = true;
	}
	if (started) tokens.push(current);
	return tokens;
}

/** Last path segment of a cleaned token (its basename). */
function basenameOf(path: string): string {
	const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Catastrophic targets left to the permission deny-floor (root, home, a bare
 * drive root like `C:\` which cleanToken reduces to `C:`, or a bare `*`). Matches
 * the rm-segment posture: significant destruction is a speed-bump here, but the
 * top tier is owned by `BUILTIN_DANGEROUS_COMMANDS`.
 */
function isCatastrophicTarget(target: string): boolean {
	// cleanToken has already stripped any trailing `/` or `\`.
	if (target === "") return true; // "/" or "\\"
	if (target === "~") return true;
	if (/^[A-Za-z]:$/.test(target)) return true; // drive root "C:\\" -> "C:"
	if (target === "*") return true;
	return false;
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
	const tokens = tokenizeArgs(m[1]);

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

/**
 * PowerShell / cmd.exe recursive-delete vocabulary. Same middle-tier posture as
 * the unix `rm -rf` path: recognized directly OR after a `powershell -Command` /
 * `pwsh -c` wrapper (see stripPowershellWrapper), target-aware so regenerable and
 * catastrophic (drive-root) targets are skipped exactly as for rm.
 */
function inspectRemoveItemSegment(segment: string): string | undefined {
	// `Remove-Item` at a command-ish position (start, or after a wrapper's quote).
	const m = /(?:^|[\s"'`])Remove-Item\s+(.+)$/i.exec(segment);
	if (!m) return undefined;
	const tokens = tokenizeArgs(m[1]);

	let recurse = false;
	let force = false;
	let expectValue = false;
	const targets: string[] = [];
	for (const token of tokens) {
		if (expectValue) {
			targets.push(cleanToken(token));
			expectValue = false;
			continue;
		}
		if (token.startsWith("-")) {
			if (/^-r(?:ec(?:urse?)?)?$/i.test(token)) recurse = true;
			else if (/^-force$/i.test(token) || /^-f$/i.test(token)) force = true;
			else if (/^-(?:path|literalpath|lp)$/i.test(token)) expectValue = true;
			continue;
		}
		targets.push(cleanToken(token));
	}
	if (!recurse && !force) return undefined;

	const risky: string[] = [];
	for (const target of targets) {
		if (target === "" || isCatastrophicTarget(target)) continue;
		if (REGENERABLE_DIRS.has(basenameOf(target))) continue;
		risky.push(target);
	}
	if (risky.length === 0) return undefined;
	return `\`Remove-Item -Recurse -Force\` of ${risky.map((t) => `\`${t}\``).join(", ")} — PowerShell deletes these permanently (not sent to the Recycle Bin) and they are not recoverable without a backup or a prior git commit`;
}

/** cmd.exe recursive directory/file deletes: `rd /s`, `rmdir /s`, `del /s`. */
function inspectWindowsShellDelete(segment: string): string | undefined {
	const rd = /(?:^|[\s"'`])(rd|rmdir)\b(.*)$/i.exec(segment);
	if (rd) {
		const tokens = tokenizeArgs(rd[2].trim());
		const flags = tokens.filter((t) => t.startsWith("/")).map((t) => t.toLowerCase());
		if (!flags.includes("/s")) return undefined;
		const risky = tokens
			.filter((t) => !t.startsWith("/"))
			.map(cleanToken)
			.filter((t) => t !== "" && !isCatastrophicTarget(t) && !REGENERABLE_DIRS.has(basenameOf(t)));
		if (risky.length === 0) return undefined;
		return `\`${rd[1].toLowerCase()} /s\` recursively deletes ${risky.map((t) => `\`${t}\``).join(", ")} and everything under it (not sent to the Recycle Bin, not recoverable without a backup)`;
	}
	const del = /(?:^|[\s"'`])(?:del|erase)\b(.*)$/i.exec(segment);
	if (del) {
		const tokens = tokenizeArgs(del[1].trim());
		const flags = tokens.filter((t) => t.startsWith("/")).map((t) => t.toLowerCase());
		if (!flags.includes("/s")) return undefined; // require the recursive switch
		const risky = tokens
			.filter((t) => !t.startsWith("/"))
			.map(cleanToken)
			.filter((t) => t !== "" && !isCatastrophicTarget(t) && !REGENERABLE_DIRS.has(basenameOf(t)));
		if (risky.length === 0) return undefined;
		return `\`del /s\` recursively force-deletes files under ${risky.map((t) => `\`${t}\``).join(", ")} (not sent to the Recycle Bin, not recoverable without a backup)`;
	}
	return undefined;
}

/** `Clear-Content` (alias `clc`) that empties EVERY file matching a glob. */
function inspectClearContentSegment(segment: string): string | undefined {
	const m = /(?:^|[\s"'`])(?:Clear-Content|clc)\s+(.+)$/i.exec(segment);
	if (!m) return undefined;
	const tokens = tokenizeArgs(m[1]);
	let expectValue = false;
	const targets: string[] = [];
	for (const token of tokens) {
		if (expectValue) {
			targets.push(cleanToken(token));
			expectValue = false;
			continue;
		}
		if (token.startsWith("-")) {
			if (/^-(?:path|literalpath|lp|filter|include)$/i.test(token)) expectValue = true;
			continue;
		}
		targets.push(cleanToken(token));
	}
	const globs = targets.filter((t) => /[*?[]/.test(t));
	if (globs.length === 0) return undefined;
	return `\`Clear-Content\` empties the contents of every file matching ${globs.map((t) => `\`${t}\``).join(", ")} irreversibly`;
}

/**
 * Loose signatures for the destructive verbs we recognize, used ONLY to gate the
 * command-substitution opacity check (never to block on their own). Kept tied to
 * the specific verbs so a benign `echo $(date)` stays out of scope entirely.
 */
const DESTRUCTIVE_VERB_HINTS: readonly RegExp[] = [
	/\brm\s+(?:\S+\s+)*-\S*r/i,
	/\bgit\s+reset\b[^;&|]*--hard\b/i,
	/\bgit\s+clean\b[^;&|]*\s-\S*f/i,
	/\bgit\s+(?:checkout|restore)\b[^;&|]*(?:\s|--\s+)\.(?:\s|$|["'`])/i,
	/\bgit\s+push\b[^;&|]*(?:--force\b|\s-\S*f\b)/i,
	/\bRemove-Item\b[^;&|]*\s-(?:r(?:ec(?:urse?)?)?|force|f)\b/i,
	/\b(?:rd|rmdir)\b[^;&|]*\s\/s\b/i,
	/\b(?:del|erase)\b[^;&|]*\s\/s\b/i,
	/\bClear-Content\b/i,
];

/** True when the segment is shaped like one of our destructive verbs. */
function isDestructiveShaped(segment: string): boolean {
	// Drop the SAFE `--force-with-lease` first so it never reads as a force-push.
	const s = segment.replace(/--force-with-lease(?:=\S+)?/gi, "");
	return DESTRUCTIVE_VERB_HINTS.some((re) => re.test(s));
}

/**
 * True when the real target is hidden from the guard: command substitution
 * (`$(…)` / backticks) anywhere in the segment, or the whole command wrapped in
 * `eval` / `bash -c` / `sh -c` (a shell string we deliberately do NOT parse).
 * `powershell -Command` / `pwsh -c` is NOT opaque — its body is inspected via
 * stripPowershellWrapper.
 */
function hasOpaqueTarget(segment: string): boolean {
	if (/\$\(/.test(segment) || segment.includes("`")) return true;
	if (/^(?:eval\b|(?:ba|z)?sh\s+-\S*c\b|dash\s+-c\b)/i.test(segment.trim())) return true;
	return false;
}

/**
 * Command-substitution opacity: a destructive verb whose target the guard cannot
 * see. We do NOT expand/evaluate the substitution — we block once so the caller
 * confirms. Only fires when the segment is destructive-shaped, so a non-destructive
 * `echo $(date)` passes untouched.
 */
function inspectOpaqueDestructive(segment: string): string | undefined {
	if (!isDestructiveShaped(segment)) return undefined;
	if (!hasOpaqueTarget(segment)) return undefined;
	return "target contains command substitution ($(…)/backticks) or an eval/bash -c wrapper the guard cannot inspect";
}

/**
 * Unwrap a `powershell -Command "…"` / `pwsh -c '…'` prefix to its inner command
 * so the PowerShell (and any other) detectors can see the real verb. Returns the
 * segment unchanged when there is no wrapper.
 */
function stripPowershellWrapper(segment: string): string {
	const m = /^(?:pwsh|powershell(?:\.exe)?)\s+(?:-\S+\s+)*?-(?:c|command)\s+(.*)$/i.exec(segment.trim());
	if (!m) return segment;
	let inner = m[1].trim();
	if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
		inner = inner.slice(1, -1);
	}
	return inner;
}

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

		for (const rawSegment of splitSegments(command)) {
			const segment = rawSegment.trim().replace(COMMAND_PREFIX, "");
			if (segment.length === 0) continue;

			// Opacity FIRST: if the destructive target is hidden by command
			// substitution or an eval/bash -c wrapper, block once and skip the
			// target-aware detectors (which would only mangle the unreadable target).
			const opaque = inspectOpaqueDestructive(segment);
			if (opaque) {
				impacts.push(opaque);
				continue;
			}

			// Unwrap `powershell -Command "…"` so the inner command is inspected
			// directly; identity for every non-PowerShell segment.
			const inner = stripPowershellWrapper(segment);

			const rm = inspectRmSegment(inner);
			if (rm) impacts.push(rm);

			const ps =
				inspectRemoveItemSegment(inner) ?? inspectWindowsShellDelete(inner) ?? inspectClearContentSegment(inner);
			if (ps) impacts.push(ps);

			for (const { re, impact } of GIT_DESTRUCTIVE) {
				// `--force-with-lease` is the SAFE force-push; drop it before the
				// force-push detector so it never trips.
				const haystack = impact.includes("push") ? inner.replace(/--force-with-lease(?:=\S+)?/gi, "") : inner;
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
