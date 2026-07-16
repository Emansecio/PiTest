/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ImageContent } from "@pit/ai";
// Value import comes from the tiny models-compare leaf (see package.json
// exports + root tsconfig paths), not the @pit/ai index, so main.ts's own
// import line doesn't force the full provider/typebox graph at boot.
import { modelsAreEqual } from "@pit/ai/models-compare";
import chalk from "chalk";
import { type Args, type Mode, parseArgs, printHelp } from "./cli/args.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";

import { APP_NAME, ENV_SESSION_DIR, expandTildePath, getAgentDir, getPackageDir, VERSION } from "./config.ts";
// Heavy mode-real-only graphs (agent-session-services pulls the full harness/SDK
// graph, ~1s of module eval) are loaded lazily inside main()/helpers AFTER the
// early-exits (--version, --export) so those paths don't pay for modules they
// never use. Types are kept static here (erased at build via erasableSyntaxOnly).
import type { CreateAgentSessionRuntimeFactory } from "./core/agent-session-runtime.ts";
import type { AgentSessionRuntimeDiagnostic } from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import { ensureClaudeCodeVersionEnv } from "./core/claude-code-version.ts";
import type { ExtensionFactory } from "./core/extensions/types.ts";
import { readCachedExtensionFlags, writeExtensionFlagsCache } from "./core/help-cache.ts";
import type { ModelRegistry } from "./core/model-registry.ts";
import type { ModelRole, ScopedModel } from "./core/model-resolver.ts";
import { flushRawStdout, restoreStdout, takeOverStdout, writeRawStdout } from "./core/output-guard.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.ts";
import type { SessionManager } from "./core/session-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { sweepStaleTempLogs } from "./core/temp-logs.ts";
import { markMilestone, printTimings, resetTimings, time } from "./core/timings.ts";
// mcp-cli.ts and package-manager-cli.ts are intentionally NOT imported at the
// top: package-manager-cli alone costs ~370-390ms of module eval (package
// manager, version-check, config-selector) and mcp-cli another ~25-40ms, paid
// on every boot even though they only run when argv[0] matches a subcommand.
// They are await import()ed inside the argv-gated dispatch in main() — the same
// pattern used below for session-picker/list-models/dry-run/export-html.
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { isTruthyEnvFlag } from "./utils/env-flags.ts";
import { isLocalPath } from "./utils/paths.ts";
import { ensureWindowsUtf8Console } from "./utils/windows-console.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

type ThemeModule = typeof import("./modes/interactive/theme/theme.ts");
let themeModulePromise: Promise<ThemeModule> | undefined;

function loadThemeModule(): Promise<ThemeModule> {
	if (!themeModulePromise) {
		themeModulePromise = import("./modes/interactive/theme/theme.ts");
	}
	return themeModulePromise;
}

async function initThemeLazy(themeName?: string, enableWatcher = false): Promise<void> {
	const { initTheme, detectTerminalThemeViaOsc11 } = await loadThemeModule();
	if (themeName === undefined && !process.env.COLORFGBG) {
		// No saved theme and no COLORFGBG hint (Windows Terminal, Apple Terminal,
		// most ssh/tmux): ask the terminal for its background via OSC 11 before
		// picking a default, so light terminals don't get the dark palette on
		// first run. Result is cached in the theme module; ≤100ms, once.
		await detectTerminalThemeViaOsc11().catch(() => undefined);
	}
	initTheme(themeName, enableWatcher);
}

