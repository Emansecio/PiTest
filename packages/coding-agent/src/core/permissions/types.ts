/**
 * Permission system types.
 *
 * Modes — a single axis of increasing permissiveness:
 * - plan:   read-only; any tool that mutates the filesystem or runs a shell is blocked.
 *           The prompt layer additionally imposes the plan ritual (build a DAG, end
 *           with `exit_plan`).
 * - ask:    read-only Q&A stance. IDENTICAL enforcement to plan (same read-only gate
 *           in the checker) — only the prompt posture differs: answer the question
 *           directly, no plan DAG, no `exit_plan`. Two modes rather than a mode+flag
 *           because the cycle key must land on each stance as its own stop.
 * - confirm: `auto` with the TERMINAL swapped. The whole auto chain runs unchanged
 *           (denyTools → allowTools bypass → deny rules incl. the built-in floor);
 *           what changes is where a non-matching mutation lands: instead of a
 *           terminal `allow` it yields `{ decision: "confirm" }` and the layer above
 *           asks the human. Reads stay free. Deliberately symmetric with
 *           `allowlistOnly`: the SAME lists (`allowPaths`/`allowCommands`/
 *           `allowTools`) are the "don't ask me again" surface — `allowlistOnly`
 *           denies what they don't cover, `confirm` asks about it.
 *           NOT part of the alt+p cycle: reachable only via `/permission-mode
 *           confirm` and `--permission-mode confirm`.
 * - auto:   guarded default; writes/commands run without prompts, but built-in deny
 *           rules (sensitive paths, dangerous commands) are enforced as hard blocks.
 *
 * The built-in floor can still be dropped per-session via `disableBuiltinDefaults`
 * (surfaced loudly in the UI as "no-rails"); user-authored deny rules still apply.
 *
 * `allowlistOnly` is the opposite knob and is NOT a mode: an orthogonal fail-closed
 * preset for headless channels (print/RPC/CI) that flips `auto`'s terminal from
 * `allow` to `deny` for anything outside `allowPaths`/`allowCommands`/`allowTools`.
 * When it is on it also wins over `confirm` — CI must never park on a prompt.
 */
export type PermissionMode = "auto" | "plan" | "ask" | "confirm";

/** Ordered most-restrictive → most-permissive (drives help text and the cycle copy). */
export const PERMISSION_MODES: readonly PermissionMode[] = ["plan", "ask", "confirm", "auto"] as const;

export function normalizePermissionMode(value: unknown): PermissionMode | undefined {
	if (value === "auto" || value === "plan" || value === "ask" || value === "confirm") return value;
	return undefined;
}

export function isPermissionMode(value: unknown): value is PermissionMode {
	return normalizePermissionMode(value) === value;
}

/**
 * A path rule matches tool inputs that reference filesystem paths.
 * Glob is matched against absolute paths (after resolving relative to cwd).
 */
export interface PathRule {
	/** Glob pattern (e.g. "**\/.env*", "/etc/**", "node_modules/**") */
	glob: string;
	/** Optional tool-name restriction. Default applies to all tools. */
	tools?: string[];
	/** Optional human-readable rationale shown in dialogs and audit logs. */
	reason?: string;
}

/**
 * A command rule matches bash invocations by regex.
 * Tested against the raw command line.
 */
export interface CommandRule {
	/** Source string for a RegExp; matched against bash command line. */
	pattern: string;
	/** Optional flags for the RegExp (e.g. "i"). Default: "i". */
	flags?: string;
	/** Optional rationale. */
	reason?: string;
}

