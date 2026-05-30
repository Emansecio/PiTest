/**
 * Permission system types.
 *
 * Modes:
 * - auto: yolo mode; permissions are fully open and all checks are skipped.
 * - plan: read-only mode; any tool that mutates filesystem or runs shell is blocked.
 *
 * "yolo" is accepted as an alias for "auto" at CLI/settings/command boundaries.
 */
export type PermissionMode = "auto" | "plan";
export type PermissionModeInput = PermissionMode | "yolo";

export const PERMISSION_MODES: readonly PermissionMode[] = ["auto", "plan"] as const;
export const PERMISSION_MODE_INPUTS: readonly PermissionModeInput[] = ["auto", "yolo", "plan"] as const;

export function normalizePermissionMode(value: unknown): PermissionMode | undefined {
	if (value === "auto" || value === "yolo") return "auto";
	if (value === "plan") return "plan";
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
	/** Default mode when no CLI override is set. "yolo" is accepted as an alias for "auto". */
	mode?: PermissionModeInput;
	/** Paths always allowed without prompt. */
	allowPaths?: PathRule[];
	/** Paths always blocked (highest priority). */
	denyPaths?: PathRule[];
	/** Deprecated: ask rules are ignored now that auto/yolo is the default. */
	askPaths?: PathRule[];
	/** Commands always blocked. */
	denyCommands?: CommandRule[];
	/** Deprecated: ask rules are ignored now that auto/yolo is the default. */
	askCommands?: CommandRule[];
	/** Tool names always allowed (skips checks entirely). */
	allowTools?: string[];
	/** Tool names always blocked. */
	denyTools?: string[];
	/** Disable the built-in sensitive default deny list (.env, /etc/shadow, rm -rf /, …). Default: false. */
	disableBuiltinDefaults?: boolean;
}

/** Result of a permission decision. */
export type PermissionDecision =
	| { decision: "allow" }
	| { decision: "ask"; reason: string }
	| { decision: "deny"; reason: string };

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

export const BUILTIN_DANGEROUS_COMMANDS: readonly CommandRule[] = [
	{ pattern: "\\brm\\s+(?:-[a-zA-Z]*r[a-zA-Z]*\\s+)+/(?:\\s|$)", reason: "Recursive rm of /" },
	{ pattern: "\\brm\\s+(?:-[a-zA-Z]*r[a-zA-Z]*\\s+)+~(?:/|\\s|$)", reason: "Recursive rm of $HOME" },
	{ pattern: ":\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:&\\s*\\};:", reason: "Fork bomb" },
	{ pattern: "\\b(?:mkfs|dd\\s+if=.*of=/dev/)", reason: "Disk-destroying command" },
	{ pattern: "\\bchmod\\s+-R\\s+777\\s+/", reason: "Recursive world-writable on root" },
];
