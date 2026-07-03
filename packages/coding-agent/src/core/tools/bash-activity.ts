/**
 * Classify a bash command as "navigation" (read-only inspection that folds into
 * a NavGroup in the interactive TUI) or "action" (an observable effect that gets
 * its own line). Conservative by design: any write redirection, any unrecognized
 * command, or any effectful segment of a pipeline taints the whole command to
 * "action". Only commands known to be read-only collapse into navigation.
 */

// Shell builtins / prefixes with no observable effect — skipped, never decisive.
const NEUTRAL = new Set(["cd", "pushd", "popd", "true", "false", ":", "test", "[", "[[", "set", "export", "unset"]);

// Commands that only read/inspect (no filesystem or state mutation).
const READONLY = new Set([
	"ls",
	"cat",
	"find",
	"grep",
	"rg",
	"egrep",
	"fgrep",
	"head",
	"tail",
	"du",
	"df",
	"pwd",
	"tree",
	"wc",
	"stat",
	"file",
	"which",
	"type",
	"echo",
	"printf",
	"sort",
	"uniq",
	"cut",
	"awk",
	"jq",
	"diff",
	"cmp",
	"less",
	"more",
	"tac",
	"nl",
	"column",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"hostname",
	"uname",
	"date",
	"whoami",
	"id",
	"env",
	"printenv",
	"ps",
	"lsblk",
	"comm",
	"look",
	"locate",
	"hexdump",
	"xxd",
	"od",
	"fold",
	"expand",
	"seq",
]);

// `git <sub>` subcommands that only read repository state.
const GIT_READONLY = new Set([
	"status",
	"log",
	"diff",
	"show",
	"branch",
	"remote",
	"ls-files",
	"blame",
	"describe",
	"rev-parse",
	"tag",
	"shortlog",
	"for-each-ref",
	"ls-tree",
	"cat-file",
	"rev-list",
	"reflog",
	"show-ref",
]);

// Hoisted so they are not re-created on every classification call.
const DEV_NULL_REDIRECT_RE = /\d*>>?&?\s*\/dev\/null/g;
const FD_DUP_RE = /\d*>&\d+/g;
// Quoted strings and backslash-escaped '>' (e.g. `[ $x \> 5 ]`) are not
// redirections; strip them so a quoted '>' does not taint a read-only command.
const QUOTED_OR_ESCAPED_RE = /'[^']*'|"[^"]*"|\\>/g;
const FILE_REDIRECT_RE = />>?\s*[^\s&|;>]/;
const SEGMENT_SEP_RE = /&&|\|\||\||;/;
const WHITESPACE_RE = /\s+/;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
// `$(...)` or `` ` ` `` command substitution can smuggle an arbitrary (possibly
// effectful) command inside an otherwise-readonly segment, e.g. `echo $(rm -rf
// x)` — token-splitting only ever sees the outer `echo`. Detected, not parsed:
// any segment containing either form taints conservatively rather than trying
// to classify the substituted command.
const COMMAND_SUBSTITUTION_RE = /\$\(|`/;

export function classifyBashCommand(command: string): "navigation" | "action" {
	// A write redirection to a real file is an effect. Strip /dev/null discards
	// and fd dups (2>/dev/null, 2>&1) first so they are not mistaken for writes.
	const cleaned = command
		.replace(QUOTED_OR_ESCAPED_RE, " ")
		.replace(DEV_NULL_REDIRECT_RE, " ")
		.replace(FD_DUP_RE, " ");
	if (FILE_REDIRECT_RE.test(cleaned)) return "action";

	for (const raw of command.split(SEGMENT_SEP_RE)) {
		const seg = raw.trim();
		if (!seg) continue;
		if (COMMAND_SUBSTITUTION_RE.test(seg)) return "action";
		// Drop leading VAR=value assignments (e.g. `FOO=bar cmd`).
		const tokens = seg.split(WHITESPACE_RE).filter((t) => !ENV_ASSIGN_RE.test(t));
		const cmd = tokens[0];
		if (!cmd || NEUTRAL.has(cmd)) continue;
		if (cmd === "git") {
			if (tokens[1] && GIT_READONLY.has(tokens[1])) continue;
			return "action";
		}
		if (!READONLY.has(cmd)) return "action";
	}
	return "navigation";
}
