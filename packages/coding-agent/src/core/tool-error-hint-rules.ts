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
		// Shell quoting collapsed: an unterminated quote / heredoc / unbalanced
		// construct. The shell reports "unexpected EOF" / "unterminated quoted
		// string" / "syntax error near unexpected token". Covers POSIX sh/bash and
		// the `python -c`/`awk` inline forms that hit the same quoting wall.
		id: "bash-shell-quoting-error",
		appliesTo: "bash",
		matcher: ({ errorText }) =>
			/unexpected EOF|unterminated quoted|unexpected end of file|unmatched (?:'|")|syntax error near unexpected token|here-document/i.test(
				errorText,
			),
		hint: () =>
			"Shell quoting broke (unterminated quote / unexpected EOF). Don't nest quotes or heredocs inside one command — write the payload to a temp file with `write({path:'/tmp/x', content:...})` then run it, or flip the outer/inner quote style so they don't collide.",
	},
	{
		// A genuine command timeout (the bash tool killed the process after its
		// `timeout` elapsed) surfaces as "Command timed out after N seconds" — an
		// internal tool error, NOT a user/ESC abort (those carry skipHints upstream
		// and never reach the hint layer), so this hint only ever fires on real
		// timeouts. Steer away from blindly re-running the same blocking command.
		id: "bash-timed-out",
		appliesTo: "bash",
		matcher: ({ errorText }) => /command timed out after|timed out after [\d.]+ ?s|\btimeout:\d+\b/i.test(errorText),
		hint: () =>
			"The command hit its timeout and was killed. If it's a server or other long-running process, start it in the background (`cmd &`, `nohup cmd & disown`) and poll its output instead of holding the shell; otherwise raise the `timeout` arg. Don't just re-issue the same blocking command.",
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
			'Path not found. Locate the file with `find({pattern:"**/<basename>"})` or inspect the parent dir with `ls({path:<parent>})` before retrying.',
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
		// DEPENDENCY class: a script failed at RUNTIME because a module/package is
		// missing — Python `ModuleNotFoundError`/`No module named`/`ImportError`, or
		// Node `Cannot find module`/`ERR_MODULE_NOT_FOUND`. Distinct from
		// `command not found` (a missing BINARY on PATH) and `spawn ENOENT`. Routing:
		// re-running won't help — install the dep or fix the import first.
		id: "bash-dependency-missing",
		appliesTo: "bash",
		matcher: ({ errorText }) =>
			/no module named|modulenotfounderror|cannot find module|err_module_not_found|^\s*importerror:/im.test(
				errorText,
			),
		hint: () =>
			"Missing dependency at runtime (module/package not found). Re-running the same command won't make it appear: install it (`pip install <pkg>` / `npm install <pkg>`) or fix the import path. If the name looks off, verify it on the package index before retrying.",
	},
	{
		// TRANSIENT/NETWORK class: the host/remote was unreachable (curl/wget/npm/git
		// over the network). Distinct from the tool's own `command timed out after Ns`
		// kill (that text never contains these codes). Routing: a retry MAY work, so
		// don't treat it as a code bug — but don't loop on it either.
		id: "bash-network-transient",
		appliesTo: "bash",
		matcher: ({ errorText }) =>
			/\b(econnrefused|etimedout|enotfound|econnreset|eai_again|enetunreach)\b|getaddrinfo|socket hang up|network is unreachable|temporary failure in name resolution|connection (?:refused|reset|timed out)/i.test(
				errorText,
			),
		hint: () =>
			"Transient network error — the host/remote was unreachable, not a bug in your code. A single retry may succeed; if it persists, the service is likely offline/unreachable here, so switch to an offline path instead of looping on it.",
	},
	{
		// RESOURCE class: disk or memory exhausted. Routing: re-running as-is fails
		// the same way — free space / shrink the operation, or escalate as an
		// environment limit. Never a retry-til-it-works case.
		id: "bash-resource-exhausted",
		appliesTo: "bash",
		matcher: ({ errorText }) =>
			/\benospc\b|no space left on device|\benomem\b|cannot allocate memory|out of memory|heap out of memory|javascript heap/i.test(
				errorText,
			),
		hint: () =>
			"Resource exhausted (disk or memory). Re-running as-is will fail identically: free space or shrink the operation's footprint (smaller batch, stream instead of loading everything at once), and report it to the user if it's an environment limit.",
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
		// `read({offset})` past EOF throws `Offset N is beyond end of file (M lines
		// total)`. The model over-estimated the file length; the total is right
		// there in the message, so steer it to a valid offset.
		id: "read-offset-beyond-eof",
		appliesTo: "read",
		matcher: ({ errorText }) => /beyond end of file \(\d+ lines total\)/i.test(errorText),
		hint: ({ errorText }) => {
			const total = errorText.match(/beyond end of file \((\d+) lines total\)/i)?.[1];
			const n = total ?? "N";
			return `The file has ${n} lines — retry with offset <= ${n}, or omit offset to read from the start.`;
		},
	},
	{
		id: "read-enoent-suggest-find",
		appliesTo: "read",
		matcher: ({ errorText }) => /enoent|no such file or directory/i.test(errorText),
		hint: ({ call }) => {
			const path = getString(call.arguments, "path") ?? getString(call.arguments, "file_path");
			if (!path) {
				return 'File not found. Use `find({pattern:"**/<basename>"})` to locate it.';
			}
			const base = basenameOf(path);
			return `File not found. Locate it with \`find({pattern:"**/${base}"})\` — the path you passed may be relative to a different cwd.`;
		},
	},
];