export interface PermissionSettings {
	/** Default mode when no CLI override is set. */
	mode?: PermissionMode;
	/**
	 * Fail-closed preset for headless channels (print/RPC/CI). ORTHOGONAL to `mode`
	 * — it is not a mode, never enters the mode cycle, and combines with any of
	 * them. When true, `auto` no longer ends in a terminal `allow`: writes must
	 * match `allowPaths`, commands must match `allowCommands`, side-effecting tools
	 * must be listed in `allowTools`, and everything else is denied (reads stay
	 * free, after the deny rules). Nothing ever prompts. Default: false.
	 * CLI: `--allowlist-only`.
	 */
	allowlistOnly?: boolean;
	/**
	 * Paths explicitly allowed (precedence step 6 in `docs/permissions.md`).
	 * Inert in `plan`/`ask`/`auto`: those end in a terminal `allow`, so a match can
	 * only confirm a decision the default would already reach. Load-bearing in the
	 * two modes that swap that terminal — under `allowlistOnly` it IS the write
	 * allowlist (uncovered write → deny), and in `confirm` it is the
	 * "don't ask me again" list (uncovered write → prompt).
	 */
	allowPaths?: PathRule[];
	/**
	 * Commands explicitly allowed (same shape as `denyCommands`: a regex tested
	 * against the raw command line). Consulted only where the terminal is swapped:
	 * under `allowlistOnly` it IS the exec allowlist, and in `confirm` it is the
	 * "don't ask me again" list. Ignored in `plan`/`ask`/`auto`.
	 */
	allowCommands?: CommandRule[];
	/** Paths always blocked (highest priority). Combined with built-in defaults unless disabled. */
	denyPaths?: PathRule[];
	/** Commands always blocked. Combined with built-in dangerous-command defaults unless disabled. */
	denyCommands?: CommandRule[];
	/** Tool names always allowed (skips checks entirely). */
	allowTools?: string[];
	/** Tool names always blocked. */
	denyTools?: string[];
	/** Disable the built-in sensitive default deny list (.env, /etc/shadow, rm -rf /, …). Default: false. */
	disableBuiltinDefaults?: boolean;
}

/**
 * Result of a permission decision.
 *
 * `confirm` is NOT a verdict — it is a deferral: the checker stays pure/synchronous
 * and hands the call to the layer above, which asks the human (interactive) or
 * denies it (headless). Every consumer of a decision must handle it explicitly;
 * treating it as `allow` by omission would silently un-gate every mutation in
 * confirm mode.
 */
export type PermissionDecision =
	| { decision: "allow" }
	| { decision: "deny"; reason: string }
	| { decision: "confirm"; reason: string };

/** What kind of action the checker is evaluating. */
export type PermissionAction =
	| { type: "read"; toolName: string; paths: string[] }
	| { type: "write"; toolName: string; paths: string[] }
	| { type: "exec"; toolName: string; command: string }
	| { type: "tool"; toolName: string; args: Record<string, unknown> };

/** Builtin sensitive defaults applied when `disableBuiltinDefaults` is false. */
export const BUILTIN_SENSITIVE_PATHS: readonly PathRule[] = [
	{ glob: "**/.env", reason: "Secrets file" },
	{ glob: "**/.env.*", reason: "Secrets file" },
	{ glob: "**/.git/config", reason: "Git config (may contain credentials)" },
	{ glob: "**/.ssh/**", reason: "SSH keys" },
	{ glob: "**/.aws/credentials", reason: "AWS credentials" },
	{ glob: "**/.npmrc", reason: "May contain auth tokens" },
	{ glob: "**/id_rsa", reason: "SSH private key" },
	{ glob: "**/id_ed25519", reason: "SSH private key" },
];