async function stopThemeWatcherLazy(): Promise<void> {
	const { stopThemeWatcher } = await loadThemeModule();
	stopThemeWatcher();
}

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	// Cap accumulated piped stdin so a runaway/unbounded pipe (`yes | pit -p`, an
	// accidental file/stream redirect) cannot exhaust memory at startup before the
	// agent even runs. Mirrors the capping in other capture paths (runCheckCommand
	// MAX_OUTPUT_BYTES, readCapped MAX_FETCH_BYTES). 4 MiB is far above any sane
	// piped prompt; beyond it we stop appending and note the truncation.
	const MAX_STDIN_CHARS = 4 * 1024 * 1024;
	return new Promise((resolve) => {
		let data = "";
		let truncated = false;
		const onData = (chunk: string): void => {
			if (truncated) {
				return;
			}
			if (data.length + chunk.length > MAX_STDIN_CHARS) {
				data += chunk.slice(0, Math.max(0, MAX_STDIN_CHARS - data.length));
				truncated = true;
				return;
			}
			data += chunk;
		};
		const settle = (): void => {
			process.stdin.off("data", onData);
			process.stdin.off("end", onEnd);
			process.stdin.off("error", onError);
			const result = truncated ? `${data}\n\n[stdin truncated at ${MAX_STDIN_CHARS} characters]` : data;
			resolve(result.trim() || undefined);
		};
		const onEnd = (): void => {
			settle();
		};
		// If the upstream pipe source dies mid-read (EPIPE/ECONNRESET), Node treats
		// an unhandled stream 'error' as fatal and kills the process before the agent
		// runs. Swallow it and resolve with whatever was buffered so startup proceeds.
		const onError = (): void => {
			settle();
		};
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", onData);
		process.stdin.on("end", onEnd);
		process.stdin.on("error", onError);
		process.stdin.resume();
	});
}

function collectSettingsDiagnostics(
	settingsManager: SettingsManager,
	context: string,
): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		type: "warning",
		message: `(${context}, ${scope} settings) ${error.message}`,
	}));
}

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

type AppMode = "interactive" | "print" | "json" | "rpc";

function resolveAppMode(parsed: Args, stdinIsTTY: boolean): AppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY) {
		return "print";
	}
	return "interactive";
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
	return appMode === "json" ? "json" : "text";
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Result from resolving a session argument */
type ResolvedSession =
	| { type: "path"; path: string } // Direct file path
	| { type: "local"; path: string } // Found in current project
	| { type: "global"; path: string; cwd: string } // Found in different project
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// If it looks like a file path, use as-is
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: sessionArg };
	}

	const { SessionManager } = await import("./core/session-manager.ts");
	// Try to match as session ID in current project first
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatches = localSessions.filter((s) => s.id.startsWith(sessionArg));

	if (localMatches.length >= 1) {
		return { type: "local", path: localMatches[0].path };
	}

	// Try global search across all projects
	const allSessions = await SessionManager.listAll();
	const globalMatches = allSessions.filter((s) => s.id.startsWith(sessionArg));

	if (globalMatches.length >= 1) {
		const match = globalMatches[0];
		return { type: "global", path: match.path, cwd: match.cwd };
	}

	// Not found anywhere
	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

