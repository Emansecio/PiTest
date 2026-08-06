/**
 * CLI argument parsing and help display
 */

import type { ThinkingLevel } from "@pit/agent-core";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR } from "../config.ts";
import type { ExtensionFlag } from "../core/extensions/types.ts";
// Import from permissions/types.ts directly, NOT the permissions barrel: the
// barrel drags checker.ts → tools/argument-prep.ts → the full @pit/ai index
// (typebox, models, register-builtins — hundreds of ms of module eval) into
// every graph that only needs arg parsing.
import { normalizePermissionMode, PERMISSION_MODES, type PermissionMode } from "../core/permissions/types.ts";

export type Mode = "text" | "json" | "rpc";

export interface Args {
	provider?: string;
	model?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	continue?: boolean;
	resume?: boolean;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	noSession?: boolean;
	session?: string;
	fork?: string;
	sessionDir?: string;
	models?: string[];
	tools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	extensions?: string[];
	noExtensions?: boolean;
	print?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	noThemes?: boolean;
	noContextFiles?: boolean;
	noHashlineAnchors?: boolean;
	noLegacyDiscovery?: boolean;
	listModels?: string | true;
	offline?: boolean;
	verbose?: boolean;
	permissionMode?: PermissionMode;
	/**
	 * `--allowlist-only`: force `permissions.allowlistOnly` on for this run,
	 * overriding settings. Fail-closed CI preset — orthogonal to `--permission-mode`
	 * and combinable with any of its values.
	 */
	allowlistOnly?: boolean;
	dryRun?: boolean;
	dryRunFormat?: "text" | "json";
	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
	/** Run the turn under this role. Set by --role, or by the role-flag shortcuts --smol/--slow/--plan. */
	role?: "default" | "smol" | "slow" | "plan" | "commit";
	/**
	 * `--smol` flag value. `true` when given as a bare flag, or a string when
	 * given as `--smol <model>` / `--smol=<model>`. When a string is set, it is
	 * passed to `resolveRole()` as `cliOverride` to override the role's primary
	 * model for this turn.
	 */
	smol?: boolean | string;
	slow?: boolean | string;
	plan?: boolean | string;
	/**
	 * Wall-clock budget in SECONDS for a headless run (`-p` / `--mode json`).
	 * Threaded to print mode as `maxWallMs`; ignored in interactive mode.
	 */
	maxWall?: number;
	/**
	 * Session tool-surface profile. `minimal` disables default-on heavy tools
	 * (eval, lsp, debug, chrome, hindsight, webSearch, agentMessaging) via
	 * settings overrides — does not change package defaults for other sessions.
	 */
	profile?: "minimal";
}

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** Built-in options only. Extension flags are discovered after parsing. */
const BUILTIN_LONG_OPTIONS = [
	"help",
	"version",
	"mode",
	"continue",
	"resume",
	"provider",
	"model",
	"api-key",
	"system-prompt",
	"append-system-prompt",
	"no-session",
	"session",
	"fork",
	"session-dir",
	"models",
	"no-tools",
	"profile",
	"no-builtin-tools",
	"tools",
	"thinking",
	"max-wall",
	"print",
	"export",
	"extension",
	"no-extensions",
	"skill",
	"prompt-template",
	"theme",
	"no-skills",
	"no-prompt-templates",
	"no-themes",
	"no-context-files",
	"no-hashline-anchors",
	"no-legacy-discovery",
	"list-models",
	"verbose",
	"offline",
	"permission-mode",
	"allowlist-only",
	"dry-run",
	"smol",
	"slow",
	"plan",
	"role",
] as const;

function levenshteinDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row++) {
		let diagonal = previous[0];
		previous[0] = row;
		for (let column = 1; column <= right.length; column++) {
			const above = previous[column];
			const cost = left[row - 1] === right[column - 1] ? 0 : 1;
			previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + cost);
			diagonal = above;
		}
	}
	return previous[right.length];
}

