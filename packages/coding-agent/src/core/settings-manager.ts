import { recordDiagnostic, type Transport } from "@pit/ai";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { writeFileAtomicSync } from "../utils/atomic-write.ts";
import { expandTilde } from "../utils/paths.ts";
import type { EngineeringStyle } from "./engineering-styles.ts";
import type { HooksSettings } from "./hooks/types.ts";
import type { McpSettings } from "./mcp/types.ts";
import type { PermissionSettings } from "./permissions/types.ts";

const SETTINGS_LOCK_SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

/**
 * Coerce `raw` to a finite, floored, strictly-positive integer; otherwise
 * return `fallback`. Extracted from the local `positive` helper that
 * `getFrequentFilesSettings` grew so the ~15 scattered numeric coercions
 * across the resolvers can share one implementation.
 */
function posInt(raw: unknown, fallback: number): number {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return fallback;
	return Math.floor(raw);
}

/**
 * Coerce `raw` to a finite, floored, non-negative integer (zero allowed);
 * otherwise return `fallback`. Twin of `posInt` for cooldown-style values
 * where 0 is a legitimate setting.
 */
function nonNegInt(raw: unknown, fallback: number): number {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return fallback;
	return Math.floor(raw);
}

/**
 * Coerce `raw` to a finite, floored integer clamped to [lo, hi]; otherwise
 * return `fallback`. Mirrors the `Math.max(lo, Math.min(hi, Math.floor(raw)))`
 * idiom used by the padding/column setters and getters.
 */
function clampInt(raw: unknown, lo: number, hi: number, fallback: number): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
	return Math.max(lo, Math.min(hi, Math.floor(raw)));
}

/**
 * Return `raw` when it is one of the `allowed` string-literal values; otherwise
 * `fallback`. Mirrors the membership-check idiom in `getTreeFilterMode` so the
 * enum-shaped getters validate against their value set instead of trusting any
 * stored string.
 */
function oneOf<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
	return typeof raw === "string" && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
	selfCorrection?: boolean; // default: true - extra verification LLM pass after summarization
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
	skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface ProviderRetrySettings {
	timeoutMs?: number; // SDK/provider request timeout in milliseconds
	maxRetries?: number; // SDK/provider retry attempts
	maxRetryDelayMs?: number; // default: 60000 (max server-requested delay before failing)
	idleTimeoutMs?: number; // default: 120000 (max body inactivity on raw stream before failing as retryable)
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 5
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s, 16s, capped at 30s)
	provider?: ProviderRetrySettings;
	fallbackChains?: Record<string, string[]>; // per-role fallback model chains (consumed by model-resolver.ts)
	cooldownMs?: number; // default: 300000 — cooldown before retrying a failed model in a fallback chain (agent-session.ts)
}

export interface VerificationSettings {
	enabled?: boolean; // default: true — after a code-modifying turn, run the project check and self-correct on failure
	command?: string | null; // default: null → auto-detect from package.json scripts (check/typecheck/lint/test)
	maxAttempts?: number; // default: 2 — fix attempts before giving up and reporting the failure to the user
	timeoutMs?: number; // default: 180000
	visual?: boolean; // default: true — nudge to `preview` when a rendered artifact changed but was never viewed
}

export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
	imageWidthCells?: number; // default: 60 (preferred inline image width in terminal cells)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
	showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
}

export interface ErrorReflectionSettings {
	enabled?: boolean; // default: false (opt-in)
}

export interface DoomLoopReminderSettings {
	enabled?: boolean; // default: true (opt out with enabled: false)
	threshold?: number; // default: 2 consecutive identical tool calls trigger a reminder
	cooldownMs?: number; // default: 30000 — minimum gap between reminders to prevent spam
}

export interface StagnationReminderSettings {
	enabled?: boolean; // default: true (opt out with enabled: false)
	softThreshold?: number; // default: 12 non-productive turns trigger a reminder
	hardThreshold?: number; // default: 25 non-productive turns pause for user guidance
	cooldownMs?: number; // default: 30000 — minimum gap between soft reminders
}

export interface CrossErrorReminderSettings {
	enabled?: boolean; // default: true (opt out with enabled: false)
	threshold?: number; // default: 3 — same normalised error in a row (across ≥2 approaches) triggers a reminder
	cooldownMs?: number; // default: 30000 — minimum gap between reminders
}

export interface FailureBudgetSettings {
	enabled?: boolean; // default: true (opt out with enabled: false)
	maxPerTurn?: number; // default: 3 — failures of one tool (by name) allowed in a turn before a forceful steer fires
}

export interface TodoCadenceReminderSettings {
	enabled?: boolean; // default: true (opt out with enabled: false)
	threshold?: number; // default: 3 — turns a todo sits in_progress without an update before a sync reminder fires
	cooldownMs?: number; // default: 30000 — minimum gap between reminders
}

export interface ToolFeedbackSettings {
	errorReflection?: ErrorReflectionSettings;
	doomLoopReminder?: DoomLoopReminderSettings;
	stagnationReminder?: StagnationReminderSettings;
	crossErrorReminder?: CrossErrorReminderSettings;
	failureBudget?: FailureBudgetSettings;
	todoCadenceReminder?: TodoCadenceReminderSettings;
}

export interface FrequentFilesSettings {
	enabled?: boolean; // default: true (opt out with enabled: false)
	topN?: number; // default: 10 (entries surfaced in the prompt)
	minHits?: number; // default: 2 (filter out one-touch noise)
	maxFiles?: number; // default: 256 (in-memory tracker cap)
}

/**
 * Time-Traveling Stream Rules (TTSR) configuration.
 *
 * Each rule defines a regex that is matched against the model's streaming
 * output. On the first match the current turn is aborted and a
 * `<system-reminder>` carrying `message` is injected before the model retries
 * the same turn. Off by default; activate by adding rules to settings.json.
 */
