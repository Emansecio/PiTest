/**
 * Default Tier 4 error-hint rules for the coding agent.
 *
 * Each rule examines a failed tool result and appends a short, actionable
 * recovery hint to the LLM-facing error text. Hints are additive: they never
 * change the error status or strip the original error.
 *
 * The rules below were derived from the per-tool error distribution observed
 * in a replay of 1000 real tool calls (`scripts/bench-tool-rewrites.mts
 * --replay`). The 59 errors in that sample broke down as:
 *
 *   bash:  38 exit-1 with no output  (likely grep no-match)
 *           5 grep regex parse errors
 *           7 other exit codes
 *           1 ENOENT
 *   read:  2 ENOENT
 *   edit:  1 overlapping edits  / 1 oldText not found / 1 schema mismatch
 *
 * Rules target those patterns in order of frequency. Each rule's hint is
 * deliberately a single sentence so the LLM can act on it without unpacking
 * a paragraph of advice.
 */

import { ToolErrorHintRegistry as Registry, type ToolErrorHintRegistry, type ToolErrorHintRule } from "@pit/agent-core";
import type { AggregatedLearnedError } from "./learned-error-store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getString(args: unknown, key: string): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function basenameOf(p: string): string {
	const cleaned = p.replace(/[/\\]+$/, "");
	const i = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
	return i >= 0 ? cleaned.slice(i + 1) : cleaned;
}

// ---------------------------------------------------------------------------
// bash rules — by far the largest source of recoverable failures
// ---------------------------------------------------------------------------