/** Return one conservative built-in suggestion for an unknown CLI option. */
export function suggestCliOption(option: string): string | undefined {
	const normalized = option.replace(/^-+/, "").split("=", 1)[0].toLowerCase();
	if (normalized.length < 3) {
		return undefined;
	}

	let best: { name: string; distance: number } | undefined;
	for (const name of BUILTIN_LONG_OPTIONS) {
		const distance = levenshteinDistance(normalized, name);
		if (best === undefined || distance < best.distance) {
			best = { name, distance };
		}
	}
	if (best === undefined) {
		return undefined;
	}
	const threshold = Math.min(2, Math.max(1, Math.floor(normalized.length * 0.34)));
	return best.distance <= threshold ? `--${best.name}` : undefined;
}

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};

	let i = 0;
	const readRequiredValue = (option: string, allowNegativeNumber = false): string | undefined => {
		const next = args[i + 1];
		const isOptionLike = next?.startsWith("-") && next !== "-";
		const isNegativeNumber = allowNegativeNumber && next !== undefined && /^-\d|^-\.\d/.test(next);
		if (next === undefined || next.length === 0 || (isOptionLike && !isNegativeNumber)) {
			result.diagnostics.push({ type: "error", message: `Option "${option}" requires a value.` });
			return undefined;
		}
		i++;
		return next;
	};

	for (; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v" || arg === "-V") {
			result.version = true;
		} else if (arg === "--mode") {
			const mode = readRequiredValue("--mode");
			if (mode === undefined) continue;
			if (mode === "text" || mode === "json" || mode === "rpc") {
				result.mode = mode;
			} else {
				result.diagnostics.push({
					type: "error",
					message: `Invalid mode "${mode}". Valid values: text, json, rpc.`,
				});
			}
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			result.resume = true;
		} else if (arg === "--provider") {
			const value = readRequiredValue("--provider");
			if (value !== undefined) result.provider = value;
		} else if (arg === "--model") {
			const value = readRequiredValue("--model");
			if (value !== undefined) result.model = value;
		} else if (arg === "--api-key") {
			const value = readRequiredValue("--api-key");
			if (value !== undefined) result.apiKey = value;
		} else if (arg === "--system-prompt") {
			const value = readRequiredValue("--system-prompt");
			if (value !== undefined) result.systemPrompt = value;
		} else if (arg === "--append-system-prompt") {
			const value = readRequiredValue("--append-system-prompt");
			if (value === undefined) continue;
			result.appendSystemPrompt = result.appendSystemPrompt ?? [];
			result.appendSystemPrompt.push(value);
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session") {
			const value = readRequiredValue("--session");
			if (value !== undefined) result.session = value;
		} else if (arg === "--fork") {
			const value = readRequiredValue("--fork");
			if (value !== undefined) result.fork = value;
		} else if (arg === "--session-dir") {
			const value = readRequiredValue("--session-dir");
			if (value !== undefined) result.sessionDir = value;
		} else if (arg === "--models") {
			const value = readRequiredValue("--models");
			if (value === undefined) continue;
			result.models = value.split(",").map((s) => s.trim());
		} else if (arg === "--no-tools" || arg === "-nt") {
			result.noTools = true;
		} else if (arg === "--profile") {
			const profile = readRequiredValue("--profile");
			if (profile === undefined) continue;
			if (profile === "minimal") {
				result.profile = "minimal";
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Unknown profile "${profile}". Valid values: minimal`,
				});
			}
		} else if (arg === "--no-builtin-tools" || arg === "-nbt") {
			result.noBuiltinTools = true;
		} else if (arg === "--tools" || arg === "-t") {
			const value = readRequiredValue(arg === "-t" ? "-t" : "--tools");
			if (value === undefined) continue;
			result.tools = value
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
		} else if (arg === "--thinking") {
			const level = readRequiredValue("--thinking");
			if (level === undefined) continue;
			if (isValidThinkingLevel(level)) {
				result.thinking = level;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Invalid thinking level "${level}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
				});
			}
		} else if (arg === "--max-wall") {
			const raw = readRequiredValue("--max-wall", true);
			if (raw === undefined) continue;
			const seconds = Number(raw);
			if (Number.isFinite(seconds) && seconds > 0) {
				result.maxWall = seconds;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Invalid --max-wall value "${raw}". Expected a positive number of seconds.`,
				});
			}
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				result.messages.push(next);
				i++;
			}
		} else if (arg === "--export") {
			const value = readRequiredValue("--export");
			if (value !== undefined) result.export = value;
		} else if (arg === "--extension" || arg === "-e") {
			const value = readRequiredValue(arg === "-e" ? "-e" : "--extension");
			if (value === undefined) continue;
			result.extensions = result.extensions ?? [];
			result.extensions.push(value);
		} else if (arg === "--no-extensions" || arg === "-ne") {
			result.noExtensions = true;
		} else if (arg === "--skill") {
			const value = readRequiredValue("--skill");
			if (value === undefined) continue;
			result.skills = result.skills ?? [];
			result.skills.push(value);
		} else if (arg === "--prompt-template") {
			const value = readRequiredValue("--prompt-template");
			if (value === undefined) continue;
			result.promptTemplates = result.promptTemplates ?? [];
			result.promptTemplates.push(value);
		} else if (arg === "--theme") {
			const value = readRequiredValue("--theme");
			if (value === undefined) continue;
			result.themes = result.themes ?? [];
			result.themes.push(value);
		} else if (arg === "--no-skills" || arg === "-ns") {
			result.noSkills = true;
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			result.noPromptTemplates = true;
		} else if (arg === "--no-themes") {
			result.noThemes = true;
		} else if (arg === "--no-context-files" || arg === "-nc") {
			result.noContextFiles = true;
		} else if (arg === "--no-hashline-anchors") {
			result.noHashlineAnchors = true;
		} else if (arg === "--no-legacy-discovery") {
			result.noLegacyDiscovery = true;
		} else if (arg === "--list-models") {
			// Check if next arg is a search pattern (not a flag or file arg)
			if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
				result.listModels = args[++i];
			} else {
				result.listModels = true;
			}
		} else if (arg === "--verbose") {
			result.verbose = true;
		} else if (arg === "--offline") {
			result.offline = true;
		} else if (arg === "--permission-mode") {
			const rawMode = readRequiredValue("--permission-mode");
			if (rawMode === undefined) continue;
			const mode = normalizePermissionMode(rawMode);
			if (mode) {
				result.permissionMode = mode;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Invalid permission mode "${rawMode}". Valid values: ${PERMISSION_MODES.join(", ")}.`,
				});
			}
		} else if (arg === "--allowlist-only") {
			result.allowlistOnly = true;
		} else if (arg === "--dry-run") {
			result.dryRun = true;
			const next = args[i + 1];
			if (next === "json" || next === "text") {
				result.dryRunFormat = next;
				i++;
			} else {
				result.dryRunFormat = "text";
			}
		} else if (arg === "--smol" || arg.startsWith("--smol=")) {
			const eq = arg.indexOf("=");
			let value: boolean | string = true;
			if (eq !== -1) {
				value = arg.slice(eq + 1);
			} else {
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					value = next;
					i++;
				}
			}
			result.smol = value;
			result.slow = false;
			result.plan = false;
			result.role = "smol";
		} else if (arg === "--slow" || arg.startsWith("--slow=")) {
			const eq = arg.indexOf("=");
			let value: boolean | string = true;
			if (eq !== -1) {
				value = arg.slice(eq + 1);
			} else {
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					value = next;
					i++;
				}
			}
			result.slow = value;
			result.smol = false;
			result.plan = false;
			result.role = "slow";
		} else if (arg === "--plan" || arg.startsWith("--plan=")) {
			const eq = arg.indexOf("=");
			let value: boolean | string = true;
			if (eq !== -1) {
				value = arg.slice(eq + 1);
			} else {
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					value = next;
					i++;
				}
			}
			result.plan = value;
			result.smol = false;
			result.slow = false;
			result.role = "plan";
		} else if (arg === "--role") {
			const roleArg = readRequiredValue("--role");
			if (roleArg === undefined) continue;
			if (
				roleArg === "default" ||
				roleArg === "smol" ||
				roleArg === "slow" ||
				roleArg === "plan" ||
				roleArg === "commit"
			) {
				result.role = roleArg;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Invalid role "${roleArg}". Valid values: default, smol, slow, plan, commit`,
				});
			}
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				result.unknownFlags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
			} else {
				const flagName = arg.slice(2);
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					result.unknownFlags.set(flagName, next);
					i++;
				} else {
					result.unknownFlags.set(flagName, true);
				}
			}
		} else if (arg.startsWith("-") && !arg.startsWith("--")) {
			result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	return result;
}