function forkSessionOrExit(
	SessionManager: typeof import("./core/session-manager.ts").SessionManager,
	sourcePath: string,
	cwd: string,
	sessionDir?: string,
): SessionManager {
	try {
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
): Promise<SessionManager> {
	const { SessionManager } = await import("./core/session-manager.ts");
	if (parsed.noSession) {
		return SessionManager.inMemory();
	}

	if (parsed.fork) {
		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(SessionManager, resolved.path, cwd, sessionDir);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return SessionManager.open(resolved.path, sessionDir);

			case "global": {
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(SessionManager, resolved.path, cwd, sessionDir);
			}

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		const { selectSession } = await import("./cli/session-picker.ts");
		await initThemeLazy(settingsManager.getTheme(), true);
		try {
			const selectedPath = await selectSession(
				(onProgress) => SessionManager.list(cwd, sessionDir, onProgress),
				SessionManager.listAll,
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return SessionManager.open(selectedPath, sessionDir);
		} finally {
			await stopThemeWatcherLazy();
		}
	}

	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	return SessionManager.create(cwd, sessionDir);
}

function resolveActiveRole(parsed: Args): ModelRole {
	// Precedence: explicit --role > flag (--smol/--slow/--plan, rightmost wins
	// because the parser overrides the others when it sees a flag) > "default".
	if (parsed.role) return parsed.role;
	return "default";
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
	cwd: string,
	resolveCliModel: typeof import("./core/model-resolver.ts").resolveCliModel,
	resolveRole: typeof import("./core/model-resolver.ts").resolveRole,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
	role: ModelRole;
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;
	const role = resolveActiveRole(parsed);

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			modelRegistry,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	// Try role resolution when no --model was given. A configured role's primary
	// model takes precedence over scopedModels/saved-default fallbacks so that
	// `--smol` etc. predictably switch the active model.
	if (!options.model && !hasExistingSession) {
		const roleSettings = settingsManager.getModelRoleSettings();
		const isRoleConfigured = role !== "default" || roleSettings.modelRoles?.default !== undefined;
		if (isRoleConfigured) {
			const availableModels = modelRegistry.getAll();
			// When `--smol`/`--slow`/`--plan` are given a value (e.g.
			// `--smol claude-sonnet-4-7`), pass it as `cliOverride` so the role's
			// primary model is overridden for this turn only.
			const flagOverride =
				role === "smol" && typeof parsed.smol === "string"
					? parsed.smol
					: role === "slow" && typeof parsed.slow === "string"
						? parsed.slow
						: role === "plan" && typeof parsed.plan === "string"
							? parsed.plan
							: undefined;
			const resolution = resolveRole({
				role,
				cliOverride: flagOverride,
				availableModels,
				settings: roleSettings,
				cwd,
			});
			if (resolution) {
				options.model = resolution.model;
				if (!parsed.thinking) {
					options.thinkingLevel = resolution.thinkingLevel;
				}
			} else if (role !== "default") {
				diagnostics.push({
					type: "warning",
					message: `Role "${role}" is not configured in settings.modelRoles. Falling back to default model selection.`,
				});
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// Tools
	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}

	return { options, cliThinkingFromModel, diagnostics, role };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolve(cwd, value) : value));
}

async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	const [{ ProcessTerminal, setKeybindings, TUI }, { ExtensionSelectorComponent }] = await Promise.all([
		import("@pit/tui"),
		import("./modes/interactive/components/extension-selector.ts"),
	]);
	await initThemeLazy(settingsManager.getTheme());
	const { KeybindingsManager } = await import("./core/keybindings.ts");
	setKeybindings(KeybindingsManager.create());

	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal(), settingsManager.getShowHardwareCursor());
		ui.setClearOnShrink(settingsManager.getClearOnShrink());

		let settled = false;
		const finish = (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			formatMissingSessionCwdPrompt(issue),
			["Continue", "Cancel"],
			(option) => finish(option === "Continue" ? issue.fallbackCwd : undefined),
			() => finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		ui.start();
	});
}

export interface MainOptions {
	extensionFactories?: ExtensionFactory[];
}