const bashRules: ToolErrorHintRule[] = [
	{
		// The dominant pattern in real sessions: `grep ... | <something>` or
		// `grep ... <path>` exits 1 with "(no output)" when nothing matched.
		// Models read that as a failure and retry; in reality the absence IS
		// the answer. This hint flips the model's mental model in one line.
		id: "bash-grep-exit-1-no-match",
		appliesTo: "bash",
		matcher: ({ call, errorText }) => {
			const cmd = getString(call.arguments, "command") ?? "";
			if (!/^(grep|rg|ag)\b/.test(cmd) && !/\|\s*(grep|rg|ag)\b/.test(cmd)) return false;
			// "exited with code 1" is the canonical exit for "no match found" in
			// grep/rg/ag. We also confirm the output is empty so we don't fire on
			// genuine errors that happen to use exit 1.
			if (!/exited with code 1\b/i.test(errorText)) return false;
			return /\(no output\)/i.test(errorText) || /^\s*Command exited with code 1\s*$/m.test(errorText);
		},
		hint: () =>
			"grep/rg/ag exits 1 when no lines match. That is not a failure — treat absence as the answer, or broaden the pattern.",
	},
	{
		// Extended-regex parse failures. Three families converge here:
		//   - ripgrep      : "regex parse error: ... unclosed group"
		//   - POSIX grep -E: "/usr/bin/grep: Invalid regular expression"
		//   - BSD grep -E  : "Unmatched ( or \\("
		// All fire on the same root cause: unescaped `(` / `[` / `{` in a
		// regex passed to extended-regex mode.
		id: "bash-grep-regex-parse-error",
		appliesTo: "bash",
		matcher: ({ errorText }) =>
			/unclosed group|unmatched\s*\(|regex parse error|invalid regular expression/i.test(errorText) &&
			/grep|rg\b|ag\b/i.test(errorText.split("\n")[0] ?? errorText),
		hint: () =>
			"Regex parse error: escape literal parens with `\\(` `\\)`, use `-F` for fixed-string search, or call the dedicated `grep` tool to avoid shell-quoting complexity.",
	},
	{
		// Bash consumes backslashes as escape chars, so a Windows path passed
		// verbatim (`C:\Users\...`) arrives at the program with separators
		// stripped and the error surfaces a continuous letter blob:
		//   `rg: C:UsersUserAppDataLocal...: IO error ... file not found`
		// Detect the mangled path signature in the error text — `C:` followed
		// by 20+ alphanumeric chars without a separator is the tell.
		id: "bash-path-mangled-backslashes",
		appliesTo: "bash",
		matcher: ({ errorText }) => /\b[A-Z]:[A-Za-z0-9_.@-]{20,}/.test(errorText),
		hint: () =>
			"Windows path lost its separators — bash treats `\\` as an escape character. Use forward slashes (`C:/Users/...`) or single-quote the whole path so bash passes it through verbatim.",
	},
	{
		// `2>nul` is cmd.exe syntax. In bash this redirects stderr to a
		// regular file literally named `nul`, leaving the actual error
		// invisible AND producing a stray file. Catches misses #5 and #6
		// from the replay corpus.
		id: "bash-cmd-redirect-in-bash",
		appliesTo: "bash",
		matcher: ({ call }) => {
			const cmd = getString(call.arguments, "command") ?? "";
			return /\s2>nul\b/.test(cmd);
		},
		hint: () =>
			"`2>nul` is cmd.exe syntax; in bash it creates a file named `nul`. Use `2>/dev/null` instead — or call a dedicated tool that does not need shell redirects.",
	},
	{
		// `/c/Users/...` only resolves under MSYS/Cygwin/git-bash. Native
		// PowerShell / cmd / WSL bash treat the leading `/c/` as a literal
		// directory and ENOENT. Catches misses #7-#9 from the replay corpus.
		id: "bash-unix-drive-path-on-windows",
		appliesTo: "bash",
		matcher: ({ call, errorText }) => {
			const cmd = getString(call.arguments, "command") ?? "";
			if (!/(?:^|\s)\/[a-z]\//.test(cmd)) return false;
			// Only fire when the error suggests the path was the problem; an
			// MSYS shell would have made it work.
			return /exited with code [12]\b|no such file|cannot access|\(no output\)/i.test(errorText);
		},
		hint: () =>
			"`/c/...` Unix-style drive paths only resolve under MSYS/git-bash. Use `C:/Users/...` (forward slash with drive letter) for portability across native bash, PowerShell, and WSL.",
	},
	{
		// `cmd1 && cmd2 [&& cmd3 ...]` exit 1 with empty output usually means
		// one of the chained steps silently failed. Models read the empty
		// output and the non-zero exit as a single opaque failure; suggesting
		// they split into separate calls localises the failing step.
		// Conservative: skip when the command starts with grep/rg/ag because
		// the dedicated grep-no-match rule already covers that case.
		id: "bash-compound-silent-failure",
		appliesTo: "bash",
		matcher: ({ call, errorText }) => {
			const cmd = getString(call.arguments, "command") ?? "";
			if (!cmd.includes("&&")) return false;
			if (/^\s*(grep|rg|ag)\b/.test(cmd)) return false;
			return /\(no output\)/i.test(errorText) && /exited with code 1\b/i.test(errorText);
		},
		hint: () =>
			"Compound `cmd1 && cmd2` failed silently — exit 1 with no output usually means one chained step short-circuited. Split into separate bash calls so the failing step is visible.",
	},
	{
		// Inline JS via `node -e '...'` collides with shell quoting and gets
		// mangled on Windows where path backslashes interact with the inner
		// single/double quotes. Push the model to write a temp file instead.
		id: "bash-node-inline-syntax-error",
		appliesTo: "bash",
		matcher: ({ call, errorText }) => {
			const cmd = getString(call.arguments, "command") ?? "";
			return /\bnode\b.*\s-e\b/.test(cmd) && /SyntaxError|Unexpected token/i.test(errorText);
		},
		hint: () =>
			"Inline JS via `node -e` is fragile across shells. Write the script to a temp file with `write({path:'/tmp/x.mjs', content:...})`, then `bash({command:'node /tmp/x.mjs'})`.",
	},
	{
		// ENOENT inside bash. Either `cat: file: No such file or directory` or
		// the Windows equivalent. Cover both shells.
		id: "bash-path-not-found",
		appliesTo: "bash",
		matcher: ({ errorText }) =>
			/no such file or directory/i.test(errorText) ||
			/cannot access|cannot open/i.test(errorText) ||
			/the system cannot find the (path|file) specified/i.test(errorText),
		hint: () =>
			'Path not found. Locate the file with `find({paths:["**/<basename>"]})` or inspect the parent dir with `ls({path:<parent>})` before retrying.',
	},
	{
		// "command not found" — model invoked a binary that is not on PATH.
		// Covers POSIX sh, bash, zsh, and Windows cmd ("is not recognized").
		id: "bash-command-not-found",
		appliesTo: "bash",
		matcher: ({ errorText }) =>
			/command not found/i.test(errorText) ||
			/is not recognized as an internal or external command/i.test(errorText) ||
			/no such command/i.test(errorText),
		hint: () =>
			'The shell could not resolve that binary. Check availability with `bash({command:"which <name>"})`, or use a dedicated tool if one exists (read/grep/find/ls/edit/write).',
	},
	{
		// Permission denied. Hand it back to the user — agents should never
		// chmod files unilaterally.
		id: "bash-permission-denied",
		appliesTo: "bash",
		matcher: ({ errorText }) => /permission denied|eacces/i.test(errorText),
		hint: () =>
			"Permission denied. Do not chmod silently; report the path to the user and ask whether to escalate or skip.",
	},
];

// ---------------------------------------------------------------------------
// read rules
// ---------------------------------------------------------------------------

const readRules: ToolErrorHintRule[] = [
	{
		id: "read-enoent-suggest-find",
		appliesTo: "read",
		matcher: ({ errorText }) => /enoent|no such file or directory/i.test(errorText),
		hint: ({ call }) => {
			const path = getString(call.arguments, "path") ?? getString(call.arguments, "file_path");
			if (!path) {
				return 'File not found. Use `find({paths:["**/<basename>"]})` to locate it.';
			}
			const base = basenameOf(path);
			return `File not found. Locate it with \`find({paths:["**/${base}"]})\` — the path you passed may be relative to a different cwd.`;
		},
	},
];

// ---------------------------------------------------------------------------
// edit rules
// ---------------------------------------------------------------------------

const editRules: ToolErrorHintRule[] = [
	{
		// `edits[N] and edits[M] overlap` is a clean signal the model batched
		// adjacent changes that should have been merged.
		id: "edit-overlapping-edits",
		appliesTo: "edit",
		matcher: ({ errorText }) => /edits\[\d+\] and edits\[\d+\] overlap/i.test(errorText),
		hint: () =>
			"Overlapping edits[]: merge into a single edit whose oldText covers the combined region, or pick disjoint anchors so neither touches the other.",
	},
	{
		// "Could not find the exact text" — edit-diff already injects the
		// candidate-match block, but for older error paths or when the
		// candidate block is absent, this hint nudges the model to expand the
		// oldText window.
		id: "edit-old-text-not-found",
		appliesTo: "edit",
		matcher: ({ errorText }) =>
			/could not find the exact text|could not find edits\[/i.test(errorText) &&
			!/Paste this verbatim as oldText/i.test(errorText),
		hint: () =>
			"oldText not matched. Re-`read` a few lines around the target, then paste an exact slice (including whitespace) as `oldText`. Avoid trimming or summarising.",
	},
	{
		// Schema mismatch on additionalProperties — `validation DYM` already
		// suggests the right key. This rule fires when no DYM line appears.
		id: "edit-schema-mismatch",
		appliesTo: "edit",
		matcher: ({ errorText }) =>
			/validation failed for tool "edit"/i.test(errorText) && !/did you mean/i.test(errorText),
		hint: () =>
			"Edit schema is `{ path, edits: [{ oldText, newText }] }`. Drop unknown keys (e.g. `range`, `oldString`).",
	},
];

// ---------------------------------------------------------------------------
// Generic rules — apply to ANY tool
// ---------------------------------------------------------------------------

const genericRules: ToolErrorHintRule[] = [
	{
		// Schema validation rejected a string that is too long. Surfaced as
		// `must not have more than N characters` by TypeBox. Catches miss #10
		// (ask_user_question option label > 60 chars).
		id: "schema-maxlength-violation",
		appliesTo: "*",
		matcher: ({ errorText }) => /must not have (?:more than|fewer than) \d+ characters/i.test(errorText),
		hint: () =>
			"A string argument exceeded its max length. Shorten the offending field (the validator names the field path) and resend the same call.",
	},
	{
		// `spawn <binary> ENOENT` from node:child_process. Surfaces when a
		// tool extension shells out to a binary that is not on PATH (catches
		// misses #11-#12: `spawn bash ENOENT` from custom `run_experiment`).
		id: "spawn-binary-missing",
		appliesTo: "*",
		matcher: ({ errorText }) => /\bspawn\s+\S+\s+ENOENT\b/i.test(errorText),
		hint: ({ errorText }) => {
			const match = errorText.match(/\bspawn\s+(\S+)\s+ENOENT\b/i);
			const binary = match?.[1] ?? "the required binary";
			return `\`${binary}\` is not on PATH for this tool's spawn context. Verify the binary is installed and reachable, or invoke an alternative.`;
		},
	},
];

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ToolErrorHintRulesOptions {
	/** Disable bash hint rules. Default: enabled. */
	disableBashRules?: boolean;
	/** Disable read hint rules. Default: enabled. */
	disableReadRules?: boolean;
	/** Disable edit hint rules. Default: enabled. */
	disableEditRules?: boolean;
	/** Disable generic cross-tool rules (schema maxlen, spawn ENOENT). Default: enabled. */
	disableGenericRules?: boolean;
	/** Extra rules to append. */
	extraRules?: ToolErrorHintRule[];
	/**
	 * Cross-session learned errors loaded from disk (`~/.pit/agent/learned-errors/`).
	 * Recurring fingerprints that are not already covered by a built-in rule
	 * get a dynamically-generated Tier 4 rule that surfaces frequency context
	 * so the model knows "you've made this same mistake N times in M sessions
	 * — try a different approach". Defaults provided by the SDK via
	 * `aggregateLearnedErrors(defaultLearnedErrorsDir())`.
	 */
	learnedErrors?: AggregatedLearnedError[];
	/** Minimum total occurrences before a learned error becomes a rule. Default: 3. */
	learnedErrorMinOccurrences?: number;
	/** Minimum distinct sessions before a learned error becomes a rule. Default: 2. */
	learnedErrorMinSessions?: number;
	/** Cap on how many learned-error rules to materialise. Default: 32. */
	learnedErrorMaxRules?: number;
}

/**
 * Build the default Tier 4 registry used by the coding-agent SDK. All
 * categories are on by default — the rules are purely additive (they append
 * a short hint to errors that were already going to be returned), so the
 * downside risk is low and the upside is well-targeted recovery.
 */
export function createDefaultToolErrorHintRegistry(options?: ToolErrorHintRulesOptions): ToolErrorHintRegistry {
	const registry = new Registry();
	if (!options?.disableBashRules) registry.addMany(bashRules);
	if (!options?.disableReadRules) registry.addMany(readRules);
	if (!options?.disableEditRules) registry.addMany(editRules);
	if (!options?.disableGenericRules) registry.addMany(genericRules);
	if (options?.extraRules) registry.addMany(options.extraRules);
	if (options?.learnedErrors && options.learnedErrors.length > 0) {
		registry.addMany(
			createLearnedErrorRules(options.learnedErrors, {
				minOccurrences: options.learnedErrorMinOccurrences,
				minSessions: options.learnedErrorMinSessions,
				maxRules: options.learnedErrorMaxRules,
			}),
		);
	}
	return registry;
}

// ---------------------------------------------------------------------------
// Dynamic rules from learned-error store
// ---------------------------------------------------------------------------

interface LearnedErrorRuleOptions {
	minOccurrences?: number;
	minSessions?: number;
	maxRules?: number;
}

/**
 * Build a set of Tier 4 rules from cross-session error fingerprints. Each
 * rule fires when the live error text contains the recurring fingerprint and
 * appends a frequency-annotated hint so the model knows the same pattern has
 * burned it before.
 *
 * Skips entries that already have a `matchedRuleIds` entry — those are
 * already covered by built-in rules. Skips entries below the recurrence
 * threshold so we don't materialise a rule from a single flaky session.
 */
export function createLearnedErrorRules(
	aggregated: AggregatedLearnedError[],
	options?: LearnedErrorRuleOptions,
): ToolErrorHintRule[] {
	const minOccurrences = Math.max(2, options?.minOccurrences ?? 3);
	const minSessions = Math.max(1, options?.minSessions ?? 2);
	const maxRules = Math.max(1, options?.maxRules ?? 32);

	const candidates = aggregated
		.filter(
			(entry) =>
				entry.totalCount >= minOccurrences &&
				entry.sessionCount >= minSessions &&
				entry.matchedRuleIds.length === 0,
		)
		.slice(0, maxRules);

	return candidates.map((entry, index) => ({
		id: `learned-${entry.tool}-${index}`,
		appliesTo: entry.tool,
		matcher: (input) => {
			// Match against the normalised live error text so digits/whitespace
			// don't break the equality check. The aggregator already normalised
			// the stored fingerprint, so this gives a fair comparison.
			const normalised = normaliseLive(input.errorText);
			return normalised.includes(entry.fingerprint);
		},
		hint: () =>
			`This error has occurred ${entry.totalCount} times across ${entry.sessionCount} sessions. Recurring pattern — re-evaluate the approach instead of retrying the same call. Sample of an earlier occurrence: ${entry.sampleErrorText}`,
	}));
}

const LIVE_RE_WHITESPACE = /\s+/g;
const LIVE_RE_DIGITS = /\d+/g;

function normaliseLive(text: string): string {
	LIVE_RE_WHITESPACE.lastIndex = 0;
	LIVE_RE_DIGITS.lastIndex = 0;
	return text.replace(LIVE_RE_WHITESPACE, " ").replace(LIVE_RE_DIGITS, "N").trim();
}