/**
 * Building blocks for the recursive-`rm` deny rules, shared by the `/`, `~`, and
 * `$HOME` variants below. Modeled as a flag LIST so every arrangement of the
 * dangerous forms collapses to one rule per target — crucially including the GNU
 * long options (`--recursive`, `--force`) that the earlier short-cluster-only
 * patterns let escape (e.g. `rm --recursive --force /`, `rm -rf --force /`):
 *   - `RM_FLAG`            — one flag token: short cluster (`-rf`) OR GNU long (`--force`).
 *   - `RM_RECURSIVE_FLAG`  — the recursive signal: a short cluster containing `r`
 *                            (`-r`, `-rf`, `-fr`) OR the long `--recursive` (`i` flag
 *                            makes both case-insensitive, so `-R`/`--RECURSIVE` too).
 *   - `RM_FLAGS_WITH_RECURSIVE` — up to 3 short/long companion flags on either side of
 *                            exactly one recursive flag, so `rm --recursive --force`,
 *                            `rm --force --recursive`, `rm -f --recursive`, `rm -rf --force`,
 *                            and the short-separated `rm -r -f` all reduce to one match.
 * Bounded quantifiers only (validateSafeRegex rejects consecutive `*`/`+` and caps
 * length at 200) — every repetition here is `{0,n}`/`{1,n}`. A non-recursive
 * `rm --force file` and deep targets (`/tmp/build`, `~/proj`, `$HOME/proj`) never match
 * (no recursive flag / target is not the final root token) — those stay for the
 * middle-tier destructive-command-guard to speed-bump.
 */
const RM_FLAG = "--?[a-zA-Z][a-zA-Z-]{0,12}";
const RM_RECURSIVE_FLAG = "(?:-[a-zA-Z]{0,8}r[a-zA-Z]{0,8}|--recursive)";
const RM_FLAGS_WITH_RECURSIVE = `(?:${RM_FLAG}\\s{1,3}){0,3}${RM_RECURSIVE_FLAG}(?:\\s{1,3}${RM_FLAG}){0,3}`;