export interface TTSRRuleSettings {
	name: string;
	/** Serialized regex source compiled at load time. */
	regex: string;
	message: string;
	/** Stream scope. Defaults to "assistant_text". */
	scope?: "assistant_text" | "tool_args" | "any";
	disabled?: boolean;
}

export interface ResolvedFrequentFilesSettings {
	enabled: boolean;
	topN: number;
	minHits: number;
	maxFiles: number;
}

/**
 * Hindsight memory configuration. When `enabled`, the retain/recall/reflect/forget
 * tools are registered for coding bundles and a per-project bank is opened
 * at session start. The bank lives at `<cwd>/.pit/hindsight/bank.jsonl` by
 * default; override via `bankPath`.
 */
export interface HindsightSettings {
	enabled?: boolean;
	bankPath?: string;
	/** Optional hard ceiling on entry count. Oldest entries evicted on open. */
	maxEntries?: number;
	/** Optional age cap: drop entries older than this many days on open. */
	pruneOlderThanDays?: number;
	scopedSubagents?: boolean;
	scopedSubagentsMaxEntriesPerScope?: number;
}

export interface ResolvedHindsightSettings {
	enabled: boolean;
	bankPath?: string;
	maxEntries?: number;
	pruneOlderThanDays?: number;
	scopedSubagents: boolean;
	scopedSubagentsMaxEntriesPerScope: number;
}

/**
 * Hidden tool discovery configuration. When `enabled`, the agent boot path may
 * seed the hidden tool index so the `search_tool_bm25` tool can BM25-search
 * specialized tools that are NOT in the default active surface. The
 * `search_tool_bm25` tool itself is always registered; these settings only
 * gate seeding + which tools live where.
 */
export interface ToolDiscoverySettings {
	enabled?: boolean;
	alwaysActive?: string[];
	hiddenByDefault?: string[];
}

export interface ResolvedToolDiscoverySettings {
	enabled: boolean;
	alwaysActive: string[];
	hiddenByDefault: string[];
}

/**
 * Web search tool configuration. On by default; opt out via
 * `webSearch.enabled: false`. `defaultProvider` controls the chain entry point
 * ("auto" walks the configured chain). `providers.<name>.apiKey` is an
 * optional per-provider key override surfaced to the tool via env mirroring.
 */
export interface WebSearchSettings {
	enabled?: boolean;
	defaultProvider?: string;
	providers?: Record<string, { apiKey?: string }>;
}

export interface ResolvedWebSearchSettings {
	enabled: boolean;
	defaultProvider: string;
	providers: Record<string, { apiKey?: string }>;
}

/**
 * Eval tool configuration. On by default; opt out via `eval.enabled: false`.
 * When enabled, the `eval` tool is registered for coding bundles and the
 * session boots a persistent Python + JS kernel manager (one of each kernel
 * spawned lazily on first use).
 */
export interface EvalSettings {
	enabled?: boolean;
}

export interface ResolvedEvalSettings {
	enabled: boolean;
}

export interface LspSettings {
	enabled?: boolean;
	/** Attach LSP diagnostics to write/edit results (writethrough). Default ON. */
	diagnosticsOnWrite?: boolean;
	/** Format files via LSP before writing them. Default OFF. */
	formatOnWrite?: boolean;
}

export interface ResolvedLspSettings {
	enabled: boolean;
	diagnosticsOnWrite: boolean;
	formatOnWrite: boolean;
}

export interface PanelMemberSetting {
	cli: "codex" | "claude";
	model: string;
}

export interface FusionSettings {
	/** Exactly two members; each binds a CLI to a model id. */
	panel?: PanelMemberSetting[];
	/** Per-member HARD wall-clock cap (ms) — backstop against a member that streams
	 * forever. A working member is bounded by `idleTimeoutMs`, not by this. */
	timeoutMs?: number;
	/** Idle cap (ms): kill a member only after this long with NO output (stuck). Reset
	 * on every chunk, so an actively-working member is never killed for taking long. */
	idleTimeoutMs?: number;
	/** Delay before launching a second member on the same CLI (ms). */
	staggerSameCliMs?: number;
	/** Surface the judge's structured analysis inline. */
	showSynthesis?: boolean;
	/** Run panel CLIs lean (skip user hooks/skills/MCP). Default true. */
	lean?: boolean;
	/** Run the synthesizer brief pre-pass (rewrite the prompt before advisors). Default true. */
	brief?: boolean;
	/** Run the read-only verify pass (fact-check advisor claims against the code) before the
	 * writer synthesizes. Default true. */
	verify?: boolean;
	/** Wall-clock cap (ms) for the verify subagent. */
	verifyTimeoutMs?: number;
}

export interface ResolvedFusionSettings {
	panel: PanelMemberSetting[];
	timeoutMs: number;
	idleTimeoutMs: number;
	staggerSameCliMs: number;
	showSynthesis: boolean;
	lean: boolean;
	brief: boolean;
	verify: boolean;
	verifyTimeoutMs: number;
}

export interface DebugSettings {
	enabled?: boolean;
}

export interface ResolvedDebugSettings {
	enabled: boolean;
}

export interface AgentMessagingSettings {
	enabled?: boolean;
	/** Per-message reply timeout in ms. Default 120000. 0 disables the timeout. */
	timeoutMs?: number;
}

export interface ResolvedAgentMessagingSettings {
	enabled: boolean;
	timeoutMs: number;
}

export interface ChromeDevtoolsSettings {
	enabled?: boolean;
	debugPort?: number;
	host?: string;
	launchBrowser?: boolean;
	binaryPath?: string;
}

export interface ResolvedChromeDevtoolsSettings {
	enabled: boolean;
	debugPort: number;
	host: string;
	launchBrowser: boolean;
	binaryPath?: string;
	userDataDir: string;
}

