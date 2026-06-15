/**
 * CLI argument parsing and help display
 */

import type { ThinkingLevel } from "@pit/agent-core";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR } from "../config.ts";
import type { ExtensionFlag } from "../core/extensions/types.ts";
import { normalizePermissionMode, type PermissionMode } from "../core/permissions/index.ts";

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
}

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

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

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (mode === "text" || mode === "json" || mode === "rpc") {
				result.mode = mode;
			}
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			result.resume = true;
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--append-system-prompt" && i + 1 < args.length) {
			result.appendSystemPrompt = result.appendSystemPrompt ?? [];
			result.appendSystemPrompt.push(args[++i]);
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session" && i + 1 < args.length) {
			result.session = args[++i];
		} else if (arg === "--fork" && i + 1 < args.length) {
			result.fork = args[++i];
		} else if (arg === "--session-dir" && i + 1 < args.length) {
			result.sessionDir = args[++i];
		} else if (arg === "--models" && i + 1 < args.length) {
			result.models = args[++i].split(",").map((s) => s.trim());
		} else if (arg === "--no-tools" || arg === "-nt") {
			result.noTools = true;
		} else if (arg === "--no-builtin-tools" || arg === "-nbt") {
			result.noBuiltinTools = true;
		} else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length) {
			result.tools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
		} else if (arg === "--thinking" && i + 1 < args.length) {
			const level = args[++i];
			if (isValidThinkingLevel(level)) {
				result.thinking = level;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Invalid thinking level "${level}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
				});
			}
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				result.messages.push(next);
				i++;
			}
		} else if (arg === "--export" && i + 1 < args.length) {
			result.export = args[++i];
		} else if ((arg === "--extension" || arg === "-e") && i + 1 < args.length) {
			result.extensions = result.extensions ?? [];
			result.extensions.push(args[++i]);
		} else if (arg === "--no-extensions" || arg === "-ne") {
			result.noExtensions = true;
		} else if (arg === "--skill" && i + 1 < args.length) {
			result.skills = result.skills ?? [];
			result.skills.push(args[++i]);
		} else if (arg === "--prompt-template" && i + 1 < args.length) {
			result.promptTemplates = result.promptTemplates ?? [];
			result.promptTemplates.push(args[++i]);
		} else if (arg === "--theme" && i + 1 < args.length) {
			result.themes = result.themes ?? [];
			result.themes.push(args[++i]);
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
		} else if (arg === "--permission-mode" && i + 1 < args.length) {
			const rawMode = args[++i];
			const mode = normalizePermissionMode(rawMode);
			if (mode) {
				result.permissionMode = mode;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Invalid permission mode "${rawMode}". Valid values: plan, auto.`,
				});
			}
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
		} else if (arg === "--role" && i + 1 < args.length) {
			const roleArg = args[++i];
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
	const extensionFlagsText =
		extensionFlags && extensionFlags.length > 0
			? `\n${chalk.bold("Extension CLI Flags:")}\n${extensionFlags
					.map((flag) => {
						const value = flag.type === "string" ? " <value>" : "";
						const description = flag.description ?? `Registered by ${flag.extensionPath}`;
						return `  --${flag.name}${value}`.padEnd(30) + description;
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
  --provider <name>              Provider name
  --model <pattern>              Model pattern or ID (supports "provider/id" and optional ":<thinking>")
  --api-key <key>                API key (defaults to env vars)
  --system-prompt <text>         System prompt (default: coding assistant prompt)
  --append-system-prompt <text>  Append text or file contents to the system prompt (can be used multiple times)
  --mode <mode>                  Output mode: text (default), json, or rpc
  --print, -p                    Non-interactive mode: process prompt and exit
  --continue, -c                 Continue previous session
  --resume, -r                   Select a session to resume
  --session <path|id>            Use specific session file or partial UUID
  --fork <path|id>               Fork specific session file or partial UUID into a new session
  --session-dir <dir>            Directory for session storage and lookup
  --no-session                   Don't save session (ephemeral)
  --models <patterns>            Comma-separated model patterns for Ctrl+P cycling
                                 Supports globs (anthropic/*, *sonnet*) and fuzzy matching
  --no-tools, -nt                Disable all tools by default (built-in and extension)
  --no-builtin-tools, -nbt       Disable built-in tools by default but keep extension/custom tools enabled
  --tools, -t <tools>            Comma-separated allowlist of tool names to enable
                                 Applies to built-in, extension, and custom tools
  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh
  --role <name>                  Run under a model role: default | smol | slow | plan | commit
  --smol [model]                 Shortcut for --role smol (cheap subagent fan-out)
                                 Optional [model] overrides the role's primary model for this turn
                                 (e.g. --smol claude-sonnet-4-7 or --smol=claude-sonnet-4-7)
  --slow [model]                 Shortcut for --role slow (deep reasoning); optional [model] override
  --plan [model]                 Shortcut for --role plan (plan-mode model); optional [model] override
                                 --smol/--slow/--plan are mutually exclusive; rightmost wins
  --extension, -e <path>         Load an extension file (can be used multiple times)
  --no-extensions, -ne           Disable extension discovery (explicit -e paths still work)
  --skill <path>                 Load a skill file or directory (can be used multiple times)
  --no-skills, -ns               Disable skills discovery and loading
  --prompt-template <path>       Load a prompt template file or directory (can be used multiple times)
  --no-prompt-templates, -np     Disable prompt template discovery and loading
  --theme <path>                 Load a theme file or directory (can be used multiple times)
  --no-themes                    Disable theme discovery and loading
  --no-context-files, -nc        Disable AGENTS.md and CLAUDE.md discovery and loading
  --no-hashline-anchors          Disable hashline edit anchor block on full-file reads
  --no-legacy-discovery          Disable discovery of legacy rule/skill files from other agents
                                 (Cursor, Cline, Windsurf, Gemini, Copilot, VS Code, .claude/CLAUDE.md)
  --export <file>                Export session file to HTML and exit
  --list-models [search]         List available models (with optional fuzzy search)
  --verbose                      Force verbose startup (overrides quietStartup setting)
  --offline                      Disable startup network operations (same as PIT_OFFLINE=1)
  --permission-mode <mode>       Permission mode: plan | auto (default = auto)
  --dry-run [text|json]          Inspect resolved config/auth/tools/MCP and exit without running the agent
  --help, -h                     Show this help
  --version, -v                  Show version number

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
  ${APP_NAME} --provider openai --model gpt-4o-mini "Help me refactor this code"

  # Use model with provider prefix (no --provider needed)
  ${APP_NAME} --model openai/gpt-4o "Help me refactor this code"

  # Use model with thinking level shorthand
  ${APP_NAME} --model sonnet:high "Solve this complex problem"

  # Limit model cycling to specific models
  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o

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
  OPENAI_API_KEY                   - OpenAI GPT API key
  GEMINI_API_KEY                   - Google Gemini API key
  OPENROUTER_API_KEY               - OpenRouter API key
  MINIMAX_API_KEY                  - MiniMax API key
  OPENCODE_API_KEY                 - OpenCode Zen/OpenCode Go API key
  KIMI_API_KEY                     - Kimi For Coding API key
  XIAOMI_API_KEY                   - Xiaomi MiMo API key (api.xiaomimimo.com billing)
  ${ENV_AGENT_DIR.padEnd(32)} - Config directory (default: ~/${CONFIG_DIR_NAME}/agent)
  ${ENV_SESSION_DIR.padEnd(32)} - Session storage directory (overridden by --session-dir)
  PIT_PACKAGE_DIR                   - Override package directory (for Nix/Guix store paths)
  PIT_OFFLINE                       - Disable startup network operations when set to 1/true/yes
  PIT_TELEMETRY                     - Override install telemetry when set to 1/true/yes or 0/false/no

${chalk.bold("Built-in Tool Names:")}
  read   - Read file contents
  bash   - Execute bash commands
  edit   - Edit files with find/replace
  write  - Write files (creates/overwrites)
  grep   - Search file contents (read-only, off by default)
  find   - Find files by glob pattern (read-only, off by default)
  ls     - List directory contents (read-only, off by default)
`);
}