// ---------------------------------------------------------------------------
// edit rules
// ---------------------------------------------------------------------------

/** Structured `HashlineEditError.detail` shape, as carried on `result.details.detail`. */
type HashlineHintDetail =
	| { kind: "not_found"; which: string; hash: string; nearby?: number[] }
	| { kind: "ambiguous"; which: string; hash: string; matches?: number[] }
	| { kind: "overlap"; editIndex: number };

/**
 * Reads the structured hashline error detail the agent loop now preserves on
 * `result.details.detail` (see agent-loop `createErrorToolResult`). Returns
 * undefined for non-hashline errors so callers fall back to text scraping.
 */
function getHashlineDetail(result: { details?: unknown }): HashlineHintDetail | undefined {
	const detail = (result.details as { detail?: unknown } | undefined)?.detail;
	if (detail && typeof detail === "object" && "kind" in detail) {
		const kind = (detail as { kind?: unknown }).kind;
		if (kind === "not_found" || kind === "ambiguous" || kind === "overlap") return detail as HashlineHintDetail;
	}
	return undefined;
}

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
		// oldText window. Also covers hashline anchor failures (before/after_hash
		// not found or ambiguous), which are the same class of "the anchor you
		// gave does not match the live file" miss.
		id: "edit-old-text-not-found",
		appliesTo: "edit",
		matcher: ({ errorText }) =>
			(/could not find the exact text|could not find edits\[/i.test(errorText) ||
				/\.(before|after)_hash .* not found|is ambiguous \(matches lines/i.test(errorText)) &&
			!/Paste this verbatim as oldText/i.test(errorText),
		hint: () =>
			"oldText not matched. The dominant cause is leading-whitespace drift — tabs vs spaces, or a different indent depth — so the text looks identical but isn't. Re-`read` a few lines around the target and paste the exact slice, preserving the line's leading tabs/spaces verbatim. Avoid trimming, re-indenting, or summarising.",
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
	{
		// `Found N occurrences of the text in <path>. The text must be unique.`
		// oldText matched more than once. Two clean fixes: rename-style replaceAll,
		// or extend oldText until it anchors a single site.
		id: "edit-non-unique-oldtext",
		appliesTo: ["edit", "edit_v2"],
		matcher: ({ errorText }) => /Found \d+ occurrences of the text/i.test(errorText),
		hint: () =>
			"Either pass replaceAll: true to change every occurrence, or extend oldText with surrounding lines until it is unique.",
	},
	{
		// ENOENT from the edit pre-flight `access` check. edit.ts/edit-diff.ts
		// both emit the literal `Could not edit file: <path>. Error code: ENOENT.`
		// The existing read/bash ENOENT rules are filtered out for `edit` (wrong
		// appliesTo), so without this rule an edit ENOENT gets no recovery hint
		// and the model retries the same dead path.
		id: "edit-enoent-verify-path",
		appliesTo: ["edit", "edit_v2"],
		matcher: ({ errorText }) =>
			/could not edit file:.*error code:\s*ENOENT/i.test(errorText) ||
			(/could not edit file:/i.test(errorText) && /\bENOENT\b/.test(errorText)),
		hint: ({ call }) => {
			const path = getString(call.arguments, "path") ?? getString(call.arguments, "file_path");
			const base = path ? basenameOf(path) : "<basename>";
			return `File not found for edit. Verify the path with \`find({pattern:"**/${base}"})\` or \`ls({path:<parent>})\` before retrying — it may be relative to a different cwd, or the file may not exist yet (use \`write\` to create it).`;
		},
	},
	{
		// EISDIR/ENOTDIR from the edit pre-flight. The target resolved to a
		// directory (EISDIR), or a path component that should be a directory is
		// not one / the parent is missing (ENOTDIR). Retrying the same path is
		// useless; the model must inspect the path shape first.
		id: "edit-path-type",
		appliesTo: ["edit", "edit_v2"],
		matcher: ({ errorText }) => /could not edit file:.*error code:\s*(EISDIR|ENOTDIR)/i.test(errorText),
		hint: ({ call, errorText }) => {
			const path = getString(call.arguments, "path") ?? getString(call.arguments, "file_path");
			const target = path ?? "<path>";
			if (/ENOTDIR/i.test(errorText)) {
				return `Edit failed: a parent path component of \`${target}\` is not a directory (ENOTDIR). Check the parent exists and is a directory with \`ls({path:<parent>})\` before retrying — a file is being treated as a folder somewhere in the path.`;
			}
			return `Edit target \`${target}\` is a directory (EISDIR), not a file. Confirm with \`ls({path:"${target}"})\` and point the edit at a file inside it instead of the directory.`;
		},
	},
	{
		// EACCES/EPERM from the edit pre-flight. The file exists but the process
		// lacks permission to write it. The model must not silently chmod it —
		// surface the path to the user, who decides whether to grant access.
		id: "edit-permission",
		appliesTo: ["edit", "edit_v2"],
		matcher: ({ errorText }) => /could not edit file:.*error code:\s*(EACCES|EPERM)/i.test(errorText),
		hint: ({ call }) => {
			const path = getString(call.arguments, "path") ?? getString(call.arguments, "file_path");
			const target = path ?? "<path>";
			return `Permission denied writing \`${target}\` (EACCES/EPERM). Report this path to the user and ask how to proceed — do not silently \`chmod\` or change ownership to force the write.`;
		},
	},
	{
		// Read-guard block: editing a file that was never read this session.
		// read-guard-extension.ts emits `Read guard: unread "<p>" — read it first.`
		// (and related one-liners). The model must read first; this rule makes
		// that explicit instead of letting it retry the blocked edit.
		id: "edit-read-guard-not-read",
		appliesTo: ["edit", "edit_v2"],
		matcher: ({ errorText }) =>
			/read guard:\s*unread\b/i.test(errorText) ||
			/read guard:.*has not been read/i.test(errorText) ||
			/read guard:\s*stale\b/i.test(errorText) ||
			/changed since it was last read/i.test(errorText),
		hint: ({ call }) => {
			const path = getString(call.arguments, "path") ?? getString(call.arguments, "file_path");
			const target = path ? `\`read({path:"${path}"})\`` : "the file";
			return `Edit blocked: read ${target} first this session, then re-issue the edit. The guard requires fresh, verified content before mutating a file.`;
		},
	},
	{
		// Hashline anchor miss: before/after_hash not found or ambiguous. The
		// content-hash anchors were computed from a stale view of the file, so
		// the fix is always to re-read for fresh anchors. We surface the
		// nearby/matches line numbers so the model knows where to look.
		//
		// Prefers the structured `HashlineEditError.detail` the agent loop now
		// preserves on `result.details.detail`; falls back to scraping the
		// rendered message for older paths or when detail is absent.
		id: "edit-hashline-anchor-stale",
		appliesTo: ["edit", "edit_v2"],
		matcher: ({ result, errorText }) => {
			const detail = getHashlineDetail(result);
			if (detail && (detail.kind === "not_found" || detail.kind === "ambiguous")) return true;
			return (
				/\.(before|after)_hash .* not found/i.test(errorText) ||
				/\.(before|after)_hash .* is ambiguous \(matches lines/i.test(errorText)
			);
		},
		hint: ({ result, errorText }) => {
			let where = "";
			const detail = getHashlineDetail(result);
			if (detail?.kind === "ambiguous" && detail.matches?.length) {
				where = ` The anchor matches multiple windows (lines ${detail.matches.join(", ")}) — pick a unique anchor from the fresh read.`;
			} else if (detail?.kind === "not_found" && detail.nearby?.length) {
				where = ` Closest candidates are near lines ${detail.nearby.join(", ")}.`;
			} else {
				// Fallback: scrape the rendered message (structured detail dropped).
				const ambiguous = /is ambiguous \(matches lines ([\d,\s]+)/i.exec(errorText);
				const nearby = /nearby lines:\s*([\d,\s]+)/i.exec(errorText);
				if (ambiguous?.[1]) {
					where = ` The anchor matches multiple windows (lines ${ambiguous[1].trim()}) — pick a unique anchor from the fresh read.`;
				} else if (nearby?.[1]) {
					where = ` Closest candidates are near lines ${nearby[1].trim()}.`;
				}
			}
			return `Hashline anchor stale: the before/after_hash no longer matches the live file. Re-\`read\` the file to get fresh content-hash anchors, then re-issue the edit with the new hashes.${where}`;
		},
	},
];

// ---------------------------------------------------------------------------
// write rules
// ---------------------------------------------------------------------------

const writeRules: ToolErrorHintRule[] = [
	{
		// write auto-creates parent directories (mkdir recursive) before writing,
		// so a raw Node `ENOENT` here is NOT a plain missing-parent case — it means
		// the resolved path is invalid (bad drive/root) or a component could not be
		// created. Node fs errors carry the code as a message prefix, e.g.
		// `ENOENT: no such file or directory, open '<path>'`.
		id: "write-enoent-path-invalid",
		appliesTo: "write",
		matcher: ({ errorText }) => /\bENOENT\b/i.test(errorText) || /no such file or directory/i.test(errorText),
		hint: () =>
			"Write failed with ENOENT. write already creates parent dirs, so this usually means an invalid path (bad drive/root) or an unwritable component — inspect the parent with `ls({path:<parent>})` and re-check the path before retrying.",
	},
	{
		// EACCES/EPERM from the atomic write or its mkdir. The process lacks
		// permission; the model must not chmod silently — surface it to the user.
		// Mirrors the bash/edit permission rules. Node fs messages read
		// `EACCES: permission denied, open '<path>'` / `EPERM: operation not permitted`.
		id: "write-permission-denied",
		appliesTo: "write",
		matcher: ({ errorText }) =>
			/\b(EACCES|EPERM)\b/i.test(errorText) || /permission denied|operation not permitted/i.test(errorText),
		hint: ({ call }) => {
			const path = getString(call.arguments, "path") ?? getString(call.arguments, "file_path");
			const target = path ?? "<path>";
			return `Permission denied writing \`${target}\` (EACCES/EPERM). Report this path to the user and ask how to proceed — do not silently \`chmod\` or change ownership to force the write.`;
		},
	},
	{
		// EISDIR: the target path resolves to an existing directory. Node emits
		// `EISDIR: illegal operation on a directory, open '<path>'`. Retrying the
		// same path is useless — the model must point write at a file instead.
		id: "write-target-is-directory",
		appliesTo: "write",
		matcher: ({ errorText }) => /\bEISDIR\b/i.test(errorText) || /illegal operation on a directory/i.test(errorText),
		hint: ({ call }) => {
			const path = getString(call.arguments, "path") ?? getString(call.arguments, "file_path");
			const target = path ?? "<path>";
			return `Write target \`${target}\` is a directory (EISDIR), not a file. Confirm with \`ls({path:"${target}"})\` and point write at a file path inside it instead of the directory.`;
		},
	},
];

// ---------------------------------------------------------------------------
// find / grep / ls rules — the navigation tools
// ---------------------------------------------------------------------------

/** Shared hint for a missing search ROOT (find/grep): the pattern is fine, the dir is gone. */
function searchPathNotFoundHint(args: unknown): string {
	const path = getString(args, "path");
	const where = path ? `\`${path}\`` : "the search directory";
	return `Search directory ${where} does not exist. Verify it with \`ls({path:<parent>})\` or drop the \`path\` arg to search from cwd — the pattern is fine, the root is missing.`;
}

const findRules: ToolErrorHintRule[] = [
	{
		// find resolves a search root before running fd. Custom ops emit
		// `Path not found: <dir>`; the default fd path surfaces fd's own stderr
		// (`[fd error]: ... does not exist` / `... is not a directory`). In every
		// case the search ROOT is bad, not the glob.
		id: "find-search-path-not-found",
		appliesTo: "find",
		matcher: ({ errorText }) =>
			/path not found:/i.test(errorText) ||
			(/\[fd error\]/i.test(errorText) && /(does not exist|not a directory|no such file)/i.test(errorText)),
		hint: ({ call }) => searchPathNotFoundHint(call.arguments),
	},
	{
		// A malformed glob (unbalanced `[` / `{`) reaches fd raw for patterns with
		// no `/` — path-containing patterns are post-filtered with minimatch and
		// never hit fd's parser. fd/globset reports the parse failure on stderr,
		// which find rejects verbatim.
		id: "find-invalid-glob",
		appliesTo: "find",
		matcher: ({ errorText }) =>
			/glob/i.test(errorText) && /(parse|unclosed|unexpected|invalid|unbalanced|unterminated)/i.test(errorText),
		hint: () =>
			"Invalid glob pattern. Balance or escape the special glob chars (`[ ] { }`), and note that find uses glob syntax with forward slashes — not regex. For a regex or content search, use the `grep` tool instead.",
	},
];

const grepRules: ToolErrorHintRule[] = [
	{
		// grep stats the search root before spawning rg and emits
		// `Path not found: <dir>` when that fails. Same class as find's — the root
		// is missing, so retrying the pattern is pointless.
		id: "grep-search-path-not-found",
		appliesTo: "grep",
		matcher: ({ errorText }) => /path not found:/i.test(errorText),
		hint: ({ call }) => searchPathNotFoundHint(call.arguments),
	},
	{
		// A regex-parse error means the PATTERN is malformed. grep's ripgrep path
		// already enriches this with "set literal: true" guidance, so we only fire
		// when that guidance is ABSENT (e.g. an alternate backend surfaced the raw
		// rg/regex error) — otherwise the hint would merely repeat the error.
		id: "grep-invalid-regex",
		appliesTo: "grep",
		matcher: ({ errorText }) =>
			/regex parse error|invalid regex pattern/i.test(errorText) && !/literal:\s*true/i.test(errorText),
		hint: () =>
			"Regex parse error: the pattern has unbalanced or unescaped metacharacters (`( ) [ ] . * + ? | \\`). Escape them, or set `literal: true` to match the text verbatim.",
	},
];

const lsRules: ToolErrorHintRule[] = [
	{
		// ls emits `Path not found: <dir>` from its pre-flight exists check, or a
		// raw ENOENT from readdir. The directory itself is missing.
		id: "ls-path-not-found",
		appliesTo: "ls",
		matcher: ({ errorText }) =>
			/path not found:/i.test(errorText) ||
			/\bENOENT\b/i.test(errorText) ||
			/no such file or directory/i.test(errorText),
		hint: ({ call }) => {
			const path = getString(call.arguments, "path");
			const base = path ? basenameOf(path) : "<name>";
			return `Directory not found. List its parent with \`ls({path:<parent>})\` to check the name, or locate it with \`find({pattern:"**/${base}"})\`.`;
		},
	},
	{
		// ls emits `Not a directory: <path>` when stat resolves a non-directory, or
		// a raw ENOTDIR (a mid-path component is a file). Pointing ls at a file, or
		// through a file, never lists — the model must inspect the path shape.
		id: "ls-not-a-directory",
		appliesTo: "ls",
		matcher: ({ errorText }) => /not a directory:/i.test(errorText) || /\bENOTDIR\b/i.test(errorText),
		hint: ({ call }) => {
			const path = getString(call.arguments, "path");
			const target = path ? `\`${path}\`` : "that path";
			return `${target} is a file, not a directory. Use \`read({path:...})\` to view a file, or \`ls\` the parent directory to see what's alongside it.`;
		},
	},
];

// ---------------------------------------------------------------------------
// lsp rules — language-server navigation / diagnostics
// ---------------------------------------------------------------------------

const lspRules: ToolErrorHintRule[] = [
	{
		// No server is mapped to this file extension, or the configured server
		// binary is missing / crashed on launch (spawn ENOENT, early exit).
		id: "lsp-server-unavailable",
		appliesTo: "lsp",
		matcher: ({ errorText }) =>
			/no language server found for this action/i.test(errorText) ||
			/lsp server exited/i.test(errorText) ||
			/failed to initialize lsp/i.test(errorText) ||
			(/lsp error on/i.test(errorText) &&
				/(spawn\s+\S+\s+enoent|command not found|not recognized)/i.test(errorText)),
		hint: ({ errorText }) => {
			if (/no language server found/i.test(errorText)) {
				return "No LSP server is mapped to this file type. Check `.pit/lsp.json` for the extension→server mapping — or use `read`/`grep`/`symbol` for navigation.";
			}
			return "Language server binary failed to start (missing from PATH or crashed). Install the server for this language and verify the `command` in LSP config — or use `grep`/`read`/`symbol` instead.";
		},
	},
	{
		// resolveSymbolColumn / ensureFileOpen surfaces `File not found: <path>`
		// (wrapped as `LSP error on <server>: File not found: ...`).
		id: "lsp-file-not-found",
		appliesTo: "lsp",
		matcher: ({ errorText }) => /file not found:/i.test(errorText),
		hint: ({ call }) => {
			const file = getString(call.arguments, "file");
			const base = file ? basenameOf(file) : "<basename>";
			return `LSP target file not found. Locate it with \`find({pattern:"**/${base}"})\` or verify the \`file\` path is relative to cwd — stale paths after renames are a common cause.`;
		},
	},
];

// ---------------------------------------------------------------------------
// ast_edit rules — structural rewrites via ast-grep CLI
// ---------------------------------------------------------------------------

const astEditRules: ToolErrorHintRule[] = [
	{
		// ast-edit.ts surfaces AST_GREP_INSTALL_HINT verbatim when execFile
		// cannot spawn the binary (ENOENT / EINVAL / cmd not recognized).
		id: "ast-edit-cli-missing",
		appliesTo: "ast_edit",
		matcher: ({ errorText }) => /ast-grep cli not installed/i.test(errorText),
		hint: () =>
			"ast-grep is not on PATH. Install it (see the error URL) or use `edit`/`grep` for text-level changes that do not need AST-aware rewrites.",
	},
	{
		// ast-grep rejects unparseable pattern/rewrite before scanning.
		// Typical stderr: "Cannot parse query as a valid pattern", "Multiple AST
		// nodes are detected", or "pattern fails to parse". Do NOT fire on the
		// missing-CLI path — that has its own rule above.
		id: "ast-edit-pattern-parse",
		appliesTo: "ast_edit",
		matcher: ({ errorText }) =>
			/cannot parse (?:query as a )?a valid pattern|pattern fails to parse|multiple ast nodes|fails to parse or contains error|pattern has error/i.test(
				errorText,
			) && !/ast-grep cli not installed/i.test(errorText),
		hint: () =>
			"ast-grep could not parse `pattern`/`rewrite` as valid code for the chosen `lang` — patterns must be syntactically valid snippets (use `$META` captures), not regex. Try a smaller complete expression or use `edit` for literal text.",
	},
];

// ---------------------------------------------------------------------------
// exit_plan rules — plan-mode-only tool called from execution mode
// ---------------------------------------------------------------------------

const exitPlanRules: ToolErrorHintRule[] = [
	{
		// `exit_plan` is registered in every mode but only meaningful in plan mode.
		// Called from execution (auto) mode it returns a terse "only available in
		// plan mode" with no steering, so the model retries or stalls. Redirect it
		// to just continue the work.
		id: "exit-plan-not-in-plan-mode",
		appliesTo: "exit_plan",
		matcher: ({ errorText }) => /exit_plan is only available in plan mode/i.test(errorText),
		hint: () =>
			"You are already in execution (auto) mode — there is no plan to exit. Just continue the work directly. exit_plan only applies while in plan mode.",
	},
];

// ---------------------------------------------------------------------------
// todo rules — single-action list tool
// ---------------------------------------------------------------------------

const todoRules: ToolErrorHintRule[] = [
	{
		// `todo({action:"update"|"get"|"delete", id})` against an id that is not in
		// the list returns `No todo with id N.`; the model guessed an id instead of
		// listing first. Point it at the list op so it reads real ids.
		id: "todo-unknown-id",
		appliesTo: "todo",
		matcher: ({ errorText }) => /^No todo with id \d+\./m.test(errorText),
		hint: () => 'Call todo({action:"list"}) to see valid ids before update/get/delete.',
	},
];

// ---------------------------------------------------------------------------
// retain rules — hindsight memory store
// ---------------------------------------------------------------------------

const retainRules: ToolErrorHintRule[] = [
	{
		// `retain({kind})` validates `kind` against a fixed enum; an out-of-set
		// value trips the generic typebox "must be equal to one of the allowed
		// values" error, which does not name the allowed set. List it.
		id: "retain-invalid-kind",
		appliesTo: "retain",
		matcher: ({ errorText }) => /must be equal to one of the allowed values/i.test(errorText),
		hint: () =>
			'retain kind must be one of "fact", "decision", or "pattern" (default "fact"). Fix the kind and resend.',
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
	/**
	 * Lazy provider for cross-session learned errors. Used instead of
	 * {@link ToolErrorHintRulesOptions.learnedErrors} when the load is expensive
	 * (synchronous disk scan of every per-session JSONL file) and should be kept
	 * off the startup critical path. The provider is invoked at most once — the
	 * first time the registry is read (i.e. when a tool errors and the registry
	 * is applied), never during session creation or turn-1 prompt build. The
	 * resulting learned-error rules are identical to passing the same array via
	 * `learnedErrors`; only the load timing differs. Ignored if `learnedErrors`
	 * is also provided.
	 */
	learnedErrorsProvider?: () => AggregatedLearnedError[];
	/** Disable bash hint rules. Default: enabled. */
	disableBashRules?: boolean;
	/** Disable read hint rules. Default: enabled. */
	disableReadRules?: boolean;
	/** Disable edit hint rules. Default: enabled. */
	disableEditRules?: boolean;
	/** Disable write hint rules. Default: enabled. */
	disableWriteRules?: boolean;
	/** Disable find hint rules. Default: enabled. */
	disableFindRules?: boolean;
	/** Disable grep hint rules. Default: enabled. */
	disableGrepRules?: boolean;
	/** Disable ls hint rules. Default: enabled. */
	disableLsRules?: boolean;
	/** Disable lsp hint rules. Default: enabled. */
	disableLspRules?: boolean;
	/** Disable ast_edit hint rules. Default: enabled. */
	disableAstEditRules?: boolean;
	/** Disable exit_plan hint rules. Default: enabled. */
	disableExitPlanRules?: boolean;
	/** Disable todo hint rules. Default: enabled. */
	disableTodoRules?: boolean;
	/** Disable retain hint rules. Default: enabled. */
	disableRetainRules?: boolean;
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
	/**
	 * Count-dominant escape hatch: an error whose cumulative `totalCount` reaches
	 * this threshold qualifies for a rule even from a SINGLE session, bypassing
	 * the `minSessions` bar. Lets very high-frequency same-session mistakes
	 * (e.g. the todo batch shape, task general-purpose) get covered instead of
	 * being stranded by the >=2-sessions rule. Default: 5.
	 */
	learnedErrorCountDominantThreshold?: number;
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
	// A lazy provider (and no eager array) defers the expensive learned-error
	// disk scan off the startup path until the registry is first read on a tool
	// error. The static rules below are still added eagerly so they are present
	// for the very first tool error even if it precedes any learned-error read.
	const useLazy = !options?.learnedErrors && typeof options?.learnedErrorsProvider === "function";
	const registry = useLazy
		? new LazyLearnedToolErrorHintRegistry(
				options as ToolErrorHintRulesOptions & { learnedErrorsProvider: () => AggregatedLearnedError[] },
			)
		: new Registry();
	if (!options?.disableBashRules) registry.addMany(bashRules);
	if (!options?.disableReadRules) registry.addMany(readRules);
	if (!options?.disableEditRules) registry.addMany(editRules);
	if (!options?.disableWriteRules) registry.addMany(writeRules);
	if (!options?.disableFindRules) registry.addMany(findRules);
	if (!options?.disableGrepRules) registry.addMany(grepRules);
	if (!options?.disableLsRules) registry.addMany(lsRules);
	if (!options?.disableLspRules) registry.addMany(lspRules);
	if (!options?.disableAstEditRules) registry.addMany(astEditRules);
	if (!options?.disableExitPlanRules) registry.addMany(exitPlanRules);
	if (!options?.disableTodoRules) registry.addMany(todoRules);
	if (!options?.disableRetainRules) registry.addMany(retainRules);
	if (!options?.disableGenericRules) registry.addMany(genericRules);
	if (options?.extraRules) registry.addMany(options.extraRules);
	if (options?.learnedErrors && options.learnedErrors.length > 0) {
		registry.addMany(learnedRulesFor(options.learnedErrors, options));
	}
	return registry;
}

/** Build learned-error rules from an aggregated array using the option thresholds. */
function learnedRulesFor(
	learnedErrors: AggregatedLearnedError[],
	options: ToolErrorHintRulesOptions,
): ToolErrorHintRule[] {
	return createLearnedErrorRules(learnedErrors, {
		minOccurrences: options.learnedErrorMinOccurrences,
		minSessions: options.learnedErrorMinSessions,
		countDominantThreshold: options.learnedErrorCountDominantThreshold,
		maxRules: options.learnedErrorMaxRules,
	});
}

/**
 * Registry that materialises its learned-error rules on first read instead of
 * at construction. The learned-error load is a synchronous scan of every
 * per-session JSONL file under `~/.pit/agent/learned-errors/`; doing it lazily
 * keeps it off the session-creation/turn-1 path. The static rules are added by
 * the caller at construction, so the only thing deferred is the disk read and
 * the learned-rule build. Because the learned rules are appended after all
 * static rules (exactly as the eager path does), registration order — and thus
 * `apply`'s ordering and dedup behaviour — is identical to the eager registry.
 */
class LazyLearnedToolErrorHintRegistry extends Registry {
	private learnedMaterialised = false;
	private readonly provideLearnedErrors: () => AggregatedLearnedError[];
	private readonly learnedOptions: ToolErrorHintRulesOptions;

	constructor(options: ToolErrorHintRulesOptions & { learnedErrorsProvider: () => AggregatedLearnedError[] }) {
		super();
		this.provideLearnedErrors = options.learnedErrorsProvider;
		this.learnedOptions = options;
	}

	private materialiseLearned(): void {
		if (this.learnedMaterialised) return;
		// Mark first so a throwing/recursive read does not retry on every call.
		this.learnedMaterialised = true;
		const learned = this.provideLearnedErrors();
		if (learned.length > 0) {
			this.addMany(learnedRulesFor(learned, this.learnedOptions));
		}
	}

	override apply(...args: Parameters<Registry["apply"]>): ReturnType<Registry["apply"]> {
		this.materialiseLearned();
		return super.apply(...args);
	}

	override list(): ReturnType<Registry["list"]> {
		this.materialiseLearned();
		return super.list();
	}

	override size(): number {
		this.materialiseLearned();
		return super.size();
	}
}

// ---------------------------------------------------------------------------
// Dynamic rules from learned-error store
// ---------------------------------------------------------------------------

/** Default count-dominant threshold: totalCount at/above this qualifies from a single session. */
export const DEFAULT_COUNT_DOMINANT_THRESHOLD = 5;

interface LearnedErrorRuleOptions {
	minOccurrences?: number;
	minSessions?: number;
	countDominantThreshold?: number;
	maxRules?: number;
}

/** Resolved thresholds for {@link qualifiesForLearnedRule}. */
export interface LearnedRuleThresholds {
	minOccurrences: number;
	minSessions: number;
	countDominantThreshold: number;
}

/**
 * Shared gate deciding whether an aggregated learned error qualifies for
 * promotion to a Tier-4 rule (hint registry) or a preventive guard. Two
 * independent paths qualify an entry:
 *
 *  - **standard**: recurred across sessions — `totalCount >= minOccurrences`
 *    AND `sessionCount >= minSessions`.
 *  - **count-dominant**: a very high cumulative `totalCount >= countDominantThreshold`,
 *    even from a single session — closes the structural gap where a mistake the
 *    model burns many times in ONE session was never covered.
 *
 * An entry already covered by a built-in rule (`matchedRuleIds`) never
 * qualifies — its targeted hint is better. Used by BOTH the hint registry and
 * the preventive guard so the two never drift.
 */
export function qualifiesForLearnedRule(
	entry: Pick<AggregatedLearnedError, "totalCount" | "sessionCount" | "matchedRuleIds">,
	thresholds: LearnedRuleThresholds,
): boolean {
	if (entry.matchedRuleIds.length > 0) return false;
	const standard = entry.totalCount >= thresholds.minOccurrences && entry.sessionCount >= thresholds.minSessions;
	const countDominant = entry.totalCount >= thresholds.countDominantThreshold;
	return standard || countDominant;
}

/**
 * Build a set of Tier 4 rules from cross-session error fingerprints. Each
 * rule fires when the live error text contains the recurring fingerprint and
 * appends a frequency-annotated hint so the model knows the same pattern has
 * burned it before.
 *
 * Skips entries that already have a `matchedRuleIds` entry — those are
 * already covered by built-in rules. Qualification is delegated to
 * {@link qualifiesForLearnedRule}: an entry passes either the cross-session
 * recurrence bar or the count-dominant single-session bar.
 */
export function createLearnedErrorRules(
	aggregated: AggregatedLearnedError[],
	options?: LearnedErrorRuleOptions,
): ToolErrorHintRule[] {
	const minOccurrences = Math.max(2, options?.minOccurrences ?? 3);
	const minSessions = Math.max(1, options?.minSessions ?? 2);
	const countDominantThreshold = Math.max(1, options?.countDominantThreshold ?? DEFAULT_COUNT_DOMINANT_THRESHOLD);
	const maxRules = Math.max(1, options?.maxRules ?? 32);

	const candidates = aggregated
		.filter((entry) => qualifiesForLearnedRule(entry, { minOccurrences, minSessions, countDominantThreshold }))
		.slice(0, maxRules);

	return candidates.map((entry, index) => ({
		id: `learned-${entry.tool}-${index}`,
		appliesTo: entry.tool,
		matcher: (input) => {
			// Match against the normalised live error text so digits/whitespace
			// don't break the equality check. The aggregator already normalised
			// the stored fingerprint, so this gives a fair comparison.
			const normalised = normaliseLive(input.errorText);
			return fingerprintMatchesLive(normalised, entry.fingerprint);
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

/**
 * Match a stored fingerprint against normalized live error text. Fingerprints
 * are length-capped to 120 chars with a trailing ellipsis (U+2026) by
 * normalizeErrorFingerprint, so a literal `includes` of the capped form never
 * matches the un-capped live text. Strip the ellipsis and match the prefix.
 */
function fingerprintMatchesLive(liveNormalised: string, fingerprint: string): boolean {
	const fp = fingerprint.endsWith("…") ? fingerprint.slice(0, -1) : fingerprint;
	return fp.length > 0 && liveNormalised.includes(fp);
}

/**
 * Build a Tier 4 rule from a fingerprint that has ALREADY recurred within the
 * CURRENT session. The cross-session learned rules only materialise next boot
 * (they need minSessions >= 2 and a disk round-trip), so a pattern that burns
 * the model twice in one session would otherwise keep repeating silently until
 * the session ends. Registering this rule live closes that gap: the next
 * occurrence of the same normalized error gets a corrective hint immediately.
 */
export function createSameSessionHintRule(args: {
	tool: string;
	fingerprint: string;
	count: number;
	index: number;
}): ToolErrorHintRule {
	const { tool, fingerprint, count, index } = args;
	return {
		id: `session-${tool}-${index}`,
		appliesTo: tool,
		matcher: (input) => fingerprintMatchesLive(normaliseLive(input.errorText), fingerprint),
		hint: () =>
			`This same error has already occurred ${count}× in THIS session. Stop retrying the same call — change the approach (different tool, different arguments, or read the relevant file/state first).`,
	};
}