export interface ResolvedToolFeedbackSettings {
	errorReflection: { enabled: boolean };
	doomLoopReminder: { enabled: boolean; threshold: number; cooldownMs: number };
	stagnationReminder: { enabled: boolean; softThreshold: number; hardThreshold: number; cooldownMs: number };
	crossErrorReminder: { enabled: boolean; threshold: number; cooldownMs: number };
	failureBudget: { enabled: boolean; maxPerTurn: number };
	todoCadenceReminder: { enabled: boolean; threshold: number; cooldownMs: number };
}

export interface WarningSettings {
	anthropicExtraUsage?: boolean; // default: true
	/** Show "new version available" banner at startup. Default: false (opt-in). */
	newVersion?: boolean;
	/** Show "package updates available" banner at startup. Default: false (opt-in). */
	packageUpdates?: boolean;
}

export type TransportSetting = Transport;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 */
export type PackageSource =
	| string
	| {
			source: string;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

export interface Settings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	transport?: TransportSetting; // default: "auto"
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	verification?: VerificationSettings;
	hideThinkingBlock?: boolean;
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
	quietStartup?: boolean;
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths or directories
	skills?: string[]; // Array of local skill file paths or directories
	prompts?: string[]; // Array of local prompt template paths or directories
	themes?: string[]; // Array of local theme file paths or directories
	enableSkillCommands?: boolean; // default: true - register skills as /name commands
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	assistantReadingColumns?: number; // Reading-column cap (cols) for assistant prose; 0 = full width (default: 0)
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	cursorBlink?: boolean; // Blink the input editor's block cursor while focused (default: true)
	streamingSmoothing?: boolean; // Reveal streamed assistant text at a steady rate instead of in provider-sized bursts (default: true)
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
	permissions?: PermissionSettings;
	hooks?: HooksSettings;
	mcp?: McpSettings;
	memory?: MemorySettings;
	toolFeedback?: ToolFeedbackSettings;
	/**
	 * Engineering style pack appended to the system prompt's `Guidelines:`
	 * section. "default" is a no-op; "karpathy" applies the Karpathy LLM-coding
	 * guideline bullets (assumptions, simplicity, surgical edits, goal-driven
	 * execution). Default: "karpathy".
	 */
	engineeringStyle?: EngineeringStyle;
	frequentFiles?: FrequentFilesSettings;
	/**
	 * Model role configuration (default/smol/slow/plan/commit). See
	 * ModelRoleSettings for shape — kept as a separate interface so the role
	 * resolver in model-resolver.ts can consume the settings slice without
	 * importing the whole Settings surface.
	 */
	modelRoles?: ModelRoleSettings["modelRoles"];
	/** Time-Traveling Stream Rules. Off by default; populate to activate. */
	ttsrRules?: TTSRRuleSettings[];
	/** Per-project hindsight memory bank. On by default; opt out with `hindsight.enabled: false`. */
	hindsight?: HindsightSettings;
	/**
	 * Hidden tool discovery index. On by default; hidden tools can be surfaced
	 * on-demand via the `search_tool_bm25` tool. Opt out with `toolDiscovery.enabled: false`.
	 */
	toolDiscovery?: ToolDiscoverySettings;
	/**
	 * Web search tool. On by default; the `web_search` tool is registered for
	 * coding bundles and routes through the configured provider chain
	 * (env-key gated). Opt out with `webSearch.enabled: false`.
	 */
	webSearch?: WebSearchSettings;
	/**
	 * Eval tool. On by default; registers the `eval` tool and starts a
	 * per-session persistent Python + JS kernel manager (spawned lazily on
	 * first use). Opt out with `eval.enabled: false`.
	 */
	eval?: EvalSettings;
	lsp?: LspSettings;
	debug?: DebugSettings;
	fusion?: FusionSettings;
	agentMessaging?: AgentMessagingSettings;
	chromeDevtools?: ChromeDevtoolsSettings;
	/** Interactive TUI tool rendering: "grouped" (default) groups consecutive
	 * tool calls into activity lines; "legacy" keeps one stacked block per call. */
	toolActivity?: "grouped" | "legacy";
	/** Autonomous goal-continuation behavior. */
	goal?: GoalSettings;
}

export interface GoalSettings {
	/**
	 * Safety cap on autonomous goal continuations spawned from a single user
	 * prompt. Hitting it pauses the goal so the user can resume. Default: 50.
	 */
	maxAutoIterations?: number;
}

export interface MemorySettings {
	/** Disable injecting MEMORY.md into the system prompt (the memory_append tool still works). */
	disableInjection?: boolean;
}

/**
 * Model-role configuration. A role maps an intent ("smol fan-out", "deep
 * reasoning") to a concrete model pattern plus optional fallback chain and
 * path-scoped overrides. Resolved by `resolveRole()` in model-resolver.ts.
 */
export interface ModelRoleConfig {
	/** Primary model pattern, e.g. "anthropic/claude-opus-4-7" or "sonnet:high". */
	model: string;
	/** Optional default thinking level for this role. */
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	/** Per-path overrides — glob keys matched against cwd; closest match wins. */
	paths?: Record<string, string>;
	/** Inline fallback chain (used when `retry.fallbackChains[role]` is absent). */
	fallbackChain?: string[];
}

export interface ModelRoleSettings {
	modelRoles?: {
		default?: ModelRoleConfig;
		smol?: ModelRoleConfig;
		slow?: ModelRoleConfig;
		plan?: ModelRoleConfig;
		commit?: ModelRoleConfig;
	};
	retry?: Pick<RetrySettings, "fallbackChains" | "cooldownMs">;
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const result: Settings = { ...base };

	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key];
		const baseValue = base[key];

		if (overrideValue === undefined) {
			continue;
		}

		// For nested objects, merge recursively
		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			(result as Record<string, unknown>)[key] = { ...baseValue, ...overrideValue };
		} else {
			// For primitives and arrays, override value wins
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}