export const BUILTIN_DANGEROUS_COMMANDS: readonly CommandRule[] = [
	// Recursive `rm` of a catastrophic target (`/`, `$HOME`, `~`) in ANY flag
	// arrangement — short clusters (`-rf`), GNU long options (`--recursive`, `--force`),
	// and mixes/separations of the two. `RM_FLAGS_WITH_RECURSIVE` requires the recursive
	// signal; an optional `-- ` end-of-options separator may sit before the target, which
	// must be the FINAL token. `/` covers bare `/`, `/*`, `/.`; `~`/`$HOME` require the
	// bare home dir (optionally one trailing `/`) to be the whole target, so
	// `~/project/node_modules` and `$HOME/proj` stay allowed.
	{
		pattern: `\\brm\\s+${RM_FLAGS_WITH_RECURSIVE}\\s{1,3}(?:--\\s{1,3})?/[*.]?(?:\\s|$)`,
		reason: "Recursive rm of /",
	},
	{
		pattern: `\\brm\\s+${RM_FLAGS_WITH_RECURSIVE}\\s{1,3}(?:--\\s{1,3})?~(?:/(?:\\s|$)|\\s|$)`,
		reason: "Recursive rm of $HOME",
	},
	// `$HOME` / `${HOME}` literal, mirroring the `~` variant above.
	{
		pattern: `\\brm\\s+${RM_FLAGS_WITH_RECURSIVE}\\s{1,3}(?:--\\s{1,3})?\\$\\{?HOME\\}?(?:/(?:\\s|$)|\\s|$)`,
		reason: "Recursive rm of $HOME",
	},
	// Command-position anchor (`^`/`;`/`&&`/`|`, optional `sudo`) on the rules below.
	// A deny-floor hit is a HARD block with no fire-once escape, so a rule that fires on
	// a command merely CONTAINING the phrase (`grep -rn "mkfs" .`) wedges routine work —
	// a false positive costs more here than a false negative, which still falls through to
	// the middle-tier destructive-command guard (a fire-once speed-bump: it blocks once and
	// lets an identical re-issue run). There is no interactive permission prompt to catch it.
	{ pattern: ":\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:&\\s*\\};:", reason: "Fork bomb" },
	{
		pattern: "(?:^|[;&|]\\s{0,3})(?:sudo\\s{1,3})?(?:mkfs|dd\\s{1,3}if=[^;&|]{0,80}of=/dev/)",
		reason: "Disk-destroying command",
	},
	{
		pattern: "(?:^|[;&|]\\s{0,3})(?:sudo\\s{1,3})?chmod\\s{1,3}-R\\s{1,3}777\\s{1,3}/",
		reason: "Recursive world-writable on root",
	},
	// PowerShell/cmd catastrophic tier. Without these, `Remove-Item -Recurse -Force C:\`
	// had no hard block anywhere on Windows (the middle-tier destructive guard only
	// speed-bumps). Targets must be the FINAL token of the segment: a drive root
	// (`C:`, `C:\`), `/`, or `~` — deeper paths like `C:\Temp\build` stay allowed.
	{
		pattern:
			"\\b(?:remove-item|ri|rm)\\b(?=[^;&|]*\\s-(?:r(?:ec(?:urse)?)?|fo(?:rce)?)\\b)[^;&|]*\\s[\"']?(?:[a-z]:[\\\\/]{0,2}|/|~)[\"']?\\s*(?:$|[;&|])",
		reason: "Recursive Remove-Item of a drive root, / or $HOME",
	},
	{
		pattern: "\\b(?:rd|rmdir|del)\\b(?=[^;&|]*\\s/s\\b)[^;&|]*\\s[\"']?[a-z]:[\\\\/]{0,2}\\*?[\"']?\\s*(?:$|[;&|])",
		reason: "Recursive delete of a drive root (cmd)",
	},
	{
		pattern: "(?:^|[;&|]\\s{0,3})(?:sudo\\s{1,3})?(?:format-volume|clear-disk)\\b",
		reason: "Disk-destroying command (PowerShell)",
	},
	{ pattern: "(?:^|[;&|]\\s{0,3})(?:sudo\\s{1,3})?format\\s{1,3}[a-z]:(?:\\s|$)", reason: "Formatting a drive" },
	{
		pattern:
			"(?:^|[;&|]\\s{0,3})(?:sudo\\s{1,3})?aws\\s{1,3}s3\\s{1,3}rm\\s(?=[^;&|]{0,120}--recursive\\b)[^;&|]{0,120}s3://[a-z0-9][a-z0-9.-]{1,61}/?(?:\\s|$)",
		reason: "Recursive delete of an S3 bucket root",
	},
	{
		pattern: "(?:^|[;&|]\\s{0,3})(?:sudo\\s{1,3})?aws\\s{1,3}s3\\s{1,3}rb\\b(?=[^;&|]{0,120}--force\\b)",
		reason: "Force-deleting an S3 bucket",
	},
	{
		pattern: "(?:^|[;&|]\\s{0,3})(?:sudo\\s{1,3})?kubectl\\s[^;&|]{0,60}delete\\s{1,3}(?:namespaces?|ns)\\b",
		reason: "Deleting a Kubernetes namespace",
	},
	{
		pattern:
			"(?:^|[;&|]\\s{0,3})(?:sudo\\s{1,3})?kubectl\\s[^;&|]{0,60}delete\\b(?=[^;&|]{0,120}\\s--all-namespaces\\b)",
		reason: "Cluster-wide kubectl delete",
	},
	{ pattern: "(?:^|[;&|]\\s{0,3})(?:sudo\\s{1,3})?dropdb\\b", reason: "Dropping a database" },
	{
		pattern:
			"(?:^|[;&|]\\s{0,3})(?:sudo\\s{1,3})?(?:psql|mysql|mariadb|sqlite3|mongosh)\\s[^;&|]{0,160}\\bdrop\\s{1,3}(?:database|schema)\\b",
		reason: "Dropping a database/schema",
	},
	{
		pattern: "(?:^|[;&|]\\s{0,3})(?:sudo\\s{1,3})?terraform\\s{1,3}destroy\\b(?=[^;&|]{0,120}-auto-approve\\b)",
		reason: "Unattended terraform destroy",
	},
];