export async function main(args: string[], options?: MainOptions) {
	// Absolute mark (ms since process start): together with the "module-eval"
	// milestone in cli.ts this makes the pre-main() cost — node+tsx bootstrap
	// plus main.ts's eager import graph — visible under PIT_TIMING=1.
	markMilestone("main-entry");
	resetTimings();
	// Note: prewarmExtensionLoader exists in core/extensions/loader.ts but is
	// not called here. Measured cost of the pre-warm equals the cost of the
	// first extension load (both compete for the same single-threaded jiti
	// transpile), so awaiting it before extensions provides no net speedup.
	// Kept exported for callers that overlap heavy non-CPU work with startup
	// (e.g. embedded SDK use). See scripts/bench-extension-load.mjs.
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PIT_OFFLINE);
	if (offlineMode) {
		process.env.PIT_OFFLINE = "1";
		process.env.PIT_SKIP_VERSION_CHECK = "1";
	}

	// Fire-and-forget: prune week-old pi-bash-*/pi-output-* logs from tmpdir
	// (Windows never cleans %TEMP%, so they accumulate without bound).
	void sweepStaleTempLogs();

	if (process.platform === "win32") {
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
		// Force UTF-8 console input/output so accented characters (e.g. pt-BR
		// "Verificacao") render correctly instead of cp1252 mojibake.
		ensureWindowsUtf8Console();
	}

	// Argv-gated subcommand dispatch. The gates mirror each handler's own
	// argv[0] check exactly (parsePackageCommand: install/remove/uninstall/
	// update/list; handleConfigCommand: config; handleMcpCommand: mcp), so
	// behavior is identical — but the handler modules are only imported when a
	// subcommand is actually invoked instead of on every boot.
	switch (args[0]) {
		case "install":
		case "remove":
		case "uninstall":
		case "update":
		case "list": {
			const { handlePackageCommand } = await import("./package-manager-cli.ts");
			if (await handlePackageCommand(args)) {
				return;
			}
			break;
		}
		case "config": {
			const { handleConfigCommand } = await import("./package-manager-cli.ts");
			if (await handleConfigCommand(args)) {
				return;
			}
			break;
		}
		case "mcp": {
			const { handleMcpCommand } = await import("./mcp-cli.ts");
			if (await handleMcpCommand(args)) {
				return;
			}
			break;
		}
		default:
			break;
	}

	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	// Built-in extensions read PIT_DRY_RUN to skip any network side-effects
	// (currently: MCP connect). Set it before services/extensions are built.
	if (parsed.dryRun) {
		process.env.PIT_DRY_RUN = "1";
	}
	time("parseArgs");
	let appMode = resolveAppMode(parsed, process.stdin.isTTY);
	const shouldTakeOverStdout = appMode !== "interactive";
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			const { exportFromFile } = await import("./core/export-html/index.ts");
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	validateForkFlags(parsed);

	const agentDir = getAgentDir();

	// --help fast path: print the static help plus extension flags from the disk
	// cache without building the runtime (multi-second → ms). Only for plain
	// invocations (CLI extension overrides change the flag set, so they take the
	// full path). A cache miss falls through to the full path below, which
	// re-renders the help and refreshes the cache; invalidation is automatic via
	// stat + content-hash fingerprints (see core/help-cache.ts). Escape hatch:
	// PIT_NO_HELP_CACHE=1 forces the full path. Subcommand help (install/config/
	// mcp) was already handled by the handlers above.
	const helpCacheEligible = Boolean(parsed.help) && !parsed.extensions?.length && !parsed.noExtensions;
	if (helpCacheEligible) {
		const cachedFlags = readCachedExtensionFlags(process.cwd(), agentDir);
		if (cachedFlags) {
			printHelp(cachedFlags);
			// stderr timings, printed before the early exit so PIT_TIMING covers
			// the --help fast path too (previously unreachable on this path).
			printTimings();
			process.exit(0);
		}
	}

	// Kick off `claude --version` detection now (async spawn + disk cache keyed
	// by the binary's mtime — see core/claude-code-version.ts) so it overlaps
	// with the runtime's module eval instead of blocking boot; awaited after the
	// runtime is built, before anything can issue a model request. Skipped
	// offline and when PIT_CLAUDE_CODE_VERSION is already pinned. The spoofed
	// Claude Code user-agent version keeps Anthropic OAuth routing happy — a
	// stale version draws intermittent OAuth 5xx.
	const claudeCodeVersionReady = offlineMode ? Promise.resolve() : ensureClaudeCodeVersionEnv();

	// Run migrations (pass cwd for project-local migrations)
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(process.cwd());
	time("runMigrations");

	const cwd = process.cwd();
	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	if (parsed.profile === "minimal") {
		startupSettingsManager.applyOverrides({
			eval: { enabled: false },
			lsp: { enabled: false },
			debug: { enabled: false },
			chromeDevtools: { enabled: false },
			hindsight: { enabled: false },
			webSearch: { enabled: false },
			agentMessaging: { enabled: false },
		});
	}
	reportDiagnostics(collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"));

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	const envSessionDir = process.env[ENV_SESSION_DIR];
	const sessionDir =
		parsed.sessionDir ??
		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
		startupSettingsManager.getSessionDir();
	let sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
			if (!selectedCwd) {
				process.exit(0);
			}
			// Module already evaluated by createSessionManager above; this import is a cache hit.
			const { SessionManager } = await import("./core/session-manager.ts");
			sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
		} else {
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	time("createSessionManager");

	const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
	const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
	const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
	const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
	const authStorage = AuthStorage.create();
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		time("createRuntime-start");
		// Lazy-load the heavy harness/SDK graph here: the runtime factory only runs
		// for real modes, never on --version/--export early-exits.
		const [
			{ createAgentSessionFromServices, createAgentSessionServices },
			{ resolveCliModel, resolveModelScope, resolveRole },
		] = await Promise.all([import("./core/agent-session-services.ts"), import("./core/model-resolver.ts")]);
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage,
			// Reuse the SettingsManager already built at startup (same cwd/agentDir)
			// instead of re-reading global+project settings.json a second time.
			settingsManager: startupSettingsManager,
			extensionFlagValues: parsed.unknownFlags,
			permissionModeOverride: parsed.permissionMode,
			resourceLoaderOptions: {
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				noExtensions: parsed.noExtensions,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				noLegacyDiscovery: parsed.noLegacyDiscovery,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories: options?.extensionFactories,
			},
		});
		time("createRuntime-services");
		const { settingsManager, modelRegistry, resourceLoader } = services;
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...services.diagnostics,
			...collectSettingsDiagnostics(settingsManager, "runtime creation"),
			...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
		];

		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		const scopedModels =
			modelPatterns && modelPatterns.length > 0 ? await resolveModelScope(modelPatterns, modelRegistry) : [];
		time("createRuntime-resolveModelScope");
		const {
			options: sessionOptions,
			cliThinkingFromModel,
			diagnostics: sessionOptionDiagnostics,
		} = buildSessionOptions(
			parsed,
			scopedModels,
			sessionManager.buildSessionContext().messages.length > 0,
			modelRegistry,
			settingsManager,
			cwd,
			resolveCliModel,
			resolveRole,
		);
		diagnostics.push(...sessionOptionDiagnostics);

		if (parsed.apiKey) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
			}
		}

		time("createRuntime-buildSessionOptions");
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
			disableHashlineAnchors: parsed.noHashlineAnchors,
			// Adaptive cache retention (§3.1): only the long-lived interactive
			// session pays for long-retention cache writes (2.0× input price);
			// one-shot print/JSON/RPC runs never idle past the 5-minute short TTL,
			// so "short" (1.25×) has an identical hit rate for them. appMode is
			// final here: resolveAppMode already maps piped stdin to "print".
			// PIT_CACHE_RETENTION env still outranks this (provider layer).
			cacheRetention: appMode === "interactive" ? "long" : "short",
		});
		time("createRuntime-createAgentSessionFromServices");
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		return {
			...created,
			services,
			diagnostics,
		};
	};
	time("createRuntime");
	const { createAgentSessionRuntime } = await import("./core/agent-session-runtime.ts");
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});
	const { services, session, modelFallbackMessage } = runtime;
	const { settingsManager, modelRegistry, resourceLoader } = services;

	if (parsed.help) {
		const extensionsResult = resourceLoader.getExtensions();
		const extensionFlags = extensionsResult.extensions.flatMap((extension) => Array.from(extension.flags.values()));
		printHelp(extensionFlags);
		if (helpCacheEligible) {
			// Refresh the fast-path cache with the freshly rendered flags plus the
			// fingerprint of every source that determines them (best-effort).
			writeExtensionFlagsCache({
				cwd: sessionManager.getCwd(),
				agentDir,
				extensionPaths: [
					...extensionsResult.extensions.map((extension) => extension.path),
					...extensionsResult.errors.map((error) => error.path),
				],
				flags: extensionFlags,
			});
		}
		// stderr timings before the early exit so PIT_TIMING covers the full
		// (cache-miss) --help path too (previously unreachable).
		printTimings();
		process.exit(0);
	}

	// Ensure the spoofed Claude Code version resolved (or gave up) before any
	// path that can issue a model request. The detection was kicked off right
	// after arg parsing, so its cost overlapped with runtime creation above —
	// on a version-cache hit this is already settled.
	await claudeCodeVersionReady;

	if (parsed.listModels !== undefined) {
		const { listModels } = await import("./cli/list-models.ts");
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRegistry, searchPattern);
		process.exit(0);
	}

	if (parsed.dryRun) {
		const { buildDryRunReport, formatReportJson, formatReportText } = await import("./cli/dry-run/index.ts");
		const activeToolNames = session.getActiveToolNames();
		const report = buildDryRunReport({
			services,
			resolvedModel: session.model,
			resolvedToolNames: activeToolNames,
		});
		const out = parsed.dryRunFormat === "json" ? formatReportJson(report) : formatReportText(report);
		// Use writeRawStdout so the takeover (which redirects stdout to stderr
		// in non-interactive mode) doesn't redirect the dry-run payload —
		// callers parsing stdout JSON depend on this.
		writeRawStdout(`${out}\n`);
		await flushRawStdout();
		// Timings go to stderr (never the raw-stdout payload callers parse) and
		// print before the early exit so PIT_TIMING covers --dry-run too.
		printTimings();
		await runtime.dispose();
		restoreStdout();
		process.exit(report.overallStatus === "blocked" ? 1 : 0);
	}

	// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
	let stdinContent: string | undefined;
	if (appMode !== "rpc") {
		stdinContent = await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
	}
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		settingsManager.getImageAutoResize(),
		stdinContent,
	);
	time("prepareInitialMessage");
	if (appMode === "interactive") {
		await initThemeLazy(settingsManager.getTheme(), true);
	}
	time("initTheme");

	// Show deprecation warnings in interactive mode
	if (appMode === "interactive" && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	time("resolveModelScope");
	reportDiagnostics(runtime.diagnostics);
	if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
		process.exit(1);
	}
	time("createAgentSession");

	if (appMode !== "interactive" && !session.model) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		process.exit(1);
	}

	const startupBenchmark = isTruthyEnvFlag(process.env.PIT_STARTUP_BENCHMARK);
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red("Error: PIT_STARTUP_BENCHMARK only supports interactive mode"));
		process.exit(1);
	}

	if (appMode === "rpc") {
		const { runRpcMode } = await import("./modes/rpc/rpc-mode.ts");
		printTimings();
		await runRpcMode(runtime);
	} else if (appMode === "interactive") {
		const { InteractiveMode } = await import("./modes/interactive/interactive-mode.ts");
		const interactiveMode = new InteractiveMode(runtime, {
			migratedProviders,
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
		});
		if (startupBenchmark) {
			await interactiveMode.init();
			time("interactiveMode.init");
			printTimings();
			interactiveMode.stop();
			await stopThemeWatcherLazy();
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			return;
		}

		printTimings();
		await interactiveMode.run();
	} else {
		if (!initialMessage && parsed.messages.length === 0) {
			console.error(
				chalk.red(`No prompt provided. Pass a message (${APP_NAME} -p "...") or pipe input (… | ${APP_NAME} -p).`),
			);
			process.exit(1);
		}
		const { runPrintMode } = await import("./modes/print-mode.ts");
		printTimings();
		const exitCode = await runPrintMode(runtime, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		await stopThemeWatcherLazy();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return;
	}
}