export type SettingsScope = "global" | "project";

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

export interface SettingsError {
	scope: SettingsScope;
	error: Error;
}

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string, agentDir: string) {
		this.globalSettingsPath = join(agentDir, "settings.json");
		this.projectSettingsPath = join(cwd, CONFIG_DIR_NAME, "settings.json");
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				// Sleep synchronously without burning CPU; Atomics.wait yields the thread.
				Atomics.wait(SETTINGS_LOCK_SLEEP_BUF, 0, 0, delayMs);
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// Only create directory and lock if file exists or we need to write
			const fileExists = existsSync(path);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(path);
			}
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) {
				// Only create directory when we actually need to write
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					release = this.acquireLockSyncWithRetry(path);
				}
				// Atomic: a crash/kill during this write must not truncate settings.json
				// (a torn file fails JSON.parse on next boot and silently resets ALL settings).
				writeFileAtomicSync(path, next);
			}
		} finally {
			if (release) {
				release();
			}
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}
}

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings!: Settings; // assigned via recomputeSettings() in the constructor
	// Programmatic overrides applied via applyOverrides(). Kept as their own layer
	// (highest precedence) and re-applied on every recompute of `this.settings` so a
	// subsequent save()/reload()/saveProjectSettings() can't silently discard them.
	private sessionOverrides: Partial<Settings> = {};
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.recomputeSettings();
	}

	/**
	 * Recompute the effective `this.settings` from the layered sources in
	 * precedence order: global < project < sessionOverrides. Every site that
	 * rebuilds `this.settings` (constructor / reload / save / saveProjectSettings)
	 * MUST go through here so programmatic overrides applied via applyOverrides()
	 * are re-applied and never silently dropped by a later recompute.
	 */
	private recomputeSettings(): void {
		const merged = deepMergeSettings(this.globalSettings, this.projectSettings);
		this.settings = deepMergeSettings(merged, this.sessionOverrides as Settings);
	}

	/** Create a SettingsManager that loads from files */
	static create(cwd: string, agentDir: string = getAgentDir()): SettingsManager {
		const storage = new FileSettingsStorage(cwd, agentDir);
		return SettingsManager.fromStorage(storage);
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage): SettingsManager {
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project");
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push({ scope: "global", error: globalLoad.error });
		}
		if (projectLoad.error) {
			initialErrors.push({ scope: "project", error: projectLoad.error });
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage);
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope): Settings {
		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings = JSON.parse(content);
		return SettingsManager.migrateSettings(settings);
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// Migrate queueMode -> steeringMode
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		// Migrate legacy websockets boolean -> transport enum
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		// Migrate old skills object format to new array format
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		// Migrate retry.maxDelayMs -> retry.provider.maxRetryDelayMs
		if (
			"retry" in settings &&
			typeof settings.retry === "object" &&
			settings.retry !== null &&
			!Array.isArray(settings.retry)
		) {
			const retrySettings = settings.retry as Record<string, unknown>;
			const providerSettings =
				typeof retrySettings.provider === "object" && retrySettings.provider !== null
					? (retrySettings.provider as Record<string, unknown>)
					: undefined;
			if (
				typeof retrySettings.maxDelayMs === "number" &&
				(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
			) {
				retrySettings.provider = {
					...(providerSettings ?? {}),
					maxRetryDelayMs: retrySettings.maxDelayMs,
				};
			}
			delete retrySettings.maxDelayMs;
		}

		return settings as Settings;
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project");
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		this.recomputeSettings();
	}

	/**
	 * Apply additional programmatic overrides on top of the current settings.
	 * Overrides are stored in their own layer (highest precedence) and re-applied
	 * on every recompute, so a later save()/reload()/saveProjectSettings() can no
	 * longer silently discard them. Repeated calls accumulate (deep-merged).
	 */
	applyOverrides(overrides: Partial<Settings>): void {
		this.sessionOverrides = deepMergeSettings(this.sessionOverrides as Settings, overrides as Settings);
		this.recomputeSettings();
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/**
	 * Set a top-level global field, mark it modified, and persist. Collapses the
	 * identical 3-line body shared by every scalar top-level setter so the field
	 * key is named exactly once (the old setters repeated it in both the
	 * assignment and the markModified string, risking silent divergence).
	 */
	private setTopLevel<K extends keyof Settings>(key: K, value: Settings[K]): void {
		this.globalSettings[key] = value;
		this.markModified(key);
		this.save();
	}

	/**
	 * Set a nested global field under a section, lazy-initializing the parent
	 * object, marking the section+key modified, and persisting. Twin of
	 * `setTopLevel` that collapses the identical 4-line body shared by every
	 * nested scalar setter (compaction/retry/terminal/images), so each section
	 * key is named once instead of in both the assignment and the markModified
	 * string.
	 */
	private setNested<P extends keyof Settings, V>(parent: P, key: string, value: V): void {
		const section = (this.globalSettings[parent] ?? {}) as Record<string, unknown>;
		section[key] = value;
		this.globalSettings[parent] = section as Settings[P];
		this.markModified(parent, key);
		this.save();
	}

	/**
	 * Set a top-level project field on a cloned project-settings snapshot, mark
	 * it modified, and persist. Collapses the identical 4-line body shared by
	 * every `setProjectXPaths` setter so the field key is named exactly once.
	 */
	private setProjectField<K extends keyof Settings>(field: K, value: Settings[K]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings[field] = value;
		this.markProjectModified(field);
		this.saveProjectSettings(projectSettings);
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push({ scope, error: normalizedError });
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});

		// withLock is synchronous and writeFileAtomicSync throws on failure; reaching
		// this point means the atomic write succeeded and the file is integral again.
		// Clear any prior transient load error (EBUSY/EACCES from AV, torn file) so that
		// subsequent save()/saveProjectSettings() are no longer suppressed for the rest
		// of the session.
		if (scope === "global") {
			this.globalSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = null;
		}
	}

	private save(): void {
		this.recomputeSettings();

		if (this.globalSettingsLoadError) {
			// A prior transient load error (EBUSY/EACCES from AV, torn file) is suppressing
			// writes to avoid clobbering on-disk settings with possibly-incomplete in-memory
			// state. Surface it so the suppression is not silent for the rest of the session.
			recordDiagnostic({
				category: "error.isolated",
				level: "warn",
				source: "settings-manager.save",
				context: {
					note: `global settings save suppressed by prior load error: ${this.globalSettingsLoadError.message}`,
				},
			});
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.projectSettings = structuredClone(settings);
		this.recomputeSettings();

		if (this.projectSettingsLoadError) {
			recordDiagnostic({
				category: "error.isolated",
				level: "warn",
				source: "settings-manager.save",
				context: {
					note: `project settings save suppressed by prior load error: ${this.projectSettingsLoadError.message}`,
				},
			});
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		if (!sessionDir) {
			return sessionDir;
		}
		return expandTilde(sessionDir);
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.setTopLevel("defaultProvider", provider);
	}

	setDefaultModel(modelId: string): void {
		this.setTopLevel("defaultModel", modelId);
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.setTopLevel("steeringMode", mode);
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.setTopLevel("followUpMode", mode);
	}

	getTheme(): string | undefined {
		return this.settings.theme;
	}

	setTheme(theme: string): void {
		this.setTopLevel("theme", theme);
	}

	getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): void {
		this.setTopLevel("defaultThinkingLevel", level);
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "auto";
	}

	setTransport(transport: TransportSetting): void {
		this.setTopLevel("transport", transport);
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.setNested("compaction", "enabled", enabled);
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? 16384;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? 20000;
	}

	getCompactionSettings(): {
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
		selfCorrection: boolean;
	} {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
			// Wire the selfCorrection knob through so settings.json can disable the
			// extra verification LLM pass. Default true preserves prior behavior.
			selfCorrection: this.settings.compaction?.selfCorrection ?? true,
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	/**
	 * Resolve frequent-files settings with sensible defaults. Disabled by default;
	 * opt-in via settings.json.
	 */
	getFrequentFilesSettings(): ResolvedFrequentFilesSettings {
		const ff = this.settings.frequentFiles;
		return {
			// Default ON: anchors the model to recently-touched files, cutting redundant
			// searches/reads. Section is only emitted when there are entries clearing
			// `minHits`, so the prompt cost stays zero in fresh sessions. Opt out by
			// setting `frequentFiles.enabled: false` in settings.json.
			enabled: ff?.enabled !== false,
			topN: posInt(ff?.topN, 10),
			minHits: nonNegInt(ff?.minHits, 2),
			maxFiles: posInt(ff?.maxFiles, 256),
		};
	}

	/**
	 * Resolve the configured engineering style pack. Defaults to "karpathy";
	 * only an explicit "default" disables it. Unknown values fall back to
	 * "karpathy" so user typos never silently disable the style pack.
	 */
	getEngineeringStyle(): EngineeringStyle {
		const raw = this.settings.engineeringStyle;
		if (raw === "default") return "default";
		return "karpathy";
	}

	/**
	 * Resolve tool-feedback settings.
	 * - errorReflection: OFF by default. It injected a hidden reflection prompt
	 *   after a tool error, but delivered it as a `followUp` — a separate turn
	 *   that runs *after* the current one. Modern models already read the error
	 *   tool-result inline and self-correct within the same turn, so the
	 *   follow-up lands stale and burns a phantom turn ("this is a stale
	 *   reflection for a call I already fixed") that leaks into the user-facing
	 *   reply. The useful inline feedback is already delivered behind the scenes
	 *   by the raw tool-result and the Tier-4 hint rules (tool-error-hint-rules).
	 *   Opt in with `toolFeedback.errorReflection.enabled: true`.
	 * - doomLoopReminder: ON by default. Injects a reminder (and at higher tiers
	 *   pauses/aborts) when consecutive identical tool calls reach the threshold.
	 *   Bounded by `cooldownMs` so it never spams. Opt out with
	 *   `toolFeedback.doomLoopReminder.enabled: false`.
	 * - failureBudget: ON by default. A per-turn, per-tool-NAME failure budget
	 *   (complements doom-loop = same identical call, and cross-error = same error
	 *   across approaches). Once one tool fails `maxPerTurn` times in a single
	 *   turn — regardless of args or error text — a forceful steer fires telling
	 *   the model to stop hammering that tool and change approach. Opt out with
	 *   `toolFeedback.failureBudget.enabled: false`.
	 */
	getToolFeedbackSettings(): ResolvedToolFeedbackSettings {
		const tf = this.settings.toolFeedback;
		const threshold = posInt(tf?.doomLoopReminder?.threshold, 2);
		const cooldownMs = nonNegInt(tf?.doomLoopReminder?.cooldownMs, 30000);
		const sr = tf?.stagnationReminder;
		const softThreshold = posInt(sr?.softThreshold, 12);
		const hardCandidate = posInt(sr?.hardThreshold, 25);
		// Hard ceiling must sit at or above the soft floor; otherwise the pause
		// would pre-empt the reminder and the soft tier could never fire.
		const hardThreshold = Math.max(hardCandidate, softThreshold);
		const stagnationCooldownMs = nonNegInt(sr?.cooldownMs, 30000);
		const ce = tf?.crossErrorReminder;
		const ceThreshold = posInt(ce?.threshold, 3);
		const ceCooldownMs = nonNegInt(ce?.cooldownMs, 30000);
		const fb = tf?.failureBudget;
		const fbMaxPerTurn = posInt(fb?.maxPerTurn, 3);
		const tc = tf?.todoCadenceReminder;
		const tcThreshold = posInt(tc?.threshold, 3);
		const tcCooldownMs = nonNegInt(tc?.cooldownMs, 30000);
		return {
			errorReflection: { enabled: tf?.errorReflection?.enabled === true },
			doomLoopReminder: {
				enabled: tf?.doomLoopReminder?.enabled !== false,
				threshold,
				cooldownMs,
			},
			stagnationReminder: {
				enabled: sr?.enabled !== false,
				softThreshold,
				hardThreshold,
				cooldownMs: stagnationCooldownMs,
			},
			crossErrorReminder: {
				enabled: ce?.enabled !== false,
				threshold: ceThreshold,
				cooldownMs: ceCooldownMs,
			},
			failureBudget: {
				enabled: fb?.enabled !== false,
				maxPerTurn: fbMaxPerTurn,
			},
			todoCadenceReminder: {
				enabled: tc?.enabled !== false,
				threshold: tcThreshold,
				cooldownMs: tcCooldownMs,
			},
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.getBranchSummarySettings().skipPrompt;
	}

	/**
	 * Safety cap on autonomous goal continuations from a single prompt. Defaults
	 * to 50; coerced to a strictly-positive integer so a bad value can't disable
	 * the backstop.
	 */
	getGoalMaxAutoIterations(): number {
		return posInt(this.settings.goal?.maxAutoIterations, 50);
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		this.setNested("retry", "enabled", enabled);
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 5,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
		};
	}

	getVerificationSettings(): {
		enabled: boolean;
		command: string | null;
		maxAttempts: number;
		timeoutMs: number;
		visual: boolean;
	} {
		const v = this.settings.verification;
		return {
			enabled: v?.enabled ?? true,
			command: v?.command ?? null,
			maxAttempts: Math.max(1, v?.maxAttempts ?? 2),
			timeoutMs: Math.max(1000, v?.timeoutMs ?? 180_000),
			visual: v?.visual ?? true,
		};
	}

	getProviderRetrySettings(): {
		timeoutMs?: number;
		maxRetries?: number;
		maxRetryDelayMs: number;
		idleTimeoutMs?: number;
	} {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
			idleTimeoutMs: this.settings.retry?.provider?.idleTimeoutMs,
		};
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.setTopLevel("hideThinkingBlock", hide);
	}

	getShellPath(): string | undefined {
		return this.settings.shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.setTopLevel("shellPath", path);
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.setTopLevel("quietStartup", quiet);
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.setTopLevel("shellCommandPrefix", prefix);
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.setTopLevel("packages", packages);
	}

	setProjectPackages(packages: PackageSource[]): void {
		this.setProjectField("packages", packages);
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.setTopLevel("extensions", paths);
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.setProjectField("extensions", paths);
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.setTopLevel("skills", paths);
	}

	setProjectSkillPaths(paths: string[]): void {
		this.setProjectField("skills", paths);
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.setTopLevel("prompts", paths);
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.setProjectField("prompts", paths);
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.setTopLevel("themes", paths);
	}

	setProjectThemePaths(paths: string[]): void {
		this.setProjectField("themes", paths);
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.setTopLevel("enableSkillCommands", enabled);
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		this.setNested("terminal", "showImages", show);
	}

	getImageWidthCells(): number {
		return clampInt(this.settings.terminal?.imageWidthCells, 1, 400, 60);
	}

	setImageWidthCells(width: number): void {
		this.setNested("terminal", "imageWidthCells", Math.max(1, Math.min(400, Math.floor(width))));
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.PIT_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		this.setNested("terminal", "clearOnShrink", enabled);
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? false;
	}

	setShowTerminalProgress(enabled: boolean): void {
		this.setNested("terminal", "showTerminalProgress", enabled);
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		this.setNested("images", "autoResize", enabled);
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): void {
		this.setNested("images", "blockImages", blocked);
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.setTopLevel("enabledModels", patterns);
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return oneOf(this.settings.doubleEscapeAction, ["fork", "tree", "none"] as const, "tree");
	}

	getToolActivity(): "grouped" | "legacy" {
		return oneOf(this.settings.toolActivity, ["grouped", "legacy"] as const, "grouped");
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.setTopLevel("doubleEscapeAction", action);
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		return oneOf(
			this.settings.treeFilterMode,
			["default", "no-tools", "user-only", "labeled-only", "all"] as const,
			"default",
		);
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.setTopLevel("treeFilterMode", mode);
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.PIT_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.setTopLevel("showHardwareCursor", enabled);
	}

	getCursorBlink(): boolean {
		return this.settings.cursorBlink ?? true;
	}

	setCursorBlink(enabled: boolean): void {
		this.setTopLevel("cursorBlink", enabled);
	}

	getStreamingSmoothing(): boolean {
		return this.settings.streamingSmoothing ?? true;
	}

	setStreamingSmoothing(enabled: boolean): void {
		this.setTopLevel("streamingSmoothing", enabled);
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.markModified("editorPaddingX");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.markModified("autocompleteMaxVisible");
		this.save();
	}

	/**
	 * Reading-column cap (cols) for assistant prose. `0` (the default) disables the
	 * cap: prose uses the full terminal width and reflows on resize, like Claude
	 * Code, instead of leaving a wide window half-empty. A positive value re-enables
	 * a fixed reading measure for long answers, clamped to a sane band so a typo
	 * can't make prose unreadable; tool output / bash / code blocks are never capped.
	 */
	getAssistantReadingColumns(): number {
		const raw = this.settings.assistantReadingColumns;
		// Unset / 0 / non-positive = full width (no cap); else clamp to a readable band.
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
		return clampInt(raw, 40, 200, 0);
	}

	setAssistantReadingColumns(columns: number): void {
		// <= 0 disables the cap (full width); otherwise clamp to the readable band.
		this.globalSettings.assistantReadingColumns = columns <= 0 ? 0 : Math.max(40, Math.min(200, Math.floor(columns)));
		this.markModified("assistantReadingColumns");
		this.save();
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}

	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): void {
		this.globalSettings.warnings = { ...warnings };
		this.markModified("warnings");
		this.save();
	}

	getPermissionSettings(): PermissionSettings {
		return { ...(this.settings.permissions ?? {}) };
	}

	getHooksSettings(): HooksSettings {
		return { ...(this.settings.hooks ?? {}) };
	}

	getMcpSettings(): McpSettings {
		return { ...(this.settings.mcp ?? {}) };
	}

	/**
	 * Expose the global (user) and project layers of MCP settings separately so the
	 * session can interleave the versioned `.mcp.json` (project, shared) and
	 * `.mcp.local.json` (local, gitignored) files at the right precedence — which
	 * the already-merged `getMcpSettings()` view cannot reconstruct.
	 */
	getMcpSettingsLayered(): { global: McpSettings; project: McpSettings } {
		return {
			global: { ...(this.globalSettings.mcp ?? {}) },
			project: { ...(this.projectSettings.mcp ?? {}) },
		};
	}

	getMemorySettings(): MemorySettings {
		return { ...(this.settings.memory ?? {}) };
	}

	/**
	 * Return configured Time-Traveling Stream Rules. Returns a defensive copy so
	 * callers cannot mutate the in-memory settings. Off by default — when no
	 * rules are configured, an empty array is returned and the TTSR matcher is
	 * skipped entirely by the loop wiring.
	 */
	getTTSRRules(): TTSRRuleSettings[] {
		const rules = this.settings.ttsrRules;
		if (!Array.isArray(rules)) return [];
		return rules.map((rule) => ({ ...rule }));
	}

	/**
	 * Persist a full TTSR rule list to the global scope. Used by interactive
	 * mode's `/ttsr enable|disable` commands to toggle the `disabled` flag.
	 */
	setTTSRRules(rules: TTSRRuleSettings[]): void {
		this.globalSettings.ttsrRules = rules.map((rule) => ({ ...rule }));
		this.markModified("ttsrRules");
		this.save();
	}

	/**
	 * Return the model-role settings slice (roles + retry config). Used by
	 * resolveRole() to pick a primary model and assemble a fallback chain.
	 * Surgical getter — kept separate from other sections so parallel agents
	 * adding `hindsight`/`ttsr` blocks can merge cleanly.
	 */
	getModelRoleSettings(): ModelRoleSettings {
		return {
			modelRoles: this.settings.modelRoles ? structuredClone(this.settings.modelRoles) : undefined,
			retry: this.settings.retry
				? {
						fallbackChains: this.settings.retry.fallbackChains,
						cooldownMs: this.settings.retry.cooldownMs,
					}
				: undefined,
		};
	}

	/**
	 * Resolve hindsight memory settings. Enabled by default; opt out via
	 * `hindsight.enabled: false` in settings.json (project or global). When
	 * disabled, the retain/recall/reflect/forget tools are not registered and no
	 * bank is opened.
	 */
	getHindsightSettings(): ResolvedHindsightSettings {
		const raw = this.settings.hindsight;
		const maxEntries =
			typeof raw?.maxEntries === "number" && Number.isFinite(raw.maxEntries) && raw.maxEntries > 0
				? Math.floor(raw.maxEntries)
				: undefined;
		const pruneOlderThanDays =
			typeof raw?.pruneOlderThanDays === "number" &&
			Number.isFinite(raw.pruneOlderThanDays) &&
			raw.pruneOlderThanDays > 0
				? raw.pruneOlderThanDays
				: undefined;
		const scopedSubagentsMaxEntriesPerScope =
			typeof raw?.scopedSubagentsMaxEntriesPerScope === "number" &&
			Number.isFinite(raw.scopedSubagentsMaxEntriesPerScope) &&
			raw.scopedSubagentsMaxEntriesPerScope > 0
				? Math.floor(raw.scopedSubagentsMaxEntriesPerScope)
				: 200;
		// Default ON: retain/recall/reflect/forget ride out-of-the-box with a per-project
		// bank under `<cwd>/.pit/hindsight/bank.jsonl`. Opt out via
		// `hindsight.enabled: false` in settings.json.
		return {
			enabled: raw?.enabled !== false,
			bankPath: typeof raw?.bankPath === "string" && raw.bankPath.length > 0 ? raw.bankPath : undefined,
			maxEntries,
			pruneOlderThanDays,
			scopedSubagents: raw?.scopedSubagents !== false,
			scopedSubagentsMaxEntriesPerScope,
		};
	}

	/**
	 * Resolve hidden tool discovery settings. The `search_tool_bm25` tool is
	 * always registered; these settings only gate auto-seeding of the hidden
	 * index at session boot and let callers declare which tools should be in
	 * the active surface vs. hidden by default.
	 */
	getToolDiscoverySettings(): ResolvedToolDiscoverySettings {
		const raw = this.settings.toolDiscovery;
		return {
			enabled: raw?.enabled !== false,
			alwaysActive: Array.isArray(raw?.alwaysActive) ? [...raw.alwaysActive] : [],
			hiddenByDefault: Array.isArray(raw?.hiddenByDefault) ? [...raw.hiddenByDefault] : [],
		};
	}

	/**
	 * Resolve eval settings. Enabled by default; opt out via `eval.enabled: false`.
	 */
	getEvalSettings(): ResolvedEvalSettings {
		const raw = this.settings.eval;
		// Default ON: the eval tool is registered and a persistent Python + JS
		// kernel manager is spawned lazily on first use. Opt out via
		// `eval.enabled: false` in settings.json.
		return { enabled: raw?.enabled !== false };
	}

	/**
	 * Resolve LSP settings. Default ON: the `lsp` tool joins the active surface
	 * and language servers cold-start on first use (or warm up at session start).
	 * Opt out via `lsp.enabled: false` in settings.json.
	 */
	getLspSettings(): ResolvedLspSettings {
		const raw = this.settings.lsp;
		return {
			enabled: raw?.enabled !== false,
			// Default ON: post-write diagnostics are attached to write/edit results.
			diagnosticsOnWrite: raw?.diagnosticsOnWrite !== false,
			// Default OFF: opt in to rewrite files through the language server's formatter.
			formatOnWrite: raw?.formatOnWrite === true,
		};
	}

	/**
	 * Resolve Fusion-mode settings. The panel binds up to two CLI/model members;
	 * timeout/stagger/showSynthesis fall back to defaults when absent or invalid.
	 */
	getFusionSettings(): ResolvedFusionSettings {
		const raw = this.settings.fusion;
		const panel = Array.isArray(raw?.panel) ? raw.panel.slice(0, 2) : [];
		const timeoutMs = typeof raw?.timeoutMs === "number" && raw.timeoutMs > 0 ? raw.timeoutMs : 600_000;
		const idleTimeoutMs =
			typeof raw?.idleTimeoutMs === "number" && raw.idleTimeoutMs > 0 ? raw.idleTimeoutMs : 90_000;
		const stagger =
			typeof raw?.staggerSameCliMs === "number" && raw.staggerSameCliMs >= 0 ? raw.staggerSameCliMs : 400;
		const verifyTimeoutMs =
			typeof raw?.verifyTimeoutMs === "number" && raw.verifyTimeoutMs > 0 ? raw.verifyTimeoutMs : 120_000;
		return {
			panel,
			timeoutMs,
			idleTimeoutMs,
			staggerSameCliMs: stagger,
			showSynthesis: raw?.showSynthesis === true,
			lean: raw?.lean !== false,
			brief: raw?.brief !== false,
			verify: raw?.verify !== false,
			verifyTimeoutMs,
		};
	}

	setFusionPanel(panel: PanelMemberSetting[]): void {
		this.setTopLevel("fusion", { ...this.globalSettings.fusion, panel: panel.slice(0, 2) });
	}

	/**
	 * Resolve debug settings. Default ON: the `debug` tool joins the active
	 * surface so the agent can drive a DAP debugger when it needs live program
	 * state. Adapters cold-start on first use. Opt out via `debug.enabled: false`.
	 */
	getDebugSettings(): ResolvedDebugSettings {
		const raw = this.settings.debug;
		return { enabled: raw?.enabled !== false };
	}

	/**
	 * Resolve agent messaging settings. Default ON: the `message` tool joins the
	 * active surface so sub-agents can send typed messages to their parent.
	 * Opt out via `agentMessaging.enabled: false` in settings.json.
	 */
	getAgentMessagingSettings(): ResolvedAgentMessagingSettings {
		const raw = this.settings.agentMessaging;
		return {
			enabled: raw?.enabled !== false,
			timeoutMs: typeof raw?.timeoutMs === "number" ? raw.timeoutMs : 120_000,
		};
	}

	getChromeDevtoolsSettings(): ResolvedChromeDevtoolsSettings {
		const raw = this.settings.chromeDevtools;
		// Default ON: the chrome_devtools_* tools are registered. They connect to a
		// Chrome started with --remote-debugging-port and fail with a clear hint
		// when it is not reachable. Opt out via `chromeDevtools.enabled: false`.
		// Env overrides (PIT_CHROME_DEVTOOLS_HOST/PORT) win over settings.
		// Legacy PI_* names are still read as a fallback for one release.
		const envHost = process.env.PIT_CHROME_DEVTOOLS_HOST || process.env.PI_CHROME_DEVTOOLS_HOST;
		const envPort = process.env.PIT_CHROME_DEVTOOLS_PORT || process.env.PI_CHROME_DEVTOOLS_PORT;
		const port = envPort && Number.isFinite(Number(envPort)) ? Number(envPort) : (raw?.debugPort ?? 9222);
		return {
			enabled: raw?.enabled !== false,
			debugPort: port,
			host: envHost || raw?.host || "127.0.0.1",
			// Auto-launch Chrome (default ON) into a dedicated persistent profile.
			launchBrowser: raw?.launchBrowser !== false,
			binaryPath: process.env.PIT_CHROME_DEVTOOLS_BINARY || process.env.PI_CHROME_DEVTOOLS_BINARY || raw?.binaryPath,
			userDataDir: join(getAgentDir(), "chrome-data"),
		};
	}

	/**
	 * Resolve web_search settings. Enabled by default; opt out via
	 * `webSearch.enabled: false`. Returns a defensive copy of any per-provider
	 * api-key overrides so callers cannot mutate the in-memory settings.
	 */
	getWebSearchSettings(): ResolvedWebSearchSettings {
		const raw = this.settings.webSearch;
		const providers: Record<string, { apiKey?: string }> = {};
		if (raw?.providers && typeof raw.providers === "object") {
			for (const [name, value] of Object.entries(raw.providers)) {
				if (value && typeof value === "object") {
					providers[name] = { apiKey: typeof value.apiKey === "string" ? value.apiKey : undefined };
				}
			}
		}
		// Default ON: the `web_search` tool is registered and routes through the
		// configured provider chain. Providers without env keys simply fall through
		// the chain, so being enabled with no keys is a no-op. Opt out via
		// `webSearch.enabled: false` in settings.json.
		return {
			enabled: raw?.enabled !== false,
			defaultProvider:
				typeof raw?.defaultProvider === "string" && raw.defaultProvider.length > 0 ? raw.defaultProvider : "auto",
			providers,
		};
	}
}
