/**
 * Default tool-rewrite rules for the coding agent.
 *
 * Three tiers (see `ToolRewriteRegistry` docstring for the contract):
 *
 *  - **Tier 1 (auto)**: silent args rewrites for shape-only deviations. The
 *    runtime mutates the call before validation and the model never sees the
 *    correction. Only safe when semantics are provably identical (key alias,
 *    encoding fix, simple split).
 *
 *  - **Tier 2 (suggest)**: cross-tool substitutions. The model called bash
 *    when a dedicated tool would have done the job. We reject with a copy-
 *    pasteable call to the correct tool so the model fixes itself in one
 *    round-trip without ever executing the wrong shell.
 *
 *  - **Tier 3 (block)**: trivially wrong calls — no-ops, out-of-bounds,
 *    invariant violations. Reject with the reason instead of running them.
 *
 * Each rule has a stable `id` so telemetry can attribute corrections back to
 * the rule that fired. Rules are matched in registration order: more specific
 * rules MUST register before more general ones.
 */

import { ToolRewriteRegistry, type ToolRewriteRule } from "@pit/agent-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull a string field from a tool call's arguments. Returns undefined if missing or non-string. */
function getString(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" ? value : undefined;
}

/** Pull a numeric field. Returns undefined if missing or non-finite. */
function getNumber(args: Record<string, unknown>, key: string): number | undefined {
	const value = args[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse a `bash` command into its leading argv tokens, respecting single and
 * double quotes. Returns undefined when the command contains shell metacharacters
 * that would change semantics (pipes, redirects, `&&`, `;`, `$(...)`, backticks,
 * subshells, glob expansion of `*` outside quotes). Tier 2 rules use this to
 * decide whether a `bash("cat X")` style call is safely substitutable for a
 * dedicated tool — if any metacharacter is present, we conservatively pass
 * through and let bash run the original command.
 */
function parseSimpleArgv(command: string): string[] | undefined {
	if (!command.trim()) return undefined;
	// Reject any shell metacharacter that would change semantics under substitution.
	if (/[|;&`$()<>]/.test(command)) return undefined;
	if (/\s>\s|\s<\s|>>|<<|&&|\|\|/.test(command)) return undefined;
	const argv: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += command[i + 1];
			i++;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current.length > 0) {
				argv.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (quote) return undefined;
	if (current.length > 0) argv.push(current);
	return argv;
}

/** JSON-encode a value compactly for inline use in suggestion messages. */
function inline(value: unknown): string {
	return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Tier 1 — auto rewrites
// ---------------------------------------------------------------------------

const tier1Rules: ToolRewriteRule[] = [
	{
		// read({ offset: "10", limit: "20" }) → numeric coercion. Some models
		// emit numeric args as quoted strings; TypeBox `Value.Convert` covers
		// most cases, but doing it here in our own pass yields a cleaner error
		// path when the string isn't numeric.
		id: "read-numeric-offset-limit",
		appliesTo: "read",
		matcher: (c) => {
			const args = c.arguments as Record<string, unknown>;
			const off = args.offset;
			const lim = args.limit;
			return (typeof off === "string" && /^\d+$/.test(off)) || (typeof lim === "string" && /^\d+$/.test(lim));
		},
		action: {
			tier: "auto",
			rewrite: (c) => {
				const args = { ...(c.arguments as Record<string, unknown>) };
				if (typeof args.offset === "string" && /^\d+$/.test(args.offset)) {
					args.offset = Number.parseInt(args.offset, 10);
				}
				if (typeof args.limit === "string" && /^\d+$/.test(args.limit)) {
					args.limit = Number.parseInt(args.limit, 10);
				}
				return { ...c, arguments: args };
			},
		},
	},
	{
		// read({ start_line, end_line }) → read({ offset, limit }).
		// Documented as a common mistake; absorb so the call succeeds rather
		// than producing a TypeBox additionalProperties error.
		id: "read-start-end-line-to-offset-limit",
		appliesTo: "read",
		matcher: (c) => {
			const args = c.arguments as Record<string, unknown>;
			return ("start_line" in args || "end_line" in args) && !("offset" in args) && !("limit" in args);
		},
		action: {
			tier: "auto",
			rewrite: (c) => {
				const args = { ...(c.arguments as Record<string, unknown>) };
				const start = typeof args.start_line === "number" ? args.start_line : undefined;
				const end = typeof args.end_line === "number" ? args.end_line : undefined;
				delete args.start_line;
				delete args.end_line;
				if (start !== undefined) args.offset = start;
				if (start !== undefined && end !== undefined && end >= start) {
					args.limit = end - start + 1;
				}
				return { ...c, arguments: args };
			},
		},
	},
	{
		// read({ path: "foo.ts:10-20" }) → read({ path: "foo.ts", offset: 10, limit: 11 }).
		// Models that don't separate the line range from the path produce this
		// form. Conservative: only fire when path has the exact `:A-B` suffix
		// AND no explicit offset/limit was provided.
		id: "read-path-range-suffix",
		appliesTo: "read",
		matcher: (c) => {
			const args = c.arguments as Record<string, unknown>;
			const path = getString(args, "path") ?? getString(args, "file_path");
			if (!path) return false;
			if ("offset" in args || "limit" in args) return false;
			return /:\d+-\d+$/.test(path);
		},
		action: {
			tier: "auto",
			rewrite: (c) => {
				const args = { ...(c.arguments as Record<string, unknown>) };
				const pathKey = "path" in args ? "path" : "file_path";
				const raw = args[pathKey] as string;
				const match = raw.match(/^(.*):(\d+)-(\d+)$/);
				if (!match) return c;
				const [, base, startStr, endStr] = match;
				const start = Number.parseInt(startStr, 10);
				const end = Number.parseInt(endStr, 10);
				args[pathKey] = base;
				args.offset = start;
				args.limit = Math.max(1, end - start + 1);
				return { ...c, arguments: args };
			},
		},
	},
];

// ---------------------------------------------------------------------------
// Tier 2 — bash → dedicated tool suggestions
// ---------------------------------------------------------------------------

/**
 * Build a suggest action that produces a consistent "use X instead" message.
 * The error body is what the LLM sees on rejection, so it should be terse
 * and copy-pasteable.
 */
function suggestUseTool(toolName: string, suggested: string): ToolRewriteRule["action"] {
	return {
		tier: "suggest",
		message: (c) => {
			const command = getString(c.arguments as Record<string, unknown>, "command") ?? "";
			return (
				`Refused: \`bash(${inline(command)})\` should use the dedicated \`${toolName}\` tool instead.\n` +
				`Call: ${suggested}\n` +
				`Reason: dedicated tools are faster, respect .gitignore, and return structured results.`
			);
		},
	};
}

const tier2Rules: ToolRewriteRule[] = [
	{
		// bash("cat foo.ts") → read({path:"foo.ts"})
		id: "bash-cat-to-read",
		appliesTo: "bash",
		matcher: (c) => {
			const command = getString(c.arguments as Record<string, unknown>, "command");
			if (!command) return false;
			const argv = parseSimpleArgv(command);
			if (!argv || argv.length < 2) return false;
			return argv[0] === "cat" && !argv[1].startsWith("-");
		},
		action: (() => {
			return {
				tier: "suggest",
				message: (c) => {
					const argv = parseSimpleArgv(getString(c.arguments as Record<string, unknown>, "command") ?? "") ?? [];
					const file = argv[1];
					return (
						`Refused: \`bash("cat ${file}")\` should use the dedicated \`read\` tool instead.\n` +
						`Call: read(${inline({ path: file })})\n` +
						`Reason: \`read\` returns structured content with anchors and respects the read-guard.`
					);
				},
			};
		})(),
	},
	{
		// bash("head -n N foo") / bash("tail -n N foo") → read with offset/limit hint
		id: "bash-head-tail-to-read",
		appliesTo: "bash",
		matcher: (c) => {
			const command = getString(c.arguments as Record<string, unknown>, "command");
			if (!command) return false;
			const argv = parseSimpleArgv(command);
			if (!argv || argv.length < 2) return false;
			return argv[0] === "head" || argv[0] === "tail";
		},
		action: {
			tier: "suggest",
			message: (c) => {
				const argv = parseSimpleArgv(getString(c.arguments as Record<string, unknown>, "command") ?? "") ?? [];
				const tool = argv[0];
				const file = argv[argv.length - 1];
				const nIdx = argv.indexOf("-n");
				const n = nIdx >= 0 && argv[nIdx + 1] ? Number.parseInt(argv[nIdx + 1], 10) : 10;
				if (tool === "head") {
					return (
						`Refused: \`bash("head -n ${n} ${file}")\` should use the dedicated \`read\` tool instead.\n` +
						`Call: read(${inline({ path: file, offset: 1, limit: n })})\n` +
						`Reason: \`read\` is structured and respects the read-guard.`
					);
				}
				return (
					`Refused: \`bash("tail -n ${n} ${file}")\` cannot be expressed as \`read\` directly — first inspect total line count.\n` +
					`Call: read(${inline({ path: file })}) // then use offset = lineCount - ${n} + 1, limit = ${n}\n` +
					`Reason: \`read\` is structured; if you specifically need the last N bytes/lines, justify the bash call.`
				);
			},
		},
	},
	{
		// bash("sed -n '10,20p' foo") → read({path:"foo", offset:10, limit:11})
		id: "bash-sed-range-to-read",
		appliesTo: "bash",
		matcher: (c) => {
			const command = getString(c.arguments as Record<string, unknown>, "command");
			if (!command) return false;
			return /^sed\s+-n\s+'(\d+),(\d+)p'\s+\S+\s*$/.test(command);
		},
		action: {
			tier: "suggest",
			message: (c) => {
				const command = getString(c.arguments as Record<string, unknown>, "command") ?? "";
				const match = command.match(/^sed\s+-n\s+'(\d+),(\d+)p'\s+(\S+)\s*$/);
				if (!match) return "Use `read` with offset/limit instead of `sed -n '...p'`.";
				const [, startStr, endStr, file] = match;
				const start = Number.parseInt(startStr, 10);
				const end = Number.parseInt(endStr, 10);
				return (
					`Refused: \`bash("${command}")\` should use \`read\` instead.\n` +
					`Call: read(${inline({ path: file, offset: start, limit: end - start + 1 })})`
				);
			},
		},
	},
	{
		// bash("grep ..." | "rg ..." | "ag ...") → grep tool
		id: "bash-grep-to-grep",
		appliesTo: "bash",
		matcher: (c) => {
			const command = getString(c.arguments as Record<string, unknown>, "command");
			if (!command) return false;
			const argv = parseSimpleArgv(command);
			if (!argv) return false;
			return argv.length > 0 && (argv[0] === "grep" || argv[0] === "rg" || argv[0] === "ag");
		},
		action: suggestUseTool(
			"grep",
			"grep({ pattern: <regex>, path: <dir-or-file> }) — see tool description for full options",
		),
	},
	{
		// bash("find ..." | "fd ...") → find tool
		id: "bash-find-to-find",
		appliesTo: "bash",
		matcher: (c) => {
			const command = getString(c.arguments as Record<string, unknown>, "command");
			if (!command) return false;
			const argv = parseSimpleArgv(command);
			if (!argv) return false;
			return argv.length > 0 && (argv[0] === "find" || argv[0] === "fd");
		},
		action: suggestUseTool("find", "find({ pattern: <glob> }) — globs like '**/*.ts' instead of `find . -name`"),
	},
	{
		// bash("ls ..." | "dir ...") → ls tool. Plain `ls` only — `ls -la` etc.
		// can keep using bash since the user often wants the formatted output.
		id: "bash-ls-to-ls",
		appliesTo: "bash",
		matcher: (c) => {
			const command = getString(c.arguments as Record<string, unknown>, "command");
			if (!command) return false;
			const argv = parseSimpleArgv(command);
			if (!argv) return false;
			if (argv.length === 0) return false;
			if (argv[0] !== "ls" && argv[0] !== "dir") return false;
			// Skip when caller passed flags — they likely want specific formatting.
			return argv.slice(1).every((a) => !a.startsWith("-") && !a.startsWith("/"));
		},
		action: {
			tier: "suggest",
			message: (c) => {
				const argv = parseSimpleArgv(getString(c.arguments as Record<string, unknown>, "command") ?? "") ?? [];
				const target = argv[1] ?? ".";
				return (
					`Refused: \`bash("${argv.join(" ")}")\` should use the dedicated \`ls\` tool instead.\n` +
					`Call: ls(${inline({ path: target })})\n` +
					`Reason: \`ls\` respects .gitignore and returns structured entries.`
				);
			},
		},
	},
	{
		// bash("wc -l foo") → read + count, or grep with --count.
		// Conservative: only suggest, don't try to express line counts as a
		// read+arithmetic combo because the model can decide.
		id: "bash-wc-l-suggest-read",
		appliesTo: "bash",
		matcher: (c) => {
			const command = getString(c.arguments as Record<string, unknown>, "command");
			if (!command) return false;
			return /^wc\s+-l\s+\S+\s*$/.test(command);
		},
		action: {
			tier: "suggest",
			message: (c) => {
				const command = getString(c.arguments as Record<string, unknown>, "command") ?? "";
				const file = command.replace(/^wc\s+-l\s+/, "").trim();
				return (
					`Refused: \`bash("${command}")\` — use \`read\` to inspect the file (count is included in truncation metadata).\n` +
					`Call: read(${inline({ path: file })})`
				);
			},
		},
	},
];

// ---------------------------------------------------------------------------
// Tier 3 — pre-flight blocks
// ---------------------------------------------------------------------------

const tier3Rules: ToolRewriteRule[] = [
	{
		// edit({ edits: [{ oldText: X, newText: X }] }) — no-op. Executing
		// reads the file, fails the match (because nothing changed), and
		// returns a confusing error. Reject up front.
		id: "edit-noop-old-equals-new",
		appliesTo: "edit",
		matcher: (c) => {
			const args = c.arguments as { edits?: unknown };
			if (!Array.isArray(args.edits)) return false;
			return args.edits.some((e: unknown) => {
				if (!e || typeof e !== "object") return false;
				const edit = e as { oldText?: unknown; newText?: unknown };
				return (
					typeof edit.oldText === "string" &&
					typeof edit.newText === "string" &&
					edit.oldText === edit.newText &&
					edit.oldText.length > 0
				);
			});
		},
		action: {
			tier: "block",
			reason: (c) => {
				const args = c.arguments as { edits?: Array<{ oldText?: string; newText?: string }> };
				const idx = (args.edits ?? []).findIndex(
					(e) => typeof e?.oldText === "string" && e.oldText === e.newText && e.oldText.length > 0,
				);
				return (
					`No-op edit refused: edits[${idx}].oldText === edits[${idx}].newText. ` +
					`If the change is conditional, rewrite oldText to include surrounding context so the diff is non-empty. ` +
					`If you meant to delete the text, pass newText: "".`
				);
			},
		},
	},
	{
		// read({ offset: 0 }) — read is 1-indexed. offset 0 is always a bug.
		id: "read-offset-zero",
		appliesTo: "read",
		matcher: (c) => getNumber(c.arguments as Record<string, unknown>, "offset") === 0,
		action: {
			tier: "block",
			reason: () => "Invalid offset: read is 1-indexed. Use offset: 1 for the first line.",
		},
	},
	{
		// read({ offset: negative }) or read({ limit: negative or 0 })
		id: "read-negative-bounds",
		appliesTo: "read",
		matcher: (c) => {
			const args = c.arguments as Record<string, unknown>;
			const off = getNumber(args, "offset");
			const lim = getNumber(args, "limit");
			if (off !== undefined && off < 0) return true;
			if (lim !== undefined && lim <= 0) return true;
			return false;
		},
		action: {
			tier: "block",
			reason: (c) => {
				const args = c.arguments as Record<string, unknown>;
				const off = getNumber(args, "offset");
				const lim = getNumber(args, "limit");
				const problems: string[] = [];
				if (off !== undefined && off < 0) problems.push(`offset=${off} must be >= 1`);
				if (lim !== undefined && lim <= 0) problems.push(`limit=${lim} must be >= 1`);
				return `Invalid read bounds: ${problems.join(", ")}.`;
			},
		},
	},
	{
		// write({ content: "" }) for an existing-looking path — most likely a
		// streaming-truncated arg, not intentional. Still allow if explicit.
		// This is just a guard against the common "lost args" failure mode.
		// Skip when content is explicitly empty AND path looks like a tempfile.
		// Disabled by default — too many legitimate uses (touch-style writes).
		// Kept here as a placeholder for future telemetry-driven activation.
		id: "write-empty-content-warn",
		appliesTo: "write",
		matcher: () => false,
		action: { tier: "block", reason: () => "" },
	},
	{
		// bash("rm -rf /") and similarly catastrophic patterns. Block hard.
		id: "bash-unsafe-rm-root",
		appliesTo: "bash",
		matcher: (c) => {
			const command = getString(c.arguments as Record<string, unknown>, "command");
			if (!command) return false;
			// rm -rf / | rm -rf /* | rm -rf ~ | rm -rf $HOME
			return /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/\*?|~|\$HOME|\${HOME})\s*$/.test(command);
		},
		action: {
			tier: "block",
			reason: (c) => {
				const command = getString(c.arguments as Record<string, unknown>, "command") ?? "";
				return `Refused unsafe command: \`${command}\`. This would wipe the filesystem root. If you genuinely need to delete a specific directory, pass an explicit subpath.`;
			},
		},
	},
];

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ToolRewriteRulesOptions {
	/**
	 * Enable Tier 2 (bash → dedicated tool) suggestions.
	 *
	 * **Off by default.** Replay benchmarks against real workloads
	 * (`scripts/bench-tool-rewrites.mts --replay`) showed Tier 2 had a 1.9 %
	 * false-positive rate (rejecting legitimate ad-hoc `bash("grep …")` /
	 * `bash("cat …")` calls that succeeded) and a 0 % rescue rate on the
	 * actual failures observed. Modern frontier models pick bash deliberately
	 * for one-shot inspection where the dedicated tool's API isn't a clean
	 * fit; intercepting those calls costs a round-trip with no upside.
	 *
	 * Set `true` only for deployments where you want to nudge a less-capable
	 * model toward the structured tools.
	 */
	enableTier2?: boolean;
	/** Disable Tier 3 (pre-flight blocks). Disables ALL block rules. */
	disableTier3?: boolean;
	/** Extra rules to append. Run after the defaults; later rules take lower priority. */
	extraRules?: ToolRewriteRule[];
}

/**
 * Build the default registry used by the coding-agent SDK. Rules are added in
 * tier order (1 → 2 → 3) so auto rewrites run before suggest/block, matching
 * the contract documented at the top of this file.
 */
export function createDefaultToolRewriteRegistry(options?: ToolRewriteRulesOptions): ToolRewriteRegistry {
	const registry = new ToolRewriteRegistry();
	registry.addMany(tier1Rules);
	if (options?.enableTier2) {
		registry.addMany(tier2Rules);
	}
	if (!options?.disableTier3) {
		registry.addMany(tier3Rules);
	}
	if (options?.extraRules) {
		registry.addMany(options.extraRules);
	}
	return registry;
}
