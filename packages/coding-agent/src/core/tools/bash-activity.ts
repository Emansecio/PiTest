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

export function classifyBashCommand(command: string): "navigation" | "action" {
	// A write redirection to a real file is an effect. Strip /dev/null discards
	// and fd dups (2>/dev/null, 2>&1) first so they are not mistaken for writes.
	const cleaned = command.replace(/\d*>>?&?\s*\/dev\/null/g, " ").replace(/\d*>&\d+/g, " ");
	if (/>>?\s*[^\s&|;>]/.test(cleaned)) return "action";

	for (const raw of command.split(/&&|\|\||\||;/)) {
		const seg = raw.trim();
		if (!seg) continue;
		// Drop leading VAR=value assignments (e.g. `FOO=bar cmd`).
		const tokens = seg.split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
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