export function printHelp(extensionFlags?: ExtensionFlag[]): void {
	// Single alignment source for the Options and Env-blocks: every flag column
	// pads to the same width so descriptions line up and stay put when flags grow.
	const FLAG_COL_WIDTH = 33;
	const flagCol = (flag: string): string => `  ${flag}`.padEnd(FLAG_COL_WIDTH);
	const extensionFlagsText =
		extensionFlags && extensionFlags.length > 0
			? `\n${chalk.bold("Extension CLI Flags:")}\n${extensionFlags
					.map((flag) => {
						const value = flag.type === "string" ? " <value>" : "";
						const description = flag.description ?? `Registered by ${flag.extensionPath}`;
						return flagCol(`--${flag.name}${value}`) + description;
					})
					.join("\n")}\n`
			: "";
	console.log(`${chalk.bold(APP_NAME)} - AI coding assistant with read, bash, edit, write tools

${chalk.bold("Usage:")}
  ${APP_NAME} [options] [@files...] [messages...]

${chalk.bold("Commands:")}
  ${APP_NAME} install <source> [-l]     Install extension source and add to settings
  ${APP_NAME} remove <source> [-l]      Remove extension source from settings
  ${APP_NAME} uninstall <source> [-l]   Alias for remove
  ${APP_NAME} update [source|self|pi]   Update ${APP_NAME} and installed extensions
  ${APP_NAME} list                      List installed extensions from settings
  ${APP_NAME} config                    Open TUI to enable/disable package resources
  ${APP_NAME} <command> --help          Show help for install/remove/uninstall/update/list

${chalk.bold("Options:")}
${[
	["--provider <name>", "Provider name"],
	["--model <pattern>", 'Model pattern or ID (supports "provider/id" and optional ":<thinking>")'],
	["--api-key <key>", "API key (defaults to env vars)"],
	["--system-prompt <text>", "System prompt (default: coding assistant prompt)"],
	["--append-system-prompt <text>", "Append text or file contents to the system prompt (can be used multiple times)"],
	["--mode <mode>", "Output mode: text (default), json, or rpc"],
	["--print, -p", "Non-interactive mode: process prompt and exit"],
	["", "Headless output format: -p / --mode text = plain text · --mode json = JSON lines · --mode rpc = RPC"],
	["", `Piping stdin into ${APP_NAME} also runs headless (print mode)`],
	[
		"--max-wall <seconds>",
		"Headless wall-clock budget: abort the in-flight turn at the limit and close with partial state (exit 124)",
	],
	["--continue, -c", "Continue previous session"],
	["--resume, -r", "Select a session to resume"],
	["--session <path|id>", "Use specific session file or partial UUID"],
	["--fork <path|id>", "Fork specific session file or partial UUID into a new session"],
	["--session-dir <dir>", "Directory for session storage and lookup"],
	["--no-session", "Don't save session (ephemeral)"],
	["--models <patterns>", "Comma-separated model patterns for Ctrl+P cycling"],
	["", "Supports globs (anthropic/*, *sonnet*) and fuzzy matching"],
	["--no-tools, -nt", "Disable all tools by default (built-in and extension)"],
	["--profile minimal", "Disable default-on heavy tools for this session"],
	["", "(eval, lsp, debug, chromeDevtools, hindsight, webSearch, agentMessaging)"],
	["--no-builtin-tools, -nbt", "Disable built-in tools by default but keep extension/custom tools enabled"],
	["--tools, -t <tools>", "Comma-separated allowlist of tool names to enable"],
	["", "Applies to built-in, extension, and custom tools"],
	["--thinking <level>", "Set thinking level: off, minimal, low, medium, high, xhigh, max, ultra"],
	["--role <name>", "Run under a model role: default | smol | slow | plan | commit"],
	["--smol [model]", "Shortcut for --role smol (cheap subagent fan-out)"],
	["", "Optional [model] overrides the role's primary model for this turn"],
	["", "(e.g. --smol claude-sonnet-4-7 or --smol=claude-sonnet-4-7)"],
	["--slow [model]", "Shortcut for --role slow (deep reasoning); optional [model] override"],
	["--plan [model]", "Shortcut for --role plan (model role only — does NOT"],
	["", "enable read-only permission mode; use --permission-mode plan"],
	["", "for that). Optional [model] override."],
	["", "--smol/--slow/--plan are mutually exclusive; rightmost wins"],
	["--extension, -e <path>", "Load an extension file (can be used multiple times)"],
	["--no-extensions, -ne", "Disable extension discovery (explicit -e paths still work)"],
	["--skill <path>", "Load a skill file or directory (can be used multiple times)"],
	["--no-skills, -ns", "Disable skills discovery and loading"],
	["--prompt-template <path>", "Load a prompt template file or directory (can be used multiple times)"],
	["--no-prompt-templates, -np", "Disable prompt template discovery and loading"],
	["--theme <path>", "Load a theme file or directory (can be used multiple times)"],
	["--no-themes", "Disable theme discovery and loading"],
	["--no-context-files, -nc", "Disable AGENTS.md and CLAUDE.md discovery and loading"],
	["--no-hashline-anchors", "Disable hashline edit anchor block on full-file reads"],
	["--no-legacy-discovery", "Disable discovery of legacy rule/skill files from other agents"],
	["", "(Cursor, Cline, Windsurf, Gemini, Copilot, VS Code, .claude/CLAUDE.md)"],
	["--export <file>", "Export session file to HTML and exit"],
	["--list-models [search]", "List available models (with optional fuzzy search)"],
	["--verbose", "Force verbose startup (overrides quietStartup setting)"],
	["--offline", "Disable startup network operations (same as PIT_OFFLINE=1)"],
	["--permission-mode <mode>", "Permission mode: plan | ask | confirm | auto (default = auto)"],
	["", "confirm = auto, but every mutation waits for your approval"],
	["", "(interactive only; denied in print/RPC)"],
	["--allowlist-only", "Fail-closed (CI): never prompts, only allowPaths /"],
	["", "allowCommands / allowTools run, everything else is denied"],
	["--dry-run [text|json]", "Inspect resolved config/auth/tools/MCP and exit without running the agent"],
	["--help, -h", "Show this help"],
	["--version, -v", "Show version number"],
]
	.map(([flag, desc]) => flagCol(flag) + desc)
	.join("\n")}

Extensions can register additional flags (e.g., --plan from plan-mode extension).${extensionFlagsText}

${chalk.bold("Examples:")}
  # Interactive mode
  ${APP_NAME}

  # Interactive mode with initial prompt
  ${APP_NAME} "List all .ts files in src/"

  # Include files in initial message
  ${APP_NAME} @prompt.md @image.png "What color is the sky?"

  # Non-interactive mode (process and exit)
  ${APP_NAME} -p "List all .ts files in src/"

  # Multiple messages (interactive)
  ${APP_NAME} "Read package.json" "What dependencies do we have?"

  # Continue previous session
  ${APP_NAME} --continue "What did we discuss?"

  # Use different model
  ${APP_NAME} --provider anthropic --model opus "Help me refactor this code"

  # Use model with provider prefix (no --provider needed)
  ${APP_NAME} --model openai-codex/gpt-5.5 "Help me refactor this code"

  # Use model with thinking level shorthand
  ${APP_NAME} --model sonnet:high "Solve this complex problem"

  # Limit model cycling to specific models
  ${APP_NAME} --models claude-sonnet,claude-haiku,grok-4.5

  # Limit to a specific provider with glob pattern
  ${APP_NAME} --models "anthropic/*"

  # Cycle models with fixed thinking levels
  ${APP_NAME} --models sonnet:high,haiku:low

  # Start with a specific thinking level
  ${APP_NAME} --thinking high "Solve this complex problem"

  # Read-only mode (no file modifications possible)
  ${APP_NAME} --tools read,grep,find,ls -p "Review the code in src/"

  # Export a session file to HTML
  ${APP_NAME} --export ~/${CONFIG_DIR_NAME}/agent/sessions/--path--/session.jsonl
  ${APP_NAME} --export session.jsonl output.html

${chalk.bold("Environment Variables:")}
  ANTHROPIC_API_KEY                - Anthropic Claude API key
  ANTHROPIC_OAUTH_TOKEN            - Anthropic OAuth token (alternative to API key)
  OPENCODE_API_KEY                 - OpenCode Zen/OpenCode Go API key
  XAI_API_KEY                      - xAI Grok API key
${flagCol(ENV_AGENT_DIR)} - Config directory (default: ~/${CONFIG_DIR_NAME}/agent)
${flagCol(ENV_SESSION_DIR)} - Session storage directory (overridden by --session-dir)
  PIT_PACKAGE_DIR                   - Override package directory (for Nix/Guix store paths)
  PIT_OFFLINE                       - Disable startup network operations when set to 1/true/yes

${chalk.bold("Built-in Tool Names (representative subset; the available set depends on enabled extensions):")}
  read   - Read file contents
  bash   - Execute bash commands
  edit   - Edit files with find/replace
  write  - Write files (creates/overwrites)
  grep   - Search file contents (read-only, off by default)
  find   - Find files by glob pattern (read-only, off by default)
  ls     - List directory contents (read-only, off by default)
`);
}
