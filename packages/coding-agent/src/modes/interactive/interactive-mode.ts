/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentMessage,
	isOverthinkSteerMessage,
	isStreamGuardAbortMessage,
	isTtsrSteerMessage,
	type ThinkingLevel,
} from "@pit/agent-core";
import {
	type AssistantMessage,
	type DiagnosticEvent,
	getProviders,
	getRuntimeDiagnostics,
	type ImageContent,
	type Message,
	type Model,
	type OAuthProviderId,
	type OAuthSelectPrompt,
	onDiagnostic,
	suggestClosest,
} from "@pit/ai";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	EditorComponent,
	Keybinding,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	SlashCommand,
} from "@pit/tui";
import {
	Cheatsheet,
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	getCapabilities,
	getKeybindings,
	Loader,
	type LoaderIndicatorOptions,
	Markdown,
	matchesKey,
	ProcessTerminal,
	SPINNER_FRAME_MS,
	Spacer,
	setKeybindings,
	Text,
	TruncatedText,
	TUI,
	VirtualizedContainer,
	visibleWidth,
} from "@pit/tui";
import chalk from "chalk";
import { spawn } from "child_process";
import { APP_NAME, APP_TITLE, getAgentDir, getAuthPath, getDebugLogPath, VERSION } from "../../config.ts";
import { type AgentSession, type AgentSessionEvent, parseSkillBlock } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.ts";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import { detectCliAsync } from "../../core/fusion/cli-runner.ts";
import { formatElapsed, parseTokenBudget } from "../../core/goal/goal-manager.ts";
import { sliceSafe } from "../../utils/surrogate.ts";

/**
 * Detect an inline `/chrome` token anywhere in the message (start, middle, or
 * end) and strip it, returning the remaining text. `/chrome` must be a
 * standalone token (not part of a larger word like `/chromecast`).
 */
export function extractChromeCommand(text: string): { matched: boolean; rest: string } {
	if (!/(^|\s)\/chrome(?=\s|$)/i.test(text)) return { matched: false, rest: text };
	const rest = text
		.replace(/(^|\s)\/chrome(?=\s|$)/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	return { matched: true, rest };
}

import { modeDisplayLabel } from "../../core/built-ins/permissions-extension.ts";
import { getCurrentHindsightBank } from "../../core/hindsight/index.ts";
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts";
import { createCompactionSummaryMessage } from "../../core/messages.ts";
import { isHiddenModelProvider } from "../../core/model-registry.ts";
import {
	decideRoleForPermissionMode,
	defaultModelPerProvider,
	findExactModelReferenceMatch,
	MODEL_ROLES,
	type ModelRole,
	resolveRole,
} from "../../core/model-resolver.ts";
import {
	deriveProviderIdFromBaseUrl,
	normalizeBaseUrl,
	type ProbeResult,
	persistOpenAICompatibleProviderToModelsJson,
	probeOpenAICompatibleConnection,
} from "../../core/openai-compatible-presets.ts";
import { DefaultPackageManager } from "../../core/package-manager.ts";
import { humanModeNotifyLabel } from "../../core/permissions/mode-labels.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../../core/provider-display-names.ts";
import type { ResourceDiagnostic } from "../../core/resource-loader.ts";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../core/session-cwd.ts";
import { type SessionContext, SessionManager } from "../../core/session-manager.ts";
import type { ResolvedSkillDiscoverySettings } from "../../core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import type { TruncationResult } from "../../core/tools/truncate.ts";
import {
	type AskOptionsAnswer,
	type AskOptionsRequest,
	computeAutoAnswer,
	createUserInputBus,
	setCurrentUserInputBus,
	type UserInputBus,
} from "../../core/user-input-bus.ts";
import { type ClipboardImage, readClipboardImage } from "../../utils/clipboard-image.ts";
import { isOfflineMode, isReducedMotion } from "../../utils/env-flags.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import { checkForNewPiVersion, type LatestPiRelease } from "../../utils/version-check.ts";
import { ActivityStacker } from "./activity-stacker.ts";
import { prefixAutocompleteDescription } from "./autocomplete-source.ts";
import { ArminComponent } from "./components/armin.ts";
import { createAskPicker } from "./components/ask-picker.ts";
import { AssistantMessageComponent, messageHasVisibleContent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import {
	formatContextFilesHeader,
	formatLoadedSectionHeader,
	pluralCountLabel,
	renderCompactItemRow,
	renderContextFilesBody,
} from "./components/context-display.ts";
import { CountdownTimer } from "./components/countdown-timer.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { DaxnutsComponent } from "./components/daxnuts.ts";
import { DiagnosticsBlockComponent } from "./components/diagnostics-block.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { EarendilAnnouncementComponent } from "./components/earendil-announcement.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { FooterComponent } from "./components/footer.ts";
import { FusionLiveComponent, type FusionLiveMember } from "./components/fusion-live.ts";
import { FusionSetupComponent } from "./components/fusion-setup.ts";
import { createGoalOverlay, type GoalOverlay } from "./components/goal-overlay.ts";
import {
	formatKeyText,
	HINT_SEPARATOR,
	keyDisplayText,
	keyHint,
	keyText,
	rawKeyHint,
} from "./components/keybinding-hints.ts";
import { LoginDialogComponent } from "./components/login-dialog.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "./components/oauth-selector.ts";
import { OverthinkSteerMessageComponent } from "./components/overthink-steer-message.ts";
import { PendingUserMessageComponent } from "./components/pending-user-message.ts";
import { SessionSelectorComponent } from "./components/session-selector.ts";
import { SettingsSelectorComponent } from "./components/settings-selector.ts";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
import { reducedMotionLoaderIndicator } from "./components/spinner-ticker.ts";
import { createTodoOverlay, type TodoOverlay } from "./components/todo-overlay.ts";
import { workingPhaseLabel } from "./components/tool-activity.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { TreeSelectorComponent } from "./components/tree-selector.ts";
import { TtsrSteerMessageComponent } from "./components/ttsr-steer-message.ts";
import { TurnDoneMessageComponent } from "./components/turn-done-message.ts";
import { TurnRule } from "./components/turn-rule.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { UserMessageSelectorComponent } from "./components/user-message-selector.ts";
import { WelcomeBox, type WelcomeBoxData } from "./components/welcome-box.ts";
import { workingPulsePalette } from "./components/working-palette.ts";
import { formatRuntimeDiagnostics } from "./diagnostics-summary.ts";
import {
	buildScopeGroups,
	buildWorkspaceCwdLabels,
	formatContextPath,
	formatDisplayPath,
	formatExtensionDisplayPath,
	formatScopeGroups,
	formatSkillDiagnosticsSummary,
	getCompactExtensionLabels,
	getCompactPathLabel,
	getShortPath,
} from "./display-utils.ts";
import { EphemeralStatusController, type EphemeralStatusKind } from "./ephemeral-status.ts";
import { runGoalDialog } from "./goal-dialog.ts";
import { dispatchSlashCommand, type SlashCommandHost } from "./interactive-slash-commands.ts";
import { classifyRetryReason } from "./retry-reason.ts";
import {
	applySkillsDoctorFix,
	formatSkillsDoctorBrief,
	formatSkillsDoctorFixResult,
	formatSkillsDoctorReport,
	planSkillsDoctorFix,
	tallySkillDiagnostics,
} from "./skills-doctor.ts";
import { heroWordmarkMidpoint, lerpRgb, parseTrueColorFg, rgbFg, shimmerColorAt } from "./theme/color-interpolation.ts";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	setThemeInstance,
	stopThemeWatcher,
	Theme,
	theme,
} from "./theme/theme.ts";
import { buildTurnDoneSnapshot } from "./turn-done-format.ts";

/**
 * A structural rule for the chat transcript (e.g. hotkeys framing).
 * Muted hairline rather than DynamicBorder's saturated blue default — the rule
 * organizes the flow without competing with content. Modal selectors keep the
 * blue default deliberately, as a focus cue.
 */
function mutedBorderRule(): DynamicBorder {
	return new DynamicBorder((str) => theme.fg("borderMuted", str));
}

/** Normalize a caught value into a human-readable message string. */
function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

class ExpandableText extends Text implements Expandable {
	private readonly getCollapsedText: () => string;
	private readonly getExpandedText: () => string;

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
		this.getCollapsedText = getCollapsedText;
		this.getExpandedText = getExpandedText;
	}

	setExpanded(expanded: boolean): void {
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}
}

type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
};

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

// Grace window after an interrupt (Esc/Ctrl+C) before the TUI surfaces a
// stuck-turn escalation. A clean abort settles in well under a frame; this is
// long enough to never false-fire on a normal interrupt, short enough that a
// genuine wedge gives feedback fast.
const INTERRUPT_WATCHDOG_MS = 2000;

/** Tools that may change the working tree — refresh git diff stats after success. */
const MUTATING_TOOLS_FOR_DIFF_REFRESH = new Set(["edit", "edit_v2", "write", "bash", "ast_edit", "code"]);

// Theme preview cycles fast (holding an arrow key in the settings selector) —
// debounce the full transcript recolor so each keystroke doesn't pay for a
// full ui.invalidate() cascade.
const THEME_PREVIEW_INVALIDATE_MS = 90;

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.";

function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

function isUnknownModel(model: Model<any> | undefined): boolean {
	return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

function hasDefaultModelProvider(providerId: string): providerId is keyof typeof defaultModelPerProvider {
	return providerId in defaultModelPerProvider;
}

const BUILT_IN_MODEL_PROVIDERS = new Set<string>(getProviders());

export function isApiKeyLoginProvider(
	providerId: string,
	oauthProviderIds: ReadonlySet<string>,
	builtInProviderIds: ReadonlySet<string> = BUILT_IN_MODEL_PROVIDERS,
): boolean {
	if (BUILT_IN_PROVIDER_DISPLAY_NAMES[providerId]) {
		return true;
	}
	if (builtInProviderIds.has(providerId)) {
		return false;
	}
	return !oauthProviderIds.has(providerId);
}

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
}

export class InteractiveMode {
	private runtimeHost: AgentSessionRuntime;
	private ui: TUI;
	private chatContainer: VirtualizedContainer;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private defaultEditor: CustomEditor;
	private editor: EditorComponent;
	private editorComponentFactory: EditorFactory | undefined;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	// All known slash-command names (built-in + template + extension + skill),
	// refreshed whenever the autocomplete provider is rebuilt. Used to catch a
	// typo'd "/command" before it is silently sent to the model as a prompt.
	private _knownCommandNames = new Set<string>();
	private fdPath: string | undefined;
	private editorContainer: Container;
	private footer: FooterComponent;
	private footerDataProvider: FooterDataProvider;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private loadingAnimation: Loader | undefined = undefined;
	private fusionLive: FusionLiveComponent | undefined = undefined;
	// Per-session memo of `detectCli` probes (a blocking spawnSync, 10s timeout):
	// cache the result per CLI so /fusion runs the probe at most once per CLI per
	// session instead of re-spawning on every invocation.
	private readonly _cliDetectCache = new Map<string, boolean>();
	// Set when Fusion is in the writer stage (compact strip kept until message_start).
	// The Fusion turn never emits agent_end, so nothing else would clear this flag;
	// the writer's own message_start consumes it to tear the strip down. Scoped so
	// normal turns keep their persistent working loader untouched.
	private _fusionWriterLoaderActive = false;
	private workingMessage: string | undefined = undefined;
	private streamTextCharCount = 0;
	// Output tokens accrued in the CURRENT turn from assistant messages that have
	// already finalized (their usage.output is only known at message_end). Reset to
	// 0 at agent_start; the in-flight streaming message's partial usage is added on
	// top at display time so the chip stays live. See refreshLoaderTrailingSuffix.
	private turnOutputTokens = 0;
	// Memoized `· <key> to interrupt` suffix fragment (theme.fg() + keyText() both
	// do real work — keybinding lookup, ANSI wrap). refreshLoaderTrailingSuffix runs
	// once per message_update (potentially per streamed token), so recomputing this
	// constant-per-turn fragment on every call was pure waste. Recomputed lazily and
	// cached; invalidated on a live theme/keybindings change so a mid-turn edit isn't
	// stuck stale (normal churn is once per turn, from createWorkingLoader).
	private cachedLoaderInterruptSuffix: string | null = null;
	// Last full trailing-suffix string actually pushed to the loader. Lets
	// refreshLoaderTrailingSuffix skip the setTrailingSuffix() call (colorizes +
	// diffs again internally) when the composed suffix is byte-identical to what's
	// already showing — true for most ticks, since the token/char chips only change
	// in coarse steps (formatTokenChip).
	private lastAppliedLoaderSuffix: string | undefined;
	private workingVisible = true;
	private workingIndicatorOptions: LoaderIndicatorOptions | undefined = undefined;
	private readonly defaultWorkingMessage = "Working…";
	private readonly awaitingUserInputMessage = "Waiting for your answer…";
	private readonly userWaitMessage = "Waiting for you…";
	// Reference count of open user-input prompts (ask picker, permission/extension
	// confirm, custom overlay). While > 0 the working clock is frozen and relabeled
	// — the agent is blocked on the user, not working. The first holder's message
	// wins; the clock resumes when the last prompt closes.
	private userInputPauseDepth = 0;
	private userInputPauseMessage: string | null = null;
	private readonly defaultHiddenThinkingLabel = "Thinking…";
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	private lastSigintTime = 0;
	// Ephemeral "Press Ctrl+C again to exit" hint (lives in statusContainer, not the
	// permanent showStatus channel). Cleared on next input or when the 500ms window expires.
	private ctrlCHint: Text | undefined = undefined;
	private ctrlCHintTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	private lastEscapeTime = 0;
	// Defense-in-depth for interrupt: if the turn doesn't settle within this grace
	// window after Esc/Ctrl+C, surface a stuck-turn escalation instead of leaving
	// the spinner counting silently. Cleared when the turn settles (agent_end / prompt_end).
	private interruptWatchdogTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	/** Turn-done line deferred until post-turn gates finish (`prompt_end`). */
	private deferredTurnDone: ReturnType<typeof buildTurnDoneSnapshot> | null = null;
	private anthropicSubscriptionWarningShown = false;

	// Ephemeral status above the editor (statusContainer). Not part of the transcript.
	private ephemeralStatusText: Text | undefined = undefined;
	/** Color used by the next/current info toast (preserves showStatus color overrides). */
	private ephemeralPaintColor: (text: string) => string = (text) => theme.fg("dim", text);
	private ephemeralStatus!: EphemeralStatusController;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;
	// The last AssistantMessageComponent attached in the current turn; cleared at agent_start.
	private lastAssistantComponent: AssistantMessageComponent | null = null;
	// All text-bearing assistant components of the current turn, in order. At
	// agent_end the last is the deliverable; the rest are dimmed as narration.
	private turnAssistantComponents: AssistantMessageComponent[] = [];

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();

	// Grouped activity stacker (initialized in start())
	private activityStacker!: ActivityStacker;
	private streamingAttached = false;

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = false;

	// Active model role (default | smol | slow | plan | commit). Switched via
	// `/model <role>`. Influences which fallback chain is consulted on
	// Ctrl+P cycling and which model is restored on `/model role`.
	private activeRole: ModelRole = "default";
	/** Role active before entering plan mode; restored on exit when still on "plan". */
	private roleBeforePlan: ModelRole | undefined;

	// Last search term typed in the /model picker. Restored when the picker is
	// reopened via the keybinding or a bare `/model` (no arg), so a multi-step
	// model hunt doesn't reset to the full list each time. Session-only; a fresh
	// session starts with an empty search.
	private lastModelSearch = "";

	// Skill commands: command name -> skill file path
	private skillCommands = new Map<string, string>();

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;
	// Runtime-diagnostics (@pit/ai) bridge: surfaces error-level guard events live.
	private diagnosticsUnsubscribe?: () => void;
	private signalCleanupHandlers: Array<() => void> = [];

	// Shared-ticker subscription that keeps the goal spinner (and, by extension,
	// the todo overlay) animating in the brief gaps between turns where no
	// streaming drives renders. It rides the same monotonic clock as every other
	// animation so their phases stay locked.
	private _goalSpinnerUnsub: (() => void) | undefined;
	// Last animation-phase bucket the goal spinner requested a render for; gates
	// out the ~60fps ticks that would not change the (80ms) spinner frame.
	private _goalSpinnerBucket = -1;

	/** Permission mode is plan — drives editor border + footer chip (not model role). */
	private isPlanPermissionMode = false;

	// Live "above editor" todo overlay (auto-hides when there are no todos).
	private todoOverlay: TodoOverlay | undefined;
	// Live "above editor" goal panel (sits ABOVE the todo overlay; auto-hides
	// when no goal is active; lingers briefly on complete then vanishes).
	private goalOverlay: GoalOverlay | undefined;

	// Guard so the cheatsheet hotkey toggles a single overlay (no stacking).
	private cheatsheetOpen = false;

	// User-input bus: tools (e.g. `ask`) request structured option picks via this.
	private userInputBus: UserInputBus = createUserInputBus();
	private userInputBusUnsubscribe?: () => void;
	private pendingAskRequest: AskOptionsRequest | undefined;

	// Track if editor is in bash mode (text starts with !)
	private isBashMode = false;

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Auto-compaction state
	private autoCompactionLoader: Loader | undefined = undefined;
	private autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	private retryLoader: Loader | undefined = undefined;
	private retryCountdown: CountdownTimer | undefined = undefined;
	private retryEscapeHandler?: () => void;

	// Messages queued while compaction is running
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Shutdown state
	private shutdownRequested = false;

	// Extension UI state
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputUnsubscribers = new Set<() => void>();

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (keybinding hints + rotating tip). The framed identity
	// block (logo + context) is the separate, static welcomeBox below.
	private builtInHeader: Component | undefined = undefined;

	// Framed identity block at startup (logo + cwd/model context). Static — it
	// never expands, so toggling tool output mid-session can't make it flicker.
	private welcomeBox: WelcomeBox | undefined = undefined;

	// Unsubscribe for the one-shot hero-wordmark ignition ease (A3). Non-null only
	// while the ease is running; cleared on completion and on stop() so a torn-down
	// session never leaks the animation callback.
	private heroIgnitionUnsub: (() => void) | null = null;

	// Expansion state for the startup hint block, owned independently of
	// toolOutputExpanded so a mid-session tool toggle does not resize the header.
	private startupHeaderExpanded = false;

	// True until the first prompt is submitted: while the welcome screen is the
	// focus, the expand key grows the startup help instead of tool output.
	private welcomeActive = true;

	/** process.cwd() at launcher start — compared against session cwd in the header/footer. */
	private readonly launchCwd: string;

	/** Shown in the chat area on a fresh session with no messages yet. On the
	 * default brand this is just a Spacer (the hero carries the welcome; hints
	 * were decluttered away); a rebranded app keeps a single left-aligned
	 * mechanics Text. Added/removed as one unit. */
	private emptyStateHint: Component | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	private options: InteractiveModeOptions;

	// Convenience accessors
	private get session(): AgentSession {
		return this.runtimeHost.session;
	}
	private get agent() {
		return this.session.agent;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}

	constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
		this.launchCwd = process.cwd();
		this.runtimeHost = runtimeHost;
		this.options = options;
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			this.resetExtensionUI();
		});
		this.runtimeHost.setRebindSession(async () => {
			await this.rebindCurrentSession();
		});
		// Permission-mode changes (slash command, cycle key, or exit_plan
		// approval) swap the model role: plan mode → "plan" role when configured,
		// back to the pre-plan role (or "default") on exit — never clobbering a
		// role the user picked manually mid-plan. Fail-open: no plan role
		// configured → silent no-op.
		this.runtimeHost.services.bindPermissionModeChange?.((mode) => {
			this.isPlanPermissionMode = mode === "plan";
			if (mode === "plan" && this.activeRole !== "plan") {
				this.roleBeforePlan = this.activeRole;
			}
			const planConfig = this.settingsManager.getModelRoleSettings().modelRoles?.plan;
			const role = decideRoleForPermissionMode(mode, this.activeRole, planConfig, this.roleBeforePlan);
			if (role) {
				void this.applyModelRole(role, { silent: true });
			}
			if (mode === "auto") {
				this.roleBeforePlan = undefined;
			}
			this.refreshModelIndicators();
		});
		this.runtimeHost.services.bindFusionNeedsSetup?.(() => {
			void this.handleFusionCommand();
		});
		this.version = VERSION;
		this.ui = new TUI(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.chatContainer = new VirtualizedContainer();
		this.activityStacker = new ActivityStacker(this.ui, (component) => this.chatContainer.addChild(component));
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.ephemeralStatus = new EphemeralStatusController({
			paint: (message, kind) => this.paintEphemeralStatus(message, kind),
			clear: () => this.removeEphemeralStatusLine(),
		});
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
			closedBottom: this.settingsManager.getEditorClosedBottom(),
			onPasteTruncated: (info) => this._onPasteTruncated(info),
		});
		this.defaultEditor.setPlaceholder("Describe a task…");
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		this.footer = new FooterComponent(this.session, this.footerDataProvider, this.launchCwd, this.ui);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footer.setDensity(this.settingsManager.getFooterDensity());

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		initTheme(this.settingsManager.getTheme(), true);
	}

	private getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[] {
		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		return extensionRunner
			.getRegisteredCommands()
			.filter((command) => builtinNames.has(command.name))
			.map((command) => ({
				type: "warning" as const,
				message:
					command.invocationName === command.name
						? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
						: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
				path: command.sourceInfo.path,
			}));
	}

	private createBaseAutocompleteProvider(): AutocompleteProvider {
		// Define commands for autocomplete
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
		}));
		// Built-ins flagged `hidden` stay "known" (dispatched when typed, still shadow
		// same-named extension/skill commands) but are dropped from the "/" menu.
		const hiddenBuiltinNames = new Set(
			BUILTIN_SLASH_COMMANDS.filter((command) => command.hidden).map((command) => command.name),
		);
		const visibleSlashCommands = slashCommands.filter((command) => !hiddenBuiltinNames.has(command.name));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				// Get available models (scoped or from registry)
				const models =
					this.session.scopedModels.length > 0
						? this.session.modelRegistry.filterScopedModels(this.session.scopedModels).map((s) => s.model)
						: this.session.modelRegistry.getAvailable();

				if (models.length === 0) return null;

				// Create items with provider/id format
				const items = models.map((m) => ({
					id: m.id,
					provider: m.provider,
					label: `${m.provider}/${m.id}`,
				}));

				// Fuzzy filter by model ID + provider (allows "opus anthropic" to match)
				const filtered = fuzzyFilter(items, prefix, (item) => `${item.id} ${item.provider}`);

				if (filtered.length === 0) return null;

				return filtered.map((item) => ({
					value: item.label,
					label: item.id,
					description: item.provider,
				}));
			};
		}

		// Convert prompt templates to SlashCommand format for autocomplete
		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
			name: cmd.name,
			description: prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
		}));

		// Convert extension commands to SlashCommand format
		const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
		const extensionCommands: SlashCommand[] = this.session.extensionRunner
			.getRegisteredCommands()
			.filter((cmd) => !builtinCommandNames.has(cmd.name))
			.map((cmd) => ({
				name: cmd.invocationName,
				description: prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
				getArgumentCompletions: cmd.getArgumentCompletions,
			}));

		// Build skill commands from session.skills (if enabled). Skills register as
		// plain `/name` (Claude Code parity). Skip any whose name collides with a
		// built-in / template / extension command: those take precedence in dispatch,
		// so a same-named skill would be an unreachable, duplicate menu entry.
		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			const takenNames = new Set<string>(
				[...slashCommands, ...templateCommands, ...extensionCommands].map((c) => c.name),
			);
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				if (takenNames.has(skill.name)) continue;
				this.skillCommands.set(skill.name, skill.filePath);
				skillCommandList.push({
					name: skill.name,
					description: prefixAutocompleteDescription(skill.description, skill.sourceInfo),
				});
			}
		}

		this._knownCommandNames = new Set(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList].map((c) => c.name),
		);
		return new CombinedAutocompleteProvider(
			[...visibleSlashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			this.sessionManager.getCwd(),
			this.fdPath,
		);
	}

	private setupAutocompleteProvider(): void {
		let provider = this.createBaseAutocompleteProvider();
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			provider = wrapProvider(provider);
		}

		this.autocompleteProvider = provider;
		this.defaultEditor.setAutocompleteProvider(provider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(provider);
		}
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.registerSignalHandlers();

		// Ensure fd and rg are available (downloads if missing, adds to PATH via getBinDir)
		// Both are needed: fd for autocomplete, rg for grep tool and bash commands
		const [fdPath] = await Promise.all([ensureTool("fd"), ensureTool("rg")]);
		this.fdPath = fdPath;

		// Add header container as first child
		this.ui.addChild(this.headerContainer);

		// Identity block: hero wordmark on fresh sessions (logo + tagline only —
		// cwd/branch orientation lives in the footer), framed card with the
		// workspace line on resume/rebrand. The product's face, so it renders even
		// under quietStartup; quiet only silences the verbose hint/tip block below.
		// Static (never expands), so a mid-session tool toggle cannot resize it.
		// The active model is NOT shown here — the footer owns it.
		this.welcomeBox = new WelcomeBox(this.buildWelcomeBoxData());
		this.headerContainer.addChild(new Spacer(1));
		this.headerContainer.addChild(this.welcomeBox);
		this.startHeroIgnition();

		// Verbose startup hints + rotating tip — suppressed under quietStartup.
		const isResumed = this.session.state.messages.length > 0;
		if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			// Build startup instructions using keybinding hint helpers
			const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

			const expandedInstructions = [
				hint("app.interrupt", "to interrupt"),
				hint("app.clear", "to clear"),
				rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
				hint("app.exit", "to exit (empty)"),
				hint("app.suspend", "to suspend"),
				keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
				hint("app.thinking.cycle", "to cycle thinking level"),
				rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
				hint("app.model.select", "to select model"),
				hint("app.tools.expand", "to expand tools"),
				hint("app.thinking.toggle", "to expand thinking"),
				hint("app.editor.external", "for external editor"),
				rawKeyHint("/", "for commands"),
				rawKeyHint("!", "to run bash"),
				rawKeyHint("!!", "to run bash (no context)"),
				hint("app.message.followUp", "to queue follow-up"),
				hint("app.message.dequeue", "to edit all queued messages"),
				hint("app.clipboard.pasteImage", "to paste image"),
				rawKeyHint("drop files", "to attach"),
			].join("\n");
			// Compact = a short essentials line + (first-run only) one rotating tip,
			// instead of the old wall of shortcuts. The full list stays one expand away.
			const essentials = [
				rawKeyHint("/", "commands"),
				rawKeyHint("!", "bash"),
				hint("app.tools.expand", "more"),
			].join(theme.fg("muted", HINT_SEPARATOR));
			const startupTips = [
				"drag files into the terminal to attach them",
				`${keyText("app.model.cycleForward")} cycles models · ${keyText("app.model.select")} picks one`,
				`/fusion pairs two advisors · ${keyText("app.permission.cycle")} cycles plan/auto/fusion`,
				`ask "how does ${APP_NAME} work?" — it can explain and extend itself`,
				`${keyText("app.editor.external")} opens your editor for long prompts`,
				`${keyText("app.thinking.cycle")} cycles the thinking level`,
				"paste an image to include it in your message",
				`${keyText("app.message.followUp")} queues a follow-up while it works`,
			];
			const tip = theme.fg("dim", `tip: ${startupTips[Math.floor(Math.random() * startupTips.length)]}`);
			const onboarding = theme.fg(
				"dim",
				`${APP_NAME} can explain its own features and look up its docs. Ask it how to use or extend ${APP_NAME}.`,
			);
			this.builtInHeader = new ExpandableText(
				() => (isResumed ? essentials : `${essentials}\n${tip}`),
				() => `${expandedInstructions}\n\n${onboarding}`,
				this.getStartupExpansionState(),
				1,
				0,
			);

			// Verbose hints render below the identity block.
			this.headerContainer.addChild(this.builtInHeader);
		} else {
			// Quiet startup: the welcome identity stays, only the hints are silenced.
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
		}
		// No trailing spacer: every chat block (MessageShell) and loaded-resource
		// section brings its own leading blank, so a header-owned gap doubled up
		// into two dead lines between the banner and the first content.

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		// Goal overlay above the todo overlay: goal commands, todos obey.
		this.goalOverlay = createGoalOverlay(this.session);
		this.ui.addChild(this.goalOverlay);
		this.todoOverlay = createTodoOverlay(this.session);
		this.ui.addChild(this.todoOverlay);
		this.renderWidgets(); // Initialize with default spacer
		this.ui.addChild(this.widgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.widgetContainerBelow);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();

		// Bind the user-input bus so tools (e.g. `ask`) can request a structured
		// option pick mid-turn. Print mode intentionally does NOT bind a listener
		// — the bus auto-resolves with the recommended/first option in that case.
		this.bindUserInputBus();

		// Animate the footer goal spinner; resume it for a goal restored from the
		// session file, and tear it down on shutdown.
		this.signalCleanupHandlers.push(() => this._stopGoalSpinner());
		this._startGoalSpinner();

		// Start the UI before initializing extensions so session_start handlers can use interactive dialogs
		this.ui.start();
		this.isInitialized = true;

		// Initialize extensions first so resources are shown before messages
		await this.rebindCurrentSession();

		// Render initial messages AFTER showing loaded resources
		this.renderInitialMessages();
		this.updateEmptyStateHint();

		// Set up theme file watcher
		onThemeChange(() => {
			this._cachedMarkdownTheme = undefined;
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		this.footerDataProvider.onBranchChange(() => {
			this.refreshWelcomeBoxData();
			this.ui.requestRender();
		});
		this.footerDataProvider.onWorkingTreeChange(() => {
			this.refreshWelcomeBoxData();
			this.ui.requestRender();
		});

		// Initialize available provider count for footer display
		await this.updateAvailableProviderCount();
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		await this.init();

		const warningSettings = this.session.settingsManager.getWarnings();

		// Start version check asynchronously (off by default; opt in with warnings.newVersion === true).
		if (warningSettings.newVersion === true) {
			checkForNewPiVersion(this.version).then((newRelease) => {
				if (newRelease) {
					this.showNewVersionNotification(newRelease);
				}
			});
		}

		// Start package update check asynchronously (off by default; opt in with warnings.packageUpdates === true).
		if (warningSettings.packageUpdates === true) {
			this.checkForPackageUpdates().then((updates) => {
				if (updates.length > 0) {
					this.showPackageUpdateNotification(updates);
				}
			});
		}

		// Check tmux keyboard setup asynchronously
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		// Show startup warnings
		const { migratedProviders, modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRegistry.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		// LSP startup probing is deferred off the boot critical path, so its
		// warnings may not be recorded yet at construction; await the probe here
		// (post-paint) before draining them so the missing-tsserver notice still shows.
		await this.session.whenLspStartupReady();
		for (const warning of this.session.getLspStartupWarnings()) {
			this.showWarning(warning);
		}

		void this.maybeWarnAboutAnthropicSubscriptionAuth();

		// Process initial messages
		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}

		// Main interactive loop — keep the process alive and re-arm getUserInput
		// after each submit. prompt() is dispatched from the editor onSubmit handler
		// (same as steer/followUp paths) so a message is never dropped when
		// onInputCallback is unset (startup gap, or a wedged await on the prior turn).
		while (true) {
			await this.getUserInput();
		}
	}

	private async checkForPackageUpdates(): Promise<string[]> {
		if (isOfflineMode()) {
			return [];
		}

		try {
			const packageManager = new DefaultPackageManager({
				cwd: this.sessionManager.getCwd(),
				agentDir: getAgentDir(),
				settingsManager: this.settingsManager,
			});
			const updates = await packageManager.checkForAvailableUpdates();
			return updates.map((update) => update.displayName);
		} catch {
			return [];
		}
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
		if (extendedKeys === undefined) return undefined;

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
		}

		if (extendedKeysFormat === "xterm") {
			return `tmux extended-keys-format is xterm. ${APP_NAME} works best with csi-u. Add \`set -g extended-keys-format csi-u\` to ~/.tmux.conf and restart tmux.`;
		}

		return undefined;
	}

	private _cachedMarkdownTheme?: MarkdownTheme;
	private _cachedCodeBlockIndent?: string;
	private _themePreviewInvalidateTimer?: ReturnType<typeof setTimeout>;

	/**
	 * Apply a theme for live preview (settings selector cycling through
	 * themes). Cheap surfaces (markdown cache, loader suffix, editor border)
	 * update immediately; the full transcript recolor (`ui.invalidate()`,
	 * which cascades all children) is debounced so holding an arrow key
	 * through the theme list doesn't pay a full invalidate per keystroke.
	 */
	private previewTheme(themeName: string): void {
		const result = setTheme(themeName, true);
		if (!result.success) return;
		// Cheap, immediate surfaces (same set the old preview path touched):
		this._cachedMarkdownTheme = undefined;
		this.invalidateLoaderInterruptSuffix();
		this.updateEditorBorderColor();
		this.ui.requestRender();
		// Full transcript recolor is debounced: holding an arrow key through the
		// theme list must not pay a full invalidate per keystroke.
		if (this._themePreviewInvalidateTimer) clearTimeout(this._themePreviewInvalidateTimer);
		this._themePreviewInvalidateTimer = setTimeout(() => {
			this._themePreviewInvalidateTimer = undefined;
			this.ui.invalidate();
			this.ui.requestRender();
		}, THEME_PREVIEW_INVALIDATE_MS);
		(this._themePreviewInvalidateTimer as { unref?: () => void }).unref?.();
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		// The base markdown theme is "live": every entry is a closure over the
		// `theme` Proxy, so color changes are reflected without rebuilding. The
		// only static input is `codeBlockIndent` (a string), so we rebuild only
		// when it changes. The theme-change handler also clears this defensively.
		const codeBlockIndent = this.settingsManager.getCodeBlockIndent();
		if (this._cachedMarkdownTheme && this._cachedCodeBlockIndent === codeBlockIndent) {
			return this._cachedMarkdownTheme;
		}
		const markdownTheme: MarkdownTheme = {
			...getMarkdownTheme(),
			codeBlockIndent,
		};
		this._cachedMarkdownTheme = markdownTheme;
		this._cachedCodeBlockIndent = codeBlockIndent;
		return markdownTheme;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	private getStartupExpansionState(): boolean {
		return this.options.verbose || this.startupHeaderExpanded;
	}

	private showLoadedResources(options?: {
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const skillsResult = this.session.resourceLoader.getSkills();

		const addLoadedSection = (
			title: string,
			count: number,
			singular: string,
			plural: string,
			collapsedLabels: string[],
			expandedBody: string,
			options?: { sort?: boolean },
		): void => {
			const labels = collapsedLabels.map((item) => item.trim()).filter((item) => item.length > 0);
			if (options?.sort !== false) {
				labels.sort((a, b) => a.localeCompare(b));
			}
			const header = formatLoadedSectionHeader(title, pluralCountLabel(count, singular, plural));
			const collapsedBody = renderCompactItemRow(labels);
			const section = new ExpandableText(
				() => `${header}\n${collapsedBody}`,
				() => `${header}\n${expandedBody}`,
				this.getStartupExpansionState(),
				0,
				0,
			);
			this.chatContainer.addChild(section);
			this.chatContainer.addChild(new Spacer(1));
		};

		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();
		const extensions =
			options?.extensions ??
			this.session.resourceLoader.getExtensions().extensions.map((extension) => ({
				path: extension.path,
				sourceInfo: extension.sourceInfo,
			}));
		const sourceInfos = new Map<string, SourceInfo>();
		for (const extension of extensions) {
			if (extension.sourceInfo) {
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		for (const skill of skillsResult.skills) {
			if (skill.sourceInfo) {
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		for (const prompt of promptsResult.prompts) {
			if (prompt.sourceInfo) {
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		for (const loadedTheme of themesResult.themes) {
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		if (showListing) {
			const contextFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
			if (contextFiles.length > 0) {
				this.chatContainer.addChild(new Spacer(1));
				const contextPaths = contextFiles.map((contextFile) =>
					formatContextPath(contextFile.path, this.sessionManager.getCwd()),
				);
				const contextHeader = formatContextFilesHeader(contextPaths.length);
				const contextCollapsed = `${contextHeader}\n${renderContextFilesBody(contextPaths, true)}`;
				const contextExpandedPaths = contextFiles.map((f) => formatDisplayPath(f.path));
				const contextExpanded = `${contextHeader}\n${renderContextFilesBody(contextExpandedPaths, false)}`;
				const section = new ExpandableText(
					() => contextCollapsed,
					() => contextExpanded,
					this.getStartupExpansionState(),
					0,
					0,
				);
				this.chatContainer.addChild(section);
				this.chatContainer.addChild(new Spacer(1));
			}

			const skills = skillsResult.skills;
			if (skills.length > 0) {
				const groups = buildScopeGroups(
					skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
				);
				const skillList = formatScopeGroups(groups, {
					formatPath: (item) => formatDisplayPath(item.path),
					formatPackagePath: (item) => getShortPath(item.path, item.sourceInfo),
				});
				addLoadedSection(
					"Skills",
					skills.length,
					"skill",
					"skills",
					skills.map((skill) => skill.name),
					skillList,
				);
			}

			const templates = this.session.promptTemplates;
			if (templates.length > 0) {
				const groups = buildScopeGroups(
					templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
				);
				const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
				const templateList = formatScopeGroups(groups, {
					formatPath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : formatDisplayPath(item.path);
					},
					formatPackagePath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : formatDisplayPath(item.path);
					},
				});
				addLoadedSection(
					"Prompts",
					templates.length,
					"prompt",
					"prompts",
					templates.map((template) => `/${template.name}`),
					templateList,
				);
			}

			if (extensions.length > 0) {
				const groups = buildScopeGroups(extensions);
				const extList = formatScopeGroups(groups, {
					formatPath: (item) => formatExtensionDisplayPath(item.path),
					formatPackagePath: (item) => formatExtensionDisplayPath(getShortPath(item.path, item.sourceInfo)),
				});
				addLoadedSection(
					"Extensions",
					extensions.length,
					"extension",
					"extensions",
					getCompactExtensionLabels(extensions),
					extList,
				);
			}

			// Show loaded themes (excluding built-in)
			const loadedThemes = themesResult.themes;
			const customThemes = loadedThemes.filter((t) => t.sourcePath);
			if (customThemes.length > 0) {
				const groups = buildScopeGroups(
					customThemes.map((loadedTheme) => ({
						path: loadedTheme.sourcePath!,
						sourceInfo: loadedTheme.sourceInfo,
					})),
				);
				const themeList = formatScopeGroups(groups, {
					formatPath: (item) => formatDisplayPath(item.path),
					formatPackagePath: (item) => getShortPath(item.path, item.sourceInfo),
				});
				addLoadedSection(
					"Themes",
					customThemes.length,
					"theme",
					"themes",
					customThemes.map(
						(loadedTheme) =>
							loadedTheme.name ?? getCompactPathLabel(loadedTheme.sourcePath!, loadedTheme.sourceInfo),
					),
					themeList,
				);
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const skillLabel = "[Skills]";
				this.chatContainer.addChild(
					new DiagnosticsBlockComponent(skillLabel, skillDiagnostics, sourceInfos, {
						collapsedSummary: formatSkillDiagnosticsSummary,
					}),
				);
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				this.chatContainer.addChild(
					new DiagnosticsBlockComponent("[Prompt conflicts]", promptDiagnostics, sourceInfos),
				);
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionErrors = this.session.resourceLoader.getExtensions().errors;
			if (extensionErrors.length > 0) {
				for (const error of extensionErrors) {
					extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
				}
			}

			const commandDiagnostics = this.session.extensionRunner.getCommandDiagnostics();
			extensionDiagnostics.push(...commandDiagnostics);
			extensionDiagnostics.push(...this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner));

			const shortcutDiagnostics = this.session.extensionRunner.getShortcutDiagnostics();
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				this.chatContainer.addChild(
					new DiagnosticsBlockComponent("[Extension issues]", extensionDiagnostics, sourceInfos),
				);
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				this.chatContainer.addChild(
					new DiagnosticsBlockComponent("[Theme conflicts]", themeDiagnostics, sourceInfos),
				);
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async bindCurrentSessionExtensions(): Promise<void> {
		const uiContext = this.createExtensionUIContext();
		await this.session.bindExtensions({
			uiContext,
			abortHandler: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			commandContextActions: {
				waitForIdle: () => this.session.agent.waitForIdle(),
				newSession: async (options) => {
					this.stopWorkingLoader();
					try {
						const result = await this.runtimeHost.newSession(options);
						if (!result.cancelled) {
							this.renderCurrentSessionState();
							this.ui.requestRender();
						}
						return result;
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to create session", error);
					}
				},
				fork: async (entryId, options) => {
					try {
						const result = await this.runtimeHost.fork(entryId, options);
						if (!result.cancelled) {
							this.renderCurrentSessionState();
							this.editor.setText(result.selectedText ?? "");
							this.showStatus("Forked to new session");
						}
						return { cancelled: result.cancelled };
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to fork session", error);
					}
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}

					this._disposeChatComponents();
					this.chatContainer.clear();
					this.renderInitialMessages();
					if (result.editorText && !this.editor.getText().trim()) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("Navigated to selected point");
					void this.flushCompactionQueue({ willRetry: false });
					return { cancelled: false };
				},
				switchSession: async (sessionPath, options) => {
					return this.handleResumeSession(sessionPath, options);
				},
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (!this.session.isStreaming) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocompleteProvider();

		const extensionRunner = this.session.extensionRunner;
		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: false });
	}

	private buildWelcomeBoxData(): WelcomeBoxData {
		const isResumed = this.session.state.messages.length > 0;
		const cwdLabels = buildWorkspaceCwdLabels(
			this.sessionManager.getCwd(),
			this.launchCwd,
			this.footerDataProvider.getRepoDir(),
		);
		return {
			appName: APP_NAME,
			version: this.version,
			tagline: "Coding agent in your terminal",
			cwdDisplay: cwdLabels.session,
			shellCwdNote: cwdLabels.shellNote,
			branch: this.footerDataProvider.getGitBranch() ?? undefined,
			diffStats: this.footerDataProvider.getGitDiffStats(),
			resumedSessionName: isResumed ? this.sessionManager.getSessionName() : undefined,
			cardPaddingX: this.settingsManager.getCardPaddingX(),
			hero: !isResumed,
		};
	}

	private refreshWelcomeBoxData(): void {
		this.welcomeBox?.setData(this.buildWelcomeBoxData());
	}

	/**
	 * A3 — one-shot "ignition" for the fresh-session hero wordmark: over ~500ms the
	 * mark eases (smoothstep) from the theme `dim` color up to a bright mid-tone,
	 * then hands off to the real teal→lavender gradient. The mid-tone is the
	 * midpoint of the gradient's accent/thinking stops, so the last eased frame
	 * sits close to the gradient's average and the handoff does not pop.
	 *
	 * While the ease runs, `wordmarkColor` is a time-varying closure, which makes
	 * WelcomeBox bypass its memo and repaint every frame; on completion we restore
	 * data WITHOUT `wordmarkColor` (re-enabling memoization) and unsubscribe. Skips
	 * entirely under reduced motion, no-truecolor, resumed sessions, or a custom app
	 * name (the hero only renders for "pit").
	 */
	private startHeroIgnition(): void {
		const box = this.welcomeBox;
		if (!box) return;
		if (APP_NAME !== "pit") return;
		if (this.session.state.messages.length > 0) return; // resumed
		if (isReducedMotion() || !getCapabilities().trueColor) return;

		const dim = parseTrueColorFg(theme.getFgAnsi("dim"));
		if (!dim) return;
		// Midpoint of the hero gradient stops (accent ↔ thinkingXhigh), read from
		// the active theme so the handoff to heroWordmarkGradient stays seamless in
		// both dark and light. Falls back to `dim` (no ignition brightness) only if
		// the stops can't resolve to RGB.
		const bright = heroWordmarkMidpoint(theme) ?? dim;
		const baseData = this.buildWelcomeBoxData();
		const paintAt = (t: number) => rgbFg(lerpRgb(dim, bright, t));

		const DURATION_MS = 500;
		const start = performance.now();
		// Seed the first frame at the dim end so the wordmark ignites up from dark
		// rather than flashing the full gradient before the ease begins.
		box.setData({ ...baseData, wordmarkColor: paintAt(0) });

		this.heroIgnitionUnsub = this.ui.addAnimationCallback((now) => {
			const raw = Math.min(1, Math.max(0, (now - start) / DURATION_MS));
			if (raw >= 1) {
				// Final handoff: drop wordmarkColor → memoized gradient render, unsubscribe.
				box.setData(baseData);
				this.heroIgnitionUnsub?.();
				this.heroIgnitionUnsub = null;
				return true;
			}
			const eased = raw * raw * (3 - 2 * raw); // smoothstep
			box.setData({ ...baseData, wordmarkColor: paintAt(eased) });
			return true;
		});
	}

	private updateEmptyStateHint(): void {
		const hasMessages = this.session.state.messages.length > 0;
		if (hasMessages || !this.welcomeActive) {
			if (this.emptyStateHint) {
				this.chatContainer.removeChild(this.emptyStateHint);
				this.emptyStateHint = undefined;
			}
			return;
		}
		if (this.emptyStateHint) return;

		// The default brand paints NO empty-state hint (2026-07 declutter): the
		// "Try …" example line and the mechanics line both read as noise under
		// the hero, and the "Describe a task…" invitation already lives in the
		// editor placeholder. A lone Spacer keeps the hero → editor rhythm and
		// disappears with the first message like the old hint did. A rebranded
		// app keeps its compact left-aligned mechanics line (no hero there).
		if (APP_NAME === "pit") {
			this.emptyStateHint = new Spacer(1);
		} else {
			const hint = [
				rawKeyHint("/", "commands"),
				theme.fg("dim", " · "),
				rawKeyHint("!", "bash"),
				theme.fg("dim", " · "),
				theme.fg("dim", "drop files to attach"),
			].join("");
			this.emptyStateHint = new Text(hint, 0, 1);
		}
		this.chatContainer.addChild(this.emptyStateHint);
	}

	private applyRuntimeSettings(): void {
		this.footer.setSession(this.session);
		this.todoOverlay?.setSession(this.session);
		this.goalOverlay?.setSession(this.session);
		// Repaint the live todo overlay the instant the list changes, rather than
		// waiting for an incidental render (loader tick / tool event). Re-registered
		// here so a session swap points the listener at the new session's manager.
		this.session.setTodoChangeListener(() => this.ui.requestRender());
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footer.setDensity(this.settingsManager.getFooterDensity());
		this.footerDataProvider.setCwd(this.sessionManager.getCwd());
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		this.defaultEditor.setCursorBlink(this.settingsManager.getCursorBlink());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		if (this.editor !== this.defaultEditor) {
			this.editor.setPaddingX?.(editorPaddingX);
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
		this.refreshWelcomeBoxData();
		this.updateEmptyStateHint();
	}

	private async rebindCurrentSession(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.applyRuntimeSettings();
		await this.bindCurrentSessionExtensions();
		this.subscribeToAgent();
		await this.updateAvailableProviderCount();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
	}

	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = errMsg(error);
		this.showError(`${prefix}: ${message}`);
		stopThemeWatcher();
		this.stop();
		process.exit(1);
	}

	private renderCurrentSessionState(): void {
		this._disposeChatComponents();
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();
		this.renderInitialMessages();
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	private getRegisteredToolDefinition(toolName: string) {
		return this.session.getToolDefinition(toolName);
	}

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			hasUI: true,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.session.modelRegistry,
			model: this.session.model,
			isIdle: () => !this.session.isBusy,
			signal: this.session.agent.signal,
			abort: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.session.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`Shortcut handler error: ${errMsg(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	private getWorkingLoaderMessage(): string {
		return this.workingMessage ?? this.defaultWorkingMessage;
	}

	/**
	 * Set the working-loader phase label (e.g. "Thinking…", "Running bash…") from
	 * the live agent events, so the status line reflects what is actually
	 * happening instead of a static "Working…". Persisted in `workingMessage` so a
	 * loader rebuild keeps the phase. No-op while a prompt/ask pause owns the
	 * label ("Waiting for your answer…") — the phase resumes when the pause lifts.
	 */
	private setWorkingPhase(label: string): void {
		if (this.userInputPauseDepth > 0) return;
		this.workingMessage = label;
		this.loadingAnimation?.setMessage(label);
	}

	private resetStreamRateCounters(): void {
		this.streamTextCharCount = 0;
	}

	private countAssistantTextChars(message: AssistantMessage): number {
		let n = 0;
		for (const block of message.content) {
			if (block.type === "text" && typeof block.text === "string") {
				n += block.text.length;
			}
		}
		return n;
	}

	/** Compact count for working-line chips: 97, 1.2k, 10.8k, 3.4M. */
	private formatTokenChip(count: number): string {
		if (count < 1000) return count.toString();
		if (count < 1_000_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
		return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	}

	/** Output tokens accrued this turn: finalized assistant messages plus whatever
	 * the in-flight streaming message reports so far (partial until its own
	 * message_end lands the final count). */
	private currentTurnOutputTokens(): number {
		return this.turnOutputTokens + (this.streamingMessage?.usage?.output ?? 0);
	}

	/** Dim separator between working-loader meta chips (elapsed is separate). */
	private static readonly LOADER_META_SEP = " ·";

	/** Lazily computed, memoized `·<key> to interrupt` suffix fragment. See
	 * `cachedLoaderInterruptSuffix` for why this is worth memoizing. */
	private getLoaderInterruptSuffix(): string {
		if (this.cachedLoaderInterruptSuffix === null) {
			this.cachedLoaderInterruptSuffix = theme.fg(
				"dim",
				`${InteractiveMode.LOADER_META_SEP}${keyText("app.interrupt")} to interrupt`,
			);
		}
		return this.cachedLoaderInterruptSuffix;
	}

	/** Drop the memoized interrupt suffix so the next read recomputes it —
	 * called on a live theme or keybindings change. */
	private invalidateLoaderInterruptSuffix(): void {
		this.cachedLoaderInterruptSuffix = null;
	}

	private refreshLoaderTrailingSuffix(): void {
		if (!this.loadingAnimation) return;
		const interrupt = this.getLoaderInterruptSuffix();
		const outputTokens = this.currentTurnOutputTokens();
		const sep = InteractiveMode.LOADER_META_SEP;
		const tokens = outputTokens > 0 ? theme.fg("dim", `${sep}↑${this.formatTokenChip(outputTokens)}`) : "";
		const streamChars =
			this.streamTextCharCount > 0
				? theme.fg("dim", `${sep}↓${this.formatTokenChip(this.streamTextCharCount)}`)
				: "";
		const suffix = `${interrupt}${tokens}${streamChars}`;
		// Skip the Loader call entirely when nothing changed since the last applied
		// suffix — most message_update ticks land on an unchanged chip string.
		if (suffix === this.lastAppliedLoaderSuffix) return;
		this.lastAppliedLoaderSuffix = suffix;
		this.loadingAnimation.setTrailingSuffix(suffix);
	}

	private createWorkingLoader(): Loader {
		const loader = new Loader(
			this.ui,
			workingPulsePalette(),
			(text) => theme.fg("muted", text),
			this.getWorkingLoaderMessage(),
			reducedMotionLoaderIndicator(this.workingIndicatorOptions),
		);
		// A1: paint the phase label with the shared heartbeat shimmer. shimmerColorAt
		// self-fallbacks to a flat muted painter under no-truecolor / reduced motion.
		loader.setMessageColorAt((text, now) => shimmerColorAt(now)(text));
		// Show a per-turn elapsed counter. A fresh loader is built at each
		// agent_start (turn start) and lives until agent_end, so the clock
		// measures the whole turn rather than any single agent step.
		loader.setElapsedEnabled(true);
		this.resetStreamRateCounters();
		const interruptSuffix = this.getLoaderInterruptSuffix();
		loader.setTrailingSuffix(interruptSuffix);
		this.lastAppliedLoaderSuffix = interruptSuffix;
		// If a prompt is open while the loader is (re)built, carry the paused/relabeled
		// state onto the new instance so the clock stays frozen.
		if (this.userInputPauseDepth > 0) {
			loader.setMessage(this.userInputPauseMessage ?? this.awaitingUserInputMessage);
			loader.setElapsedPaused(true);
		}
		return loader;
	}

	private stopWorkingLoader(): void {
		if (this.fusionLive) {
			this.fusionLive.dispose();
			this.fusionLive = undefined;
		}
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.resetStreamRateCounters();
		this.clearStatusContainer();
	}

	private getWorkingLoaderElapsedMs(): number {
		const loader = this.loadingAnimation as { getElapsedMs?: unknown } | undefined;
		if (typeof loader?.getElapsedMs !== "function") {
			return 0;
		}
		return loader.getElapsedMs();
	}

	/** Tear down a live assistant stream block (overthink/TTSR mid-stream abort). */
	private disposeActiveStreamingComponent(): void {
		if (!this.streamingComponent) return;
		this.streamingComponent.dispose();
		if (this.streamingAttached) {
			this.chatContainer.removeChild(this.streamingComponent);
		}
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.streamingAttached = false;
	}

	/** Ephemeral turn-complete marker in the chat transcript (not persisted). */
	private appendTurnDoneLine(snapshot: ReturnType<typeof buildTurnDoneSnapshot>): void {
		const component = new TurnDoneMessageComponent(snapshot);
		component.setNoLeadingGap(true);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(component);
	}

	/**
	 * Whether the per-turn working loader should retire on `agent_end`.
	 *
	 * `Agent.isStreaming` stays true until awaited `agent_end` listeners settle
	 * (`finishRun()` runs after us), so gating only on `session.isBusy` left
	 * "Thinking…" stuck after every completed response. Keep the loader across
	 * auto-retry (willRetry) and post-run orchestration that is not the agent
	 * stream itself (goal drain, verification, pending checks, bash, fusion).
	 */
	private shouldRetireWorkingLoaderOnAgentEnd(willRetry: boolean): boolean {
		if (willRetry) return false;
		// Post-turn gates start AFTER agent_end; retiring here flashed "done" and
		// then spun up "Functional web check…" / npm verify again — and Esc could
		// not clear that spinner when the gate settled faster than the watchdog.
		if (this.session.hasPendingPostTurnWork) return false;
		if (this.session.isStreaming) return true;
		return !this.session.isBusy;
	}

	/** Stop the working loader and flush a deferred turn-done line, if any. */
	private settleWorkingLoaderAfterPrompt(): void {
		this.clearInterruptWatchdog();
		const deferred = this.deferredTurnDone;
		this.deferredTurnDone = null;
		if (this.loadingAnimation) {
			this.stopWorkingLoader();
		}
		if (deferred && this.session.orchestration !== "fusion") {
			this.appendTurnDoneLine(deferred);
		}
		this.ui.requestRender();
	}

	private ensureFusionLive(): void {
		if (!this.fusionLive) {
			this.stopWorkingLoader();
			this.fusionLive = new FusionLiveComponent(this.ui);
			this.statusContainer.addChild(this.fusionLive);
			this.footer.setFusionLiveActive(true);
		}
	}

	private disposeFusionLive(): void {
		if (this.fusionLive) {
			this.fusionLive.dispose();
			this.fusionLive = undefined;
			this.footer.setFusionLiveActive(false);
			this.clearStatusContainer();
		}
		// If Fusion was mid-writer (compact strip still up), clear the flag on dispose
		// so an interrupt (Esc) that never reaches message_start doesn't leave a stale
		// writer-active state. Scoped by the flag so a normal turn's working loader is
		// never touched here.
		if (this._fusionWriterLoaderActive) {
			this._fusionWriterLoaderActive = false;
		}
	}

	private setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
		if (!visible) {
			this.stopWorkingLoader();
			this.ui.requestRender();
			return;
		}
		if (this.session.isStreaming && !this.loadingAnimation) {
			this.clearStatusContainer();
			this.loadingAnimation = this.createWorkingLoader();
			this.statusContainer.addChild(this.loadingAnimation);
		}
		this.ui.requestRender();
	}

	private setWorkingIndicator(options?: LoaderIndicatorOptions): void {
		this.workingIndicatorOptions = options;
		this.loadingAnimation?.setIndicator(reducedMotionLoaderIndicator(options));
		this.ui.requestRender();
	}

	/**
	 * Mark the turn as blocked on the user (a picker, permission/extension confirm,
	 * or custom overlay is up): freeze the working clock and relabel the loader, so
	 * the running timer + cost don't pressure the user mid-decision. Reference-
	 * counted — overlapping prompts (e.g. an `ask` that opens via a selector) hold
	 * the pause until the last one closes; the first holder's message wins. Returns
	 * an idempotent release fn; call it when the prompt resolves.
	 */
	private beginUserInputWait(message: string): () => void {
		this.userInputPauseDepth++;
		if (this.userInputPauseDepth === 1) {
			this.userInputPauseMessage = message;
			this.applyUserInputPause(true);
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.userInputPauseDepth = Math.max(0, this.userInputPauseDepth - 1);
			if (this.userInputPauseDepth === 0) {
				this.userInputPauseMessage = null;
				this.applyUserInputPause(false);
			}
		};
	}

	private applyUserInputPause(paused: boolean): void {
		if (!this.loadingAnimation) return;
		if (paused) {
			this.loadingAnimation.setElapsedPaused(true);
			this.loadingAnimation.setMessage(this.userInputPauseMessage ?? this.awaitingUserInputMessage);
		} else {
			this.loadingAnimation.setMessage(this.getWorkingLoaderMessage());
			this.loadingAnimation.setElapsedPaused(false);
		}
		this.ui.requestRender();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		if (this.streamingComponent) {
			this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		this.ui.requestRender();
	}

	/**
	 * Set an extension widget (string array or custom component).
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "… (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.autocompleteProviderWrappers = [];
		this.setCustomEditorComponent(undefined);
		this.setupAutocompleteProvider();
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		this.workingMessage = undefined;
		this.workingVisible = true;
		this.setWorkingIndicator();
		this.setHiddenThinkingLabel();
	}

	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Render all extension widgets to the widget container.
	 */
	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		// Remove current footer from UI
		if (this.customFooter) {
			this.ui.removeChild(this.customFooter);
		} else {
			this.ui.removeChild(this.footer);
		}

		if (factory) {
			// Create and add custom footer, passing the data provider
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.ui.addChild(this.customFooter);
		} else {
			// Restore built-in footer
			this.customFooter = undefined;
			this.ui.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.ui, theme);
			if (isExpandable(this.customHeader)) {
				this.customHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (isExpandable(this.builtInHeader)) {
				this.builtInHeader.setExpanded(this.startupHeaderExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const unsubscribe = this.ui.addInputListener(handler);
		this.extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.extensionTerminalInputUnsubscribers.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				this.workingMessage = message;
				if (this.loadingAnimation) {
					this.loadingAnimation.setMessage(message ?? this.defaultWorkingMessage);
				}
			},
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviderWrappers.push(factory);
				this.setupAutocompleteProvider();
			},
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					setThemeInstance(themeOrName);
					this.ui.requestRender();
					return { success: true };
				}
				const result = setTheme(themeOrName, true);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
					this.ui.requestRender();
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		// Blocks the turn on the user (permission/extension confirm) → freeze the clock.
		const releaseWait = this.beginUserInputWait(this.userWaitMessage);
		return new Promise<string | undefined>((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout, onToggleToolsExpanded: () => this.toggleToolOutputExpansion() },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();
		}).finally(releaseWait);
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		// Blocks the turn on the user (extension text prompt) → freeze the clock.
		const releaseWait = this.beginUserInputWait(this.userWaitMessage);
		return new Promise<string | undefined>((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();
		}).finally(releaseWait);
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;

		// Save text from current editor before switching
		const currentText = this.editor.getText();

		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor as Component);
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		// Blocks the turn on the user (custom overlay / dialog) → freeze the clock.
		const releaseWait = this.beginUserInputWait(this.userWaitMessage);
		return new Promise<T>((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		}).finally(releaseWait);
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	/** Pending tools the user could cancel individually (id + display name). */
	private getInterruptiblePendingTools(): Array<{ id: string; name: string }> {
		const out: Array<{ id: string; name: string }> = [];
		for (const [id, component] of this.pendingTools) {
			out.push({ id, name: component.getToolName() });
		}
		return out;
	}

	/**
	 * Esc with tools in flight: ask whether to stop the whole task (default) or
	 * cancel a single tool. Reuses the ask-options overlay. Any cancel / timeout /
	 * empty answer falls back to stopping the whole task, so Esc never gets stuck.
	 */
	private async promptInterruptChoice(tools: Array<{ id: string; name: string }>): Promise<void> {
		const STOP_ALL = "Parar a tarefa inteira";
		const labelToId = new Map<string, string>();
		const options: Array<{ label: string; recommended?: boolean }> = [{ label: STOP_ALL, recommended: true }];
		tools.forEach((t, i) => {
			const label = tools.length > 1 ? `Cancelar só: ${t.name} (#${i + 1})` : `Cancelar só: ${t.name}`;
			labelToId.set(label, t.id);
			options.push({ label });
		});

		let picked: string | undefined;
		try {
			const answer = await this.userInputBus.askOptions({
				question: "Interromper o quê?",
				header: "Interromper",
				options,
				source: { toolName: "interrupt" },
			});
			picked = answer.picked[0];
		} catch {
			picked = undefined;
		}

		if (!picked || picked === STOP_ALL) {
			this.restoreQueuedMessagesToEditor();
			this.session.interrupt();
			// Same as the bare-Esc path: a Fusion turn has no agent_end, so dispose
			// its live strip + ticker explicitly when the whole task is stopped.
			this.disposeFusionLive();
			this.deferredTurnDone = null;
			this.stopWorkingLoader();
			this.showStatus("Interrupted");
			this.armInterruptWatchdog();
			return;
		}
		const id = labelToId.get(picked);
		if (!id) return;
		const cancelled = this.session.cancelTool(id);
		const tool = tools.find((t) => t.id === id);
		this.showStatus(cancelled ? `Cancelled ${tool?.name ?? "tool"}` : "Tool already finished");
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			if (this.session.isBusy) {
				// Per-tool interruption: when tools are in flight, offer a choice
				// between stopping the WHOLE task (default — current turn + goal
				// auto-continuation + verification gate + in-flight bash + retry
				// backoff) and cancelling just one tool. With nothing granular in
				// flight, Esc stops the whole task immediately, as before. Queued
				// messages are returned to the editor so the user doesn't lose them.
				const interruptible = this.getInterruptiblePendingTools();
				if (interruptible.length === 0) {
					this.restoreQueuedMessagesToEditor();
					this.session.interrupt();
					// A Fusion turn returns before agent_end, so its live strip + ticker
					// would leak when the user aborts mid-run. Tear it down explicitly.
					this.disposeFusionLive();
					// showStatus alone does not stop the working loader — without this,
					// Esc during verification left "Functional web check…" spinning after
					// the gate aborted (watchdog no-ops once isBusy clears).
					this.deferredTurnDone = null;
					this.stopWorkingLoader();
					this.showStatus("Interrupted");
					this.armInterruptWatchdog();
				} else {
					void this.promptInterruptChoice(interruptible);
				}
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				const goal = this.session.goalSnapshot();
				if (goal?.status === "active" && !this.session.goalIsDriving()) {
					this.session.pauseGoal();
					this.showStatus(this.session.goalSummaryText());
					return;
				}
				// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						if (action === "tree") {
							this.showTreeSelector();
						} else {
							this.showUserMessageSelector();
						}
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("app.thinking.cycle", () => this.cycleThinkingLevel());
		this.defaultEditor.onAction("app.model.cycleForward", () => this.cycleModel("forward"));
		this.defaultEditor.onAction("app.model.cycleBackward", () => this.cycleModel("backward"));
		this.defaultEditor.onAction("app.permission.cycle", () => this.cyclePermissionMode());

		// Global debug handler on TUI (works regardless of focus)
		this.ui.onDebug = () => this.handleDebugCommand();
		this.defaultEditor.onAction("app.model.select", () => this.showModelSelector());
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("app.editor.external", () => this.openExternalEditor());
		this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());
		this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
		this.defaultEditor.onAction("app.session.tree", () => this.showTreeSelector());
		this.defaultEditor.onAction("app.session.fork", () => this.showUserMessageSelector());
		this.defaultEditor.onAction("app.session.resume", () => this.showSessionSelector());

		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = /^\s*!/.test(text);
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};

		// Handle clipboard image paste (triggered on Ctrl+V)
		this.defaultEditor.onPasteImage = () => {
			this.handleClipboardImagePaste();
		};

		// Global cheatsheet trigger (Ctrl+/ by default). A bare `?` types a literal
		// char while the prompt is focused, so the cheatsheet uses a dedicated
		// non-conflicting keybinding handled before any focused component sees it.
		const cheatsheetUnsub = this.ui.addInputListener((data) => {
			if (this.cheatsheetOpen) return undefined;
			if (getKeybindings().matches(data, "tui.help.cheatsheet")) {
				this.showCheatsheet();
				return { consume: true };
			}
			return undefined;
		});
		this.signalCleanupHandlers.push(cheatsheetUnsub);
	}

	/** Open the keybinding cheatsheet as a centered overlay. */
	private showCheatsheet(): void {
		if (this.cheatsheetOpen) return;
		this.cheatsheetOpen = true;
		const cheatsheetTheme = {
			title: (text: string) => theme.bold(theme.fg("accent", text)),
			keys: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("text", text),
			hint: (text: string) => theme.fg("dim", text),
		};
		void this.showExtensionCustom<void>(
			(_tui, _theme, _kb, done) => new Cheatsheet(cheatsheetTheme, () => done(undefined)),
			{
				overlay: true,
				overlayOptions: { width: "60%", maxHeight: "80%", anchor: "center" },
			},
		).finally(() => {
			this.cheatsheetOpen = false;
		});
	}

	private async handleClipboardImagePaste(): Promise<void> {
		let image: ClipboardImage | null;
		try {
			image = await readClipboardImage();
		} catch {
			image = null;
		}
		if (!image) {
			// No image on the clipboard (or the read failed). Tell the user instead
			// of silently doing nothing, which reads as "paste is broken".
			this.showWarning("No image found on the clipboard.");
			return;
		}

		// Attach the image as a real ImageContent block on the NEXT prompt. The
		// agent merges attached images into whatever text the user submits, so the
		// model receives an actual image (not a temp-file path as text).
		// readClipboardImage already normalizes unsupported formats to PNG, so the
		// mimeType is always one the Anthropic API accepts.
		const base64 = Buffer.from(image.bytes).toString("base64");
		this.session.attachImages([{ type: "image", data: base64, mimeType: image.mimeType }]);

		// Visible marker so the user can see the attachment landed.
		const index = this.session.getAttachedImageCount();
		this.editor.insertTextAtCursor?.(`[Image #${index}] `);
		this.ui.requestRender();
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			text = text.trim();
			if (!text) return;

			// Any real submission dismisses ephemeral status/hints.
			this.clearEphemeralStatus();
			this.clearCtrlCHint();
			// The welcome screen is no longer the focus: from now on the expand key
			// toggles tool output, not the startup help.
			this.welcomeActive = false;
			this.updateEmptyStateHint();

			// Inline `/chrome` modifier: works anywhere in the message (text before
			// and/or after it). Ensures Chrome is up, then runs the rest as a prompt.
			const chrome = extractChromeCommand(text);
			if (chrome.matched) {
				await this._handleChromeCommand(chrome.rest);
				return;
			}

			// Slash command dispatch
			if (text.startsWith("/")) {
				const handled = await this._dispatchSlashCommand(text);
				if (handled) return;
				// A typo'd "/command" must not be silently sent to the model: warn,
				// suggest the closest match, and keep the text for correction.
				if (this._warnIfUnknownCommand(text)) return;
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.session.isBashRunning) {
						this.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.editor.setText(text);
						return;
					}
					this.editor.addToHistory?.(text);
					await this.handleBashCommand(command, isExcluded);
					this.isBashMode = false;
					this.updateEditorBorderColor();
					return;
				}
			}

			// Queue input during compaction (extension commands execute immediately)
			if (this.session.isCompacting) {
				if (this.isExtensionCommand(text)) {
					this.editor.addToHistory?.(text);
					this.editor.setText("");
					await this.session.prompt(text);
				} else {
					this.queueCompactionMessage(text, "steer");
				}
				return;
			}

			// If streaming, use prompt() with steer behavior
			if (this.session.isStreaming) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text, { streamingBehavior: "steer" });
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				return;
			}

			// Normal message submission
			this.flushPendingBashComponents();

			// Show the working indicator in the SAME frame as the submit so there is
			// no dead gap before agent_start fires and the first token streams in.
			// agent_start reuses this loader instead of rebuilding it (no clock reset).
			if (this.workingVisible && !this.loadingAnimation) {
				this.clearStatusContainer();
				this.loadingAnimation = this.createWorkingLoader();
				this.statusContainer.addChild(this.loadingAnimation);
				this.setWorkingPhase("Thinking…");
				this.ui.requestRender();
			}

			this.editor.addToHistory?.(text);
			if (this.onInputCallback) {
				this.onInputCallback(text);
			}
			try {
				await this.session.prompt(text);
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		};
	}

	/**
	 * Warn and recover when the user submits a "/command" that matches no known
	 * command, instead of silently forwarding it to the model as a prompt. Only
	 * fires for a clean "/word" token (letters/digits/_/:/-), so a path like
	 * "/usr/bin" or arbitrary text starting with "/" still goes through. Returns
	 * true when it handled (warned about) the input.
	 */
	private _warnIfUnknownCommand(text: string): boolean {
		const match = text.match(/^\/([A-Za-z0-9_:-]+)(?:\s|$)/);
		if (!match) return false;
		const name = match[1];
		if (this._knownCommandNames.has(name)) return false;
		const suggestion = suggestClosest(name, [...this._knownCommandNames], {
			maxDistance: 3,
			prefixMinOverlap: 3,
		});
		const hint = suggestion ? ` Did you mean /${suggestion}?` : "";
		this.showWarning(`Unknown command: /${name}.${hint}`);
		this.editor.setText(text);
		return true;
	}

	/**
	 * Dispatch slash commands. Commands with arguments use startsWith;
	 * exact-match commands use a lookup table.
	 * @returns true if a command was handled
	 */
	private _slashCommandHost(): SlashCommandHost {
		return {
			clearEditor: () => {
				this.editor.setText("");
			},
			handleModelCommand: (searchTerm) => this.handleModelCommand(searchTerm),
			handleFusionCommand: () => this.handleFusionCommand(),
			handleNameCommand: (line) => this.handleNameCommand(line),
			handleCompactCommand: (instructions) => this.handleCompactCommand(instructions),
			handleTTSRCommand: (args) => this.handleTTSRCommand(args),
			handleHindsightCommand: (args) => this.handleHindsightCommand(args),
			handleGoalCommand: (args) => this.handleGoalCommand(args),
			showStatus: (line) => this.showStatus(line),
			getTodoSummaryText: () => this.session.todoSummaryText(),
			showSettingsSelector: () => this.showSettingsSelector(),
			handleSessionCommand: () => this.handleSessionCommand(),
			handleCacheStatusCommand: () => this.handleCacheStatusCommand(),
			handleDiagnosticsCommand: () => this.handleDiagnosticsCommand(),
			handleHelpCommand: () => this.handleHelpCommand(),
			handleHotkeysCommand: () => this.handleHotkeysCommand(),
			showOAuthSelector: (mode) => this.showOAuthSelector(mode),
			handleClearCommand: () => this.handleClearCommand(),
			handleReloadCommand: () => this.handleReloadCommand(),
			handleSkillsCommand: (args) => this.handleSkillsCommand(args),
			handleDebugCommand: () => this.handleDebugCommand(),
			handleArminSaysHi: () => this.handleArminSaysHi(),
			handleDementedDelves: () => this.handleDementedDelves(),
			showSessionSelector: () => this.showSessionSelector(),
			shutdown: () => this.shutdown(),
			isSessionBusy: () => this.session.isBusy || this.session.isCompacting,
			isExtensionCommand: (line) => this.isExtensionCommand(line),
			addEditorHistory: (line) => {
				this.editor.addToHistory?.(line);
			},
			promptExtensionCommand: (line) => this.session.prompt(line),
		};
	}

	private async _dispatchSlashCommand(text: string): Promise<boolean> {
		return dispatchSlashCommand(this._slashCommandHost(), text);
	}

	/**
	 * `/goal` — autonomous goal mode. A bare `/goal` opens the interactive panel
	 * (objective input when no goal exists, action picker otherwise — mirrors the
	 * Claude Code `/goal` UI command). Typed subcommands remain for muscle
	 * memory/scripts: status, pause, resume, clear, edit <obj>, --tokens
	 * <budget> <obj> (raise an existing goal's budget when no objective follows,
	 * else start with a budget), or a bare <objective> to start.
	 */
	private async handleGoalCommand(args: string): Promise<void> {
		const trimmed = args.trim();
		if (trimmed === "") {
			await this.showGoalPanel();
			return;
		}
		const parts = trimmed.split(/\s+/);
		const sub = parts[0] ?? "";
		switch (sub) {
			case "status":
				this.showStatus(this.session.goalSummaryText());
				return;
			case "pause":
				this.session.pauseGoal();
				this.showStatus(this.session.goalSummaryText());
				return;
			case "resume":
				this.session.resumeGoal();
				this.showStatus(this.session.goalSummaryText());
				if (this.session.goalShouldAutoContinue()) {
					this._startGoalSpinner();
					await this.session.prompt("Resume working toward the goal.", { expandPromptTemplates: false });
				}
				return;
			case "clear":
				this.session.clearGoal();
				this.showStatus("🎯 Goal cleared.");
				return;
			case "edit": {
				const objective = parts.slice(1).join(" ").trim();
				if (!objective) {
					this.showWarning("Usage: /goal edit <new objective>");
					return;
				}
				this.session.editGoal(objective);
				this.showStatus(this.session.goalSummaryText());
				return;
			}
		}

		// Start a new goal, optionally with a token budget.
		let objective = trimmed;
		let tokenBudget: number | undefined;
		let budgetLabel = "";
		if (sub === "--tokens") {
			const budgetStr = parts[1] ?? "";
			const parsed = parseTokenBudget(budgetStr);
			if (parsed === undefined) {
				this.showWarning(`Invalid token budget: "${budgetStr}". Use e.g. 100k or 1.5m.`);
				return;
			}
			tokenBudget = parsed;
			budgetLabel = ` (budget ${budgetStr})`;
			objective = parts.slice(2).join(" ").trim();
			// `/goal --tokens <n>` with no objective raises the EXISTING goal's
			// budget (the only way to lift a budget_limited goal) instead of
			// discarding it. Falls through to the usage warning when no goal exists.
			if (!objective) {
				const current = this.session.goalSnapshot();
				if (current && current.status !== "complete") {
					this.session.setGoalTokenBudget(parsed);
					this.showStatus(this.session.goalSummaryText());
					if (this.session.goalShouldAutoContinue()) {
						this._startGoalSpinner();
						await this.session.prompt("Resume working toward the goal.", { expandPromptTemplates: false });
					}
					return;
				}
			}
		}
		if (!objective) {
			this.showWarning("Usage: /goal <objective> | edit <obj> | pause | resume | clear | --tokens <budget> <obj>");
			return;
		}

		// Confirm before discarding an in-progress goal (reuses the ask picker).
		const existing = this.session.goalSnapshot();
		if (existing && existing.status !== "complete") {
			const answer = await this.userInputBus.askOptions({
				question: `Replace the current goal? (${existing.objective})`,
				header: "goal",
				options: [
					{ label: "Replace", description: "Discard the current goal and start this one", recommended: true },
					{ label: "Keep current", description: "Cancel and keep the existing goal" },
				],
				source: { toolName: "goal" },
			});
			if (answer.cancelled || answer.picked[0] !== "Replace") {
				this.showStatus("Kept the current goal.");
				return;
			}
		}

		this.session.startGoal(objective, { tokenBudget });
		this.showStatus(`🎯 Goal started${budgetLabel}: ${objective}`);
		this._startGoalSpinner();
		await this.session.prompt(objective);
	}

	/**
	 * The interactive `/goal` panel (no-args path). Flow lives in
	 * goal-dialog.ts; this only binds the host to the live session/UI.
	 */
	private showGoalPanel(): Promise<void> {
		return runGoalDialog({
			goalSnapshot: () => this.session.goalSnapshot(),
			goalSummaryText: () => this.session.goalSummaryText(),
			goalShouldAutoContinue: () => this.session.goalShouldAutoContinue(),
			startGoal: (objective, opts) => void this.session.startGoal(objective, opts),
			editGoal: (objective) => this.session.editGoal(objective),
			pauseGoal: () => this.session.pauseGoal(),
			resumeGoal: () => this.session.resumeGoal(),
			clearGoal: () => this.session.clearGoal(),
			setGoalTokenBudget: (tokenBudget) => this.session.setGoalTokenBudget(tokenBudget),
			promptInput: (title, placeholder) => this.showExtensionInput(title, placeholder),
			pickOption: async (question, options) => {
				const answer = await this.userInputBus.askOptions({
					question,
					header: "goal",
					options,
					source: { toolName: "goal" },
				});
				return answer.cancelled || answer.picked.length === 0 ? undefined : answer.picked[0];
			},
			showStatus: (text) => this.showStatus(text),
			showWarning: (text) => this.showWarning(text),
			startGoalSpinner: () => this._startGoalSpinner(),
			prompt: (text, opts) => this.session.prompt(text, opts),
		});
	}

	/**
	 * Request a render via the shared animation ticker (~12fps) while a goal is
	 * active so the footer spinner animates smoothly even between autonomous turns.
	 * (The todo overlay spinner animates via the natural renders that happen while
	 * the agent is actually working, and stays static when idle — which is the
	 * honest signal.) Idempotent; auto-stops once the goal is no longer active.
	 */
	private _startGoalSpinner(): void {
		if (this._goalSpinnerUnsub) return;
		const goal = this.session.goalSnapshot();
		if (goal?.status !== "active") return;
		this._goalSpinnerBucket = -1;
		this._goalSpinnerUnsub = this.ui.addAnimationCallback((now) => {
			if (this.session.goalSnapshot()?.status !== "active") {
				this._stopGoalSpinner();
				return false;
			}
			// Only ask for a render when the 80ms spinner frame would actually
			// change, not on every animation frame.
			const bucket = Math.floor(now / SPINNER_FRAME_MS);
			if (bucket === this._goalSpinnerBucket) return false;
			this._goalSpinnerBucket = bucket;
			return true;
		});
	}

	private _stopGoalSpinner(): void {
		this._goalSpinnerUnsub?.();
		this._goalSpinnerUnsub = undefined;
	}

	/**
	 * `/chrome` (anywhere in the message): ensure Chrome is up, then run the rest
	 * of the message (if any) as a normal prompt so the agent uses the browser.
	 */
	private async _handleChromeCommand(rest: string): Promise<void> {
		this.editor.setText("");
		this.showStatus("🌐 Starting Chrome…");
		const status = await this.session.ensureChrome();
		this.showStatus(status);
		if (rest) {
			await this.session.prompt(rest);
		}
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.session.subscribe(async (event) => {
			await this.handleEvent(event);
		});
		// Live bridge for grave runtime guards (error level only, to avoid noise);
		// info/warn stay queryable via /diagnostics. Unsubscribed in stop().
		this.diagnosticsUnsubscribe?.();
		this.diagnosticsUnsubscribe = onDiagnostic((event: DiagnosticEvent) => {
			if (event.category === "stream.overthink-guard") {
				this.footer.invalidate();
				this.ui.requestRender();
			}
			if (event.level !== "error") return;
			this.showWarning(`⚠ runtime: ${event.category} (${event.source})`);
		});
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}
		// NOTE: do NOT invalidate the footer here — cumulative-usage totals are
		// derived from session entries and only need a refresh when entries
		// actually change (message_end with role=assistant, compaction_end,
		// session swap). Identity fields (model, thinking level, branch, name)
		// are read fresh from state on every render and don't need an explicit
		// cache reset; relevant call sites already invalidate where needed.

		switch (event.type) {
			case "agent_start":
				// Tear down any live Fusion strip first. The both-failed→solo fallback
				// runs a normal turn that emits agent_start; without this the panel
				// strip from the aborted Fusion run would be orphaned in the status band
				// (the Fusion turn returns before agent_end). Idempotent.
				this.disposeFusionLive();
				this.deferredTurnDone = null;
				this.pendingTools.clear();
				this.activityStacker.reset();
				this.lastAssistantComponent = null;
				this.turnAssistantComponents = [];
				this.turnOutputTokens = 0;
				this.streamingAttached = false;
				this.setTerminalProgress(true);
				this._cleanupRetryUI();
				// Reuse the loader created at submit (gap-morto) so the elapsed clock
				// starts at Enter without a reset/flicker; build one only if missing
				// (e.g. a continuation turn after a prior loader was cleared).
				if (this.workingVisible && !this.loadingAnimation) {
					this.clearStatusContainer();
					this.loadingAnimation = this.createWorkingLoader();
					this.statusContainer.addChild(this.loadingAnimation);
				}
				this.setWorkingPhase("Thinking…");
				this.ui.requestRender();
				break;

			case "queue_update":
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				break;

			case "session_info_changed":
				this.updateTerminalTitle();
				this.footer.invalidate();
				this.ui.requestRender();
				break;

			case "thinking_level_changed":
				this.refreshModelIndicators();
				break;

			case "fusion_member": {
				this.ensureFusionLive();
				const member: FusionLiveMember = {
					index: event.index,
					cli: event.cli,
					model: event.model,
					status: event.status,
					elapsedMs: event.elapsedMs,
					timeoutMs: event.timeoutMs,
					chars: event.chars,
					error: event.error,
				};
				// upsertMember already calls ui.requestRender() internally.
				this.fusionLive?.upsertMember(member);
				break;
			}

			case "fusion_member_activity":
				// recordActivity already calls ui.requestRender() internally.
				this.fusionLive?.recordActivity(event.index, event.kind, event.tool, event.text);
				break;

			case "fusion_verify_activity":
				// recordVerifyActivity already calls ui.requestRender() internally.
				this.fusionLive?.recordVerifyActivity(event.turn, event.tool);
				break;

			case "fusion_stage":
				if (event.stage === "writer") {
					// Keep the Fusion strip with a compact synthesizing header so the
					// hand-off stays in-context (no swap to a generic loader).
					this.ensureFusionLive();
					this.fusionLive?.setSynth(event.synthId);
					this.fusionLive?.setStage("writer");
					this._fusionWriterLoaderActive = true;
					this.ui.requestRender();
				} else {
					this.ensureFusionLive();
					// setSynth/setStage early-return when the value is unchanged, so on a
					// freshly created strip (default stage "brief", synthId "") neither
					// may render — keep an explicit render to guarantee the create-time paint.
					this.fusionLive?.setSynth(event.synthId);
					this.fusionLive?.setStage(event.stage);
					this.ui.requestRender();
				}
				break;

			case "message_start":
				switch (event.message.role) {
					case "custom":
						this.addMessageToChat(event.message);
						break;
					case "user":
						this.addMessageToChat(event.message);
						this.updatePendingMessagesDisplay();
						break;
					case "assistant":
						// Fusion writer hand-off: retire the compact Fusion strip the moment
						// the writer's stream owns the frame. Flag-gated so normal turns keep
						// their working loader.
						if (this._fusionWriterLoaderActive) {
							this._fusionWriterLoaderActive = false;
							this.disposeFusionLive();
						}
						this.disposeActiveStreamingComponent();
						this.streamingComponent = new AssistantMessageComponent(
							undefined,
							this.hideThinkingBlock,
							this.getMarkdownThemeWithSettings(),
							this.hiddenThinkingLabel,
							this.ui,
							this.settingsManager.getStreamingSmoothing(),
							this.settingsManager.getAssistantReadingColumns(),
							this.session.thinkingLevel,
						);
						this.streamingMessage = event.message;
						// Grouped mode defers chat attach until visible prose exists.
						// Keep the reveal cursor frozen until then so text cannot catch
						// up off-screen and dump on first paint.
						if (this.settingsManager.getToolActivity() === "grouped") {
							this.streamingComponent.setStreamVisible(false);
						}
						this.streamingComponent.updateContent(this.streamingMessage);
						// Grouped mode: defer attaching the message block until it has
						// visible content. A thinking-only message that only runs tools
						// never attaches, so its tools keep folding into one group and no
						// "Thinking…" block splits the run. Legacy attaches immediately.
						if (this.settingsManager.getToolActivity() === "grouped") {
							this.streamingAttached = false;
							this.maybeAttachStreamingComponent();
						} else {
							this.chatContainer.addChild(this.streamingComponent);
							this.streamingAttached = true;
						}
						break;
				}
				this.ui.requestRender();
				break;

			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.streamingComponent.updateContent(this.streamingMessage);
					if (this.streamingAttached) {
						this.chatContainer.markChildStale(this.streamingComponent);
					}

					if (this.settingsManager.getToolActivity() === "grouped") {
						this.maybeAttachStreamingComponent();
					}

					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							if (this.pendingTools.has(content.id)) {
								this.pendingTools.get(content.id)!.updateArgs(content.arguments);
							} else {
								this._ensureToolComponent(content.name, content.id, content.arguments);
							}
						}
					}
					this.streamTextCharCount = this.countAssistantTextChars(this.streamingMessage);
					this.refreshLoaderTrailingSuffix();
					this.ui.requestRender();
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (event.message.role === "assistant" && isStreamGuardAbortMessage(event.message)) {
					this.disposeActiveStreamingComponent();
					break;
				}
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					let errorMessage: string | undefined;
					if (this.streamingMessage.stopReason === "aborted") {
						errorMessage = this._abortedErrorMessage(this.session.retryAttempt);
						this.streamingMessage.errorMessage = errorMessage;
					}
					this.streamingComponent.updateContent(this.streamingMessage);

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						if (!errorMessage) {
							errorMessage = this.streamingMessage.errorMessage || "Error";
						}
						for (const component of this.pendingTools.values()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.pendingTools.clear();
					} else {
						// Args are now complete - trigger diff computation for edit tools
						for (const component of this.pendingTools.values()) {
							component.setArgsComplete();
						}
					}
					// Track the last assistant component that has visible text so that
					// agent_end can mark the right one as deliverable (a trailing
					// thinking-only or tool-only message must not displace it).
					if (messageHasVisibleContent(this.streamingMessage, false)) {
						this.lastAssistantComponent = this.streamingComponent;
						if (this.turnAssistantComponents.at(-1) !== this.streamingComponent) {
							this.turnAssistantComponents.push(this.streamingComponent);
						}
					}
					// This message is settled (stopReason known, no further deltas): release
					// its Markdown blocks' streaming/lex caches, keeping only the final
					// render cache. Deferred inside the component until its final render has
					// run (smoothing can reveal the tail a few frames after message_end).
					this.streamingComponent.freeze();
					// Fold this now-finalized message's output tokens into the turn total
					// before clearing the streaming ref (currentTurnOutputTokens reads it).
					this.turnOutputTokens += this.streamingMessage.usage?.output ?? 0;
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.footer.invalidate();
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				const component = this._ensureToolComponent(event.toolName, event.toolCallId, event.args);
				component.markExecutionStarted();
				this.setWorkingPhase(workingPhaseLabel(event.toolName, event.args as Record<string, unknown>, true));
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
					// Back to the neutral phase once the last in-flight tool settles
					// (parallel tools keep their "Running …" label until all finish).
					if (this.pendingTools.size === 0) {
						this.setWorkingPhase("Thinking…");
					}
					if (!event.isError && MUTATING_TOOLS_FOR_DIFF_REFRESH.has(event.toolName)) {
						this.footerDataProvider.scheduleWorkingTreeRefresh();
					}
					this.ui.requestRender();
				}
				break;
			}

			case "agent_end":
				this.setTerminalProgress(false);
				this.clearInterruptWatchdog();
				this.disposeFusionLive();
				if (this.shouldRetireWorkingLoaderOnAgentEnd(event.willRetry)) {
					const elapsedMs = this.getWorkingLoaderElapsedMs();
					this.stopWorkingLoader();
					this.deferredTurnDone = null;
					if (this.session.orchestration !== "fusion") {
						this.appendTurnDoneLine(
							buildTurnDoneSnapshot(event.messages, elapsedMs, this.session.getContextUsage() ?? undefined),
						);
					}
				} else if (!event.willRetry && this.session.orchestration !== "fusion") {
					// Defer the done line until prompt_end so verification / pending
					// checks don't flash "done" under a still-running spinner.
					this.deferredTurnDone = buildTurnDoneSnapshot(
						event.messages,
						this.getWorkingLoaderElapsedMs(),
						this.session.getContextUsage() ?? undefined,
					);
				}
				this.disposeActiveStreamingComponent();
				for (const component of this.pendingTools.values()) {
					component.dispose();
				}
				this.pendingTools.clear();

				if (this.settingsManager.getToolActivity() === "grouped") {
					const deliverable = this.lastAssistantComponent;
					deliverable?.markAsDeliverable();
					// Dim the turn's earlier (non-deliverable) prose so the final answer
					// stands out — the 3-tier hierarchy: thinking < narration < deliverable.
					for (const component of this.turnAssistantComponents) {
						if (component !== deliverable) component.markAsNarration();
					}
				}

				if (!event.willRetry) {
					this.maybeShowPowerTip();
				}

				await this.checkShutdownRequested();

				this.ui.requestRender();
				break;

			case "prompt_end":
				this.settleWorkingLoaderAfterPrompt();
				break;

			case "compaction_start": {
				this.setTerminalProgress(true);
				// Keep editor active; submissions are queued during compaction.
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortCompaction();
				};
				this.clearStatusContainer();
				const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
				const label =
					event.reason === "manual"
						? `Compacting context… ${cancelHint}`
						: `${event.reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting… ${cancelHint}`;
				this.autoCompactionLoader = new Loader(
					this.ui,
					workingPulsePalette(),
					(text) => theme.fg("muted", text),
					label,
					reducedMotionLoaderIndicator(),
				);
				this.statusContainer.addChild(this.autoCompactionLoader);
				this.ui.requestRender();
				break;
			}

			case "compaction_end": {
				this.setTerminalProgress(false);
				if (this.autoCompactionEscapeHandler) {
					this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				if (this.autoCompactionLoader) {
					this.autoCompactionLoader.stop();
					this.autoCompactionLoader = undefined;
					this.clearStatusContainer();
				}
				if (event.aborted) {
					if (event.reason === "manual") {
						this.showError("Compaction cancelled");
					} else {
						this.showStatus("Auto-compaction cancelled");
					}
				} else if (event.result) {
					// rebuildChatFromMessages() disposes + clears; no redundant clear here
					// (a bare clear would orphan a pending row's spinner ticker).
					this.rebuildChatFromMessages();
					this.addMessageToChat(
						createCompactionSummaryMessage(
							event.result.summary,
							event.result.tokensBefore,
							new Date().toISOString(),
						),
					);
					this.footer.invalidate();
				} else if (event.errorMessage) {
					if (event.reason === "manual") {
						this.showError(event.errorMessage);
					} else {
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
					}
				}
				void this.flushCompactionQueue({ willRetry: event.willRetry });
				this.ui.requestRender();
				break;
			}

			case "visual_review": {
				this.showStatus(`Changed ${event.file} — verify it visually with the preview tool.`);
				this.ui.requestRender();
				break;
			}

			case "functional_web": {
				this.setTerminalProgress(event.phase === "running");
				if (event.phase === "running") {
					const label =
						event.attempt > 1
							? `Functional web check${event.url ? ` (${event.url})` : ""} — attempt ${event.attempt}…`
							: `Functional web check${event.url ? ` (${event.url})` : ""}…`;
					if (this.workingVisible && !this.loadingAnimation) {
						this.clearStatusContainer();
						this.loadingAnimation = this.createWorkingLoader();
						this.statusContainer.addChild(this.loadingAnimation);
					}
					this.setWorkingPhase(label);
				} else if (event.phase === "passed") {
					this.setWorkingPhase(`✓ Functional web check passed${event.url ? ` — ${event.url}` : ""}`);
				} else if (event.phase === "skipped") {
					// Silent skip in TUI — fail-open paths (no Chrome / not web) should not alarm.
					// Keep the loader; prompt_end retires it with the deferred turn-done line.
				} else if (event.willRetry) {
					this.setWorkingPhase("✗ Functional web check failed — fixing…");
				} else {
					this.stopWorkingLoader();
					this.showError(
						`✗ Functional web check still failing after ${event.maxAttempts} fix attempt(s) — reported unverified.`,
					);
				}
				this.ui.requestRender();
				break;
			}

			case "verification": {
				this.setTerminalProgress(event.phase === "running");
				if (event.phase === "running") {
					const label =
						event.attempt > 1
							? `Verifying (${event.command}) — attempt ${event.attempt}…`
							: `Verifying (${event.command})…`;
					// Bridge the post-turn gap like Fusion's "Synthesizing…" path: keep the
					// working loader alive with an accurate phase so the UI doesn't look
					// frozen on "Thinking…" while npm test / tsc runs.
					if (this.workingVisible && !this.loadingAnimation) {
						this.clearStatusContainer();
						this.loadingAnimation = this.createWorkingLoader();
						this.statusContainer.addChild(this.loadingAnimation);
					}
					this.setWorkingPhase(label);
				} else if (event.phase === "passed") {
					this.setWorkingPhase(`✓ Verified — ${event.command} passed`);
				} else if (event.phase === "timeout") {
					// Inconclusive, not red: don't show the scary "still failing" error.
					this.stopWorkingLoader();
					this.showStatus(
						`⚠ ${event.command} timed out — result unknown (not treated as failure); auto-check off for this session`,
						(text) => theme.fg("warning", text),
					);
				} else if (event.willRetry) {
					this.setWorkingPhase(`✗ ${event.command} failed (exit ${event.exitCode ?? "?"}) — fixing…`);
				} else {
					this.stopWorkingLoader();
					this.showError(
						`✗ ${event.command} still failing after ${event.maxAttempts} fix attempt(s) — reported unverified.`,
					);
				}
				this.ui.requestRender();
				break;
			}

			case "pending_check": {
				this.setTerminalProgress(event.phase === "waiting");
				if (event.phase === "waiting") {
					const elapsed = event.elapsedMs !== undefined ? ` (${formatElapsed(event.elapsedMs)})` : "";
					this.showStatus(`Aguardando ${event.command}…${elapsed}`);
					if (this.workingVisible && !this.loadingAnimation) {
						this.clearStatusContainer();
						this.loadingAnimation = this.createWorkingLoader();
						this.statusContainer.addChild(this.loadingAnimation);
					}
				} else if (event.phase === "passed") {
					this.showStatus(`✓ ${event.command} passed`, (text) => theme.fg("success", text));
				} else if (event.phase === "timeout") {
					this.showStatus(`⚠ ${event.command} still running after wait`, (text) => theme.fg("warning", text));
				} else {
					this.showStatus(`✗ ${event.command} failed (exit ${event.exitCode ?? "?"})`, (text) =>
						theme.fg("warning", text),
					);
				}
				this.ui.requestRender();
				break;
			}

			case "subagent_start":
				this.showStatus(`◐ subagent '${event.handle}' started`, (text) => theme.fg("muted", text));
				break;

			case "subagent_progress": {
				const tool = event.lastTool ? ` · ${event.lastTool}` : "";
				this.showStatus(`◐ subagent '${event.handle}' · turn ${event.turn}${tool}`, (text) =>
					theme.fg("muted", text),
				);
				break;
			}

			case "subagent_complete": {
				const meta: string[] = [];
				if (event.turns !== undefined) meta.push(`${event.turns} turns`);
				if (event.totalTokens !== undefined) meta.push(`${event.totalTokens.toLocaleString()} tok`);
				const suffix = meta.length > 0 ? ` · ${meta.join(" · ")}` : "";
				this.showStatus(
					event.status === "done"
						? `✓ subagent '${event.handle}' finished${suffix}`
						: `✗ subagent '${event.handle}' failed${suffix}`,
					event.status === "done" ? (text) => theme.fg("success", text) : (text) => theme.fg("warning", text),
				);
				break;
			}

			case "auto_retry_start": {
				// Set up escape to abort retry
				this.retryEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortRetry();
				};
				// Show retry indicator
				this.clearStatusContainer();
				this.retryCountdown?.dispose();
				// Surface WHY we're retrying (rate-limit / overload / network / …) so the
				// paused countdown isn't an opaque "is it stuck or just busy?". The reason
				// rides on the event; an unclassifiable error keeps the wording unchanged.
				const retryReason = classifyRetryReason(event.errorMessage);
				const retryPrefix = retryReason ? `${retryReason} — ` : "";
				const retryMessage = (seconds: number) =>
					`${retryPrefix}Retrying (${event.attempt}/${event.maxAttempts}) in ${seconds}s… (${keyText("app.interrupt")} to cancel)`;
				this.retryLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("warning", spinner),
					(text) => theme.fg("muted", text),
					retryMessage(Math.ceil(event.delayMs / 1000)),
					reducedMotionLoaderIndicator(),
				);
				this.retryCountdown = new CountdownTimer(
					event.delayMs,
					this.ui,
					(seconds) => {
						this.retryLoader?.setMessage(retryMessage(seconds));
					},
					() => {
						this.retryCountdown = undefined;
					},
				);
				this.statusContainer.addChild(this.retryLoader);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				this._cleanupRetryUI();
				if (!event.success) {
					this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
				}
				this.ui.requestRender();
				break;
			}

			case "fallback_warning": {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(
					new Text(theme.fg("warning", `[fallback] ${event.from} -> ${event.to}: ${event.reason}`), 1, 0),
				);
				this.ui.requestRender();
				break;
			}
		}
	}

	/** Grouped mode: attach the streaming assistant block the first time it has
	 * visible content, dividing the activity group so the text appears after it.
	 * A thinking-only message under hidden-thinking never attaches, so its tools
	 * keep folding into one group. No-op once attached or in legacy mode. */
	private maybeAttachStreamingComponent(): void {
		if (this.streamingAttached || !this.streamingComponent || !this.streamingMessage) return;
		if (!messageHasVisibleContent(this.streamingMessage, !this.hideThinkingBlock)) return;
		this.activityStacker.divide();
		this.streamingComponent.setStreamVisible(true);
		this.chatContainer.addChild(this.streamingComponent);
		this.streamingAttached = true;
	}

	private _abortedErrorMessage(retryAttempt: number): string {
		return retryAttempt > 0
			? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
			: "Operation aborted";
	}

	/**
	 * Append a tool/bash block to the chat, suppressing its leading blank line
	 * when the previous chat block is also a tool/bash block. Consecutive tool
	 * calls then stack one below the other with no gap between them; the blank
	 * is kept only before the first tool block after non-tool content (assistant
	 * text, user input). Grouped tool-activity mode has its own layout, so its
	 * activity-stacker container doesn't match the predicate and is unaffected.
	 */
	private _addToolBlock(component: ToolExecutionComponent | BashExecutionComponent): void {
		const kids = this.chatContainer.children;
		const prev = kids.length > 0 ? kids[kids.length - 1] : undefined;
		if (prev instanceof ToolExecutionComponent || prev instanceof BashExecutionComponent) {
			component.setNoLeadingGap(true);
		}
		this.chatContainer.addChild(component);
	}

	private _ensureToolComponent(toolName: string, toolCallId: string, args: unknown): ToolExecutionComponent {
		const existing = this.pendingTools.get(toolCallId);
		if (existing) return existing;

		const component = new ToolExecutionComponent(
			toolName,
			toolCallId,
			args,
			{
				showImages: this.settingsManager.getShowImages(),
				imageWidthCells: this.settingsManager.getImageWidthCells(),
				framePaddingX: this.settingsManager.getCardPaddingX(),
			},
			this.getRegisteredToolDefinition(toolName),
			this.ui,
			this.sessionManager.getCwd(),
		);
		component.setExpanded(this.toolOutputExpanded);
		if (this.settingsManager.getToolActivity() === "grouped") {
			const placed = this.activityStacker.placeCall(component);
			if (!placed) this._addToolBlock(component);
		} else {
			this._addToolBlock(component);
		}
		this.pendingTools.set(toolCallId, component);
		return component;
	}

	private _cleanupRetryUI(): void {
		if (this.retryEscapeHandler) {
			this.defaultEditor.onEscape = this.retryEscapeHandler;
			this.retryEscapeHandler = undefined;
		}
		if (this.retryCountdown) {
			this.retryCountdown.dispose();
			this.retryCountdown = undefined;
		}
		if (this.retryLoader) {
			this.retryLoader.stop();
			this.retryLoader = undefined;
			this.clearStatusContainer();
		}
	}

	/** Extract text content from a user message */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	/**
	 * Show ephemeral status above the editor (statusContainer), not in the transcript.
	 *
	 * Back-to-back calls update the same line instead of stacking rows.
	 * Info/custom-colored lines auto-dismiss after a short TTL (see
	 * {@link EphemeralStatusController}); errors stay sticky until clear.
	 */
	private showStatus(message: string, color: (text: string) => string = (text) => theme.fg("dim", text)): void {
		this.ephemeralPaintColor = color;
		this.ephemeralStatus.show(message, "info");
	}

	private paintEphemeralStatus(message: string, kind: EphemeralStatusKind): void {
		let color = this.ephemeralPaintColor;
		let text = message;
		if (kind === "error") {
			color = (s) => theme.fg("error", s);
			if (!text.startsWith("✗") && !text.startsWith("Error")) {
				text = `✗ ${text}`;
			}
		} else if (kind === "warning") {
			color = (s) => theme.fg("warning", s);
		}
		if (this.ephemeralStatusText) {
			this.ephemeralStatusText.setText(color(text));
			this.ui.requestRender();
			return;
		}
		const line = new Text(color(text), 1, 0);
		this.ephemeralStatusText = line;
		this.statusContainer.addChild(line);
		this.ui.requestRender();
	}

	private removeEphemeralStatusLine(): void {
		if (!this.ephemeralStatusText) return;
		this.statusContainer.removeChild(this.ephemeralStatusText);
		this.ephemeralStatusText = undefined;
		this.ui.requestRender();
	}

	private clearEphemeralStatus(): void {
		this.ephemeralStatus.clear();
	}

	private clearStatusContainer(): void {
		// Container wipe already drops the Text child — dispose timers without
		// a second removeChild. Also drop the loader ref: clear() removes it from
		// the tree but does not stop its ticker; leaving the ref set blocked
		// recreate paths and left Esc/status updates fighting an orphan spinner.
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.ephemeralStatus.dispose();
		this.statusContainer.clear();
		this.ephemeralStatusText = undefined;
	}

	/**
	 * One-shot tip after the first completed turn (quiet startup skips).
	 * Persists immediately so a crash mid-toast never re-shows it.
	 */
	private maybeShowPowerTip(): void {
		if (this.settingsManager.getQuietStartup()) return;
		if (this.settingsManager.getPowerTipShown()) return;
		this.settingsManager.setPowerTipShown(true);
		const cheatsheet = keyText("tui.help.cheatsheet");
		const interrupt = keyText("app.interrupt");
		this.showStatus(`tip: ${cheatsheet} shortcuts · /model · ${interrupt} interrupts`);
	}

	/** Insert a between-turns hairline rule before a user prompt, but only when the
	 * chat already holds prior content — never before the first message. Works for
	 * both the live and rebuild paths because both funnel through addMessageToChat
	 * with a chatContainer that starts empty (fresh submit clears the empty-state
	 * hint first; a rebuild clears the whole container). */
	private maybeAddTurnRule(): void {
		if (this.chatContainer.children.length === 0) return;
		this.chatContainer.addChild(new TurnRule());
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		this.clearEphemeralStatus();
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this._addToolBlock(component);
				break;
			}
			case "custom": {
				// Boot-time MCP connect notices arrive asynchronously — once the connect
				// budget elapses, often after a turn already started — so a permanent chat
				// block would wedge between a turn and the editor (looks like stray boot
				// noise mid-conversation). Surface them as an ephemeral status line
				// instead. The notice still lives in the model's context (the session
				// layer pushed it independently of display); this only changes how the
				// human sees it.
				if (message.customType === "mcp.notice") {
					const text = typeof message.content === "string" ? message.content : "";
					if (text) this.showStatus(text, (s) => theme.fg("warning", s));
					break;
				}
				if (message.display) {
					const renderer = this.session.extensionRunner.getMessageRenderer(message.customType);
					const component = new CustomMessageComponent(message, renderer, this.getMarkdownThemeWithSettings());
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				// External `Spacer(1)` removed (Leva 2 Spacer cleanup). The
				// CompactionSummaryMessageComponent currently still uses a
				// `Box(1,1, customMsgBg)` shell with its own `paddingY=1`, so
				// the bg row at the top of the box keeps a visual separator
				// from the preceding block. When this component migrates to
				// `MessageShell` the shell's leading blank will replace that.
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				// External `Spacer(1)` removed (same rationale as
				// compactionSummary above — the underlying Box's paddingY=1
				// keeps a 1-row bg gap until migration to MessageShell.)
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					if (isOverthinkSteerMessage(message)) {
						this.disposeActiveStreamingComponent();
						this.chatContainer.addChild(new OverthinkSteerMessageComponent(message));
						break;
					}
					if (isTtsrSteerMessage(message)) {
						this.disposeActiveStreamingComponent();
						this.chatContainer.addChild(new TtsrSteerMessageComponent(message));
						break;
					}
					// Z5: hairline rule between turns — before a real user prompt when the
					// chat already holds prior content (never before the very first). Placed
					// here so both the live message_start path and the history rebuild path
					// (renderSessionContext → addMessageToChat) emit identical separators;
					// mid-turn steers above return before reaching it.
					this.maybeAddTurnRule();
					// External `Spacer(1)` removed (Leva 2 Spacer cleanup).
					// `UserMessageComponent` still wraps content in
					// `Box(1,1, userMsgBg)` whose `paddingY=1` keeps a 1-row
					// bg gap at the top, providing visual separation from the
					// preceding block until the component itself migrates to
					// `MessageShell`.
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings());
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					this.hiddenThinkingLabel,
					undefined,
					false,
					this.settingsManager.getAssistantReadingColumns(),
					this.session.thinkingLevel,
				);
				this.chatContainer.addChild(assistantComponent);
				if (messageHasVisibleContent(message, false)) {
					this.lastAssistantComponent = assistantComponent;
				}
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderSessionContext(
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean; settleOrphanTools?: boolean } = {},
	): void {
		this.pendingTools.clear();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();

		if (options.updateFooter) {
			this.refreshModelIndicators();
		}

		const grouped = this.settingsManager.getToolActivity() === "grouped";
		if (grouped) this.activityStacker.reset();

		for (const message of sessionContext.messages) {
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				if (grouped) {
					// Attach the message block (and divide the group) only when it has
					// visible content; a thinking-only / tool-only message is suppressed
					// so its tools keep folding into the running group.
					if (messageHasVisibleContent(message, !this.hideThinkingBlock)) {
						this.activityStacker.divide();
						this.addMessageToChat(message);
					}
				} else {
					this.addMessageToChat(message);
				}
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{
								showImages: this.settingsManager.getShowImages(),
								imageWidthCells: this.settingsManager.getImageWidthCells(),
								framePaddingX: this.settingsManager.getCardPaddingX(),
							},
							this.getRegisteredToolDefinition(content.name),
							this.ui,
							this.sessionManager.getCwd(),
						);
						component.setExpanded(this.toolOutputExpanded);
						if (grouped) {
							const placed = this.activityStacker.placeCall(component);
							if (!placed) this._addToolBlock(component);
						} else {
							this._addToolBlock(component);
						}

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								errorMessage = this._abortedErrorMessage(this.session.retryAttempt);
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							renderedPendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}
		}

		for (const [toolCallId, component] of renderedPendingTools) {
			// Resume-from-rest: a toolCall persisted in the JSONL without its
			// toolResult (process died mid-tool) has no live loop to deliver a
			// result, so leaving it pending would arm a spinner ticker that never
			// stops. Settle it as incomplete — stops the ticker AND tells the user
			// the tool didn't finish. The live path (settleOrphanTools=false) keeps
			// it pending so tool_execution_end can still settle it normally.
			if (options.settleOrphanTools) {
				component.updateResult({
					content: [{ type: "text", text: "(incompleto — sessão retomada)" }],
					isError: true,
				});
			} else {
				this.pendingTools.set(toolCallId, component);
			}
		}
		this.ui.requestRender();
	}

	renderInitialMessages(): void {
		// Get aligned messages and entries from session context
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: true,
			// Resume path: no live agent loop will deliver results for a toolCall
			// that the JSONL records without its toolResult, so settle those orphans
			// as incomplete rather than leaving an eternally-spinning pending row.
			settleOrphanTools: true,
		});

		// Show compaction info if session was compacted
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	async getUserInput(): Promise<string> {
		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	/** Tear down every chat child that owns animation callbacks (tool rows,
	 * activity lines/groups) before the container is cleared. Container.clear()
	 * only drops the children array — a still-pending row's spinner ticker /
	 * settle ease would otherwise stay registered on the animation loop forever
	 * (CPU + closure retention) after a history rebuild or compaction clear. */
	private _disposeChatComponents(): void {
		for (const child of this.chatContainer.children) {
			(child as Component & { dispose?(): void }).dispose?.();
		}
	}

	private rebuildChatFromMessages(): void {
		this._disposeChatComponents();
		this.chatContainer.clear();
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context);
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		const now = Date.now();
		if (now - this.lastSigintTime < 500) {
			this.clearCtrlCHint();
			void this.shutdown();
			return;
		}
		this.lastSigintTime = now;
		// While a turn is active, the first Ctrl+C INTERRUPTS the task (parity with
		// Esc and Claude Code) instead of only arming the exit hint. Ctrl+C (0x03)
		// is delivered immediately by the stdin buffer — unlike the ambiguous Esc,
		// which waits on a disambiguation timer that can lag while the model is
		// thinking/streaming — so it is the reliable stop path mid-turn. A second
		// Ctrl+C within 500ms still exits.
		if (this.session.isBusy) {
			this.restoreQueuedMessagesToEditor();
			this.session.interrupt();
			this.disposeFusionLive();
			this.deferredTurnDone = null;
			this.stopWorkingLoader();
			this.showStatus("Interrupted");
			this.showCtrlCHint();
			this.armInterruptWatchdog();
			return;
		}
		this.clearEditor();
		this.showCtrlCHint();
	}

	/** Ephemeral hint shown on the first Ctrl+C; auto-clears when the 500ms window expires. */
	private showCtrlCHint(): void {
		this.clearCtrlCHint();
		const hint = new Text(theme.fg("dim", "Press Ctrl+C again to exit"), 1, 0);
		this.ctrlCHint = hint;
		this.statusContainer.addChild(hint);
		this.ctrlCHintTimer = setTimeout(() => this.clearCtrlCHint(), 500);
		this.ui.requestRender();
	}

	private clearCtrlCHint(): void {
		if (this.ctrlCHintTimer) {
			clearTimeout(this.ctrlCHintTimer);
			this.ctrlCHintTimer = undefined;
		}
		if (this.ctrlCHint) {
			this.statusContainer.removeChild(this.ctrlCHint);
			this.ctrlCHint = undefined;
			this.ui.requestRender();
		}
	}

	/**
	 * Defense-in-depth for interrupt. After Esc/Ctrl+C the turn normally settles
	 * within a frame and `agent_end` stops the loader. If a wedged await keeps the
	 * run "busy" past this grace window, the spinner would keep counting with no
	 * feedback — the exact failure the user hit. The watchdog freezes the loader
	 * and tells the user how to force-quit. It deliberately does NOT reset engine
	 * state (no UI/engine split-brain): it only surfaces the stall. The root-cause
	 * stream-teardown fix should make a real wedge unreachable; this is the net.
	 */
	private armInterruptWatchdog(): void {
		this.clearInterruptWatchdog();
		this.interruptWatchdogTimer = setTimeout(() => {
			this.interruptWatchdogTimer = undefined;
			if (!this.session.isBusy) return; // settled cleanly within the grace window
			if (this.loadingAnimation) {
				this.loadingAnimation.stop();
				this.loadingAnimation = undefined;
				this.clearStatusContainer();
			}
			this.showError(
				`Interrupt didn't take effect — the turn appears stuck. Press ${keyText("app.clear")} twice to force-quit.`,
			);
		}, INTERRUPT_WATCHDOG_MS);
	}

	private clearInterruptWatchdog(): void {
		if (this.interruptWatchdogTimer) {
			clearTimeout(this.interruptWatchdogTimer);
			this.interruptWatchdogTimer = undefined;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
	 * repaint the final frame while the process is exiting.
	 */
	private isShuttingDown = false;

	private async shutdown(): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();

		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);

		this.stop();
		await this.runtimeHost.dispose();
		process.exit(0);
	}

	private emergencyTerminalExit(): never {
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		process.exit(129);
	}

	/**
	 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
	 * mode and hides the cursor; without this handler, an uncaught throw from
	 * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
	 * tears down the process while leaving the terminal in raw mode with no
	 * cursor, requiring `stty sane && reset` to recover.
	 *
	 * Unlike emergencyTerminalExit, the terminal is still alive here, so we
	 * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
	 * paste / Kitty / modifyOtherKeys sequences.
	 */
	private uncaughtCrash(error: Error): never {
		if (this.isShuttingDown) {
			process.exit(1);
		}
		this.isShuttingDown = true;
		try {
			this.unregisterSignalHandlers();
		} catch {}
		try {
			killTrackedDetachedChildren();
		} catch {}
		try {
			this.ui.stop();
		} catch {}
		console.error("pi exiting due to uncaughtException:");
		console.error(error);
		process.exit(1);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				if (signal === "SIGHUP") {
					this.emergencyTerminalExit();
				}
				killTrackedDetachedChildren();
				void this.shutdown();
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));

		// Restore the terminal before the process dies on any uncaught throw.
		// Without this, an unhandled exception from extension code (or anywhere
		// in pi) leaves the terminal in raw mode with no cursor.
		const uncaughtExceptionHandler = (error: Error) => this.uncaughtCrash(error);
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));

		// A floating-promise rejection (a fire-and-forget onSubmit/steer/slash path, or
		// a preflight throw) would otherwise terminate the process under Node's default
		// unhandledRejection policy — bypassing the uncaughtException terminal-restore and
		// killing the session mid-work. Registering this handler keeps the session alive:
		// surface the error like any prompt error and carry on (the terminal stays intact
		// because we don't exit). A genuinely fatal throw still routes via uncaughtException.
		const unhandledRejectionHandler = (reason: unknown) => {
			const errorMessage = reason instanceof Error ? reason.message : String(reason);
			try {
				this.showError(errorMessage);
			} catch {
				// the safety net must never throw
			}
		};
		process.prependListener("unhandledRejection", unhandledRejectionHandler);
		this.signalCleanupHandlers.push(() => process.off("unhandledRejection", unhandledRejectionHandler));
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Suspend to background is not supported on Windows");
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.ui.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode)
			this.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		// Queue input during compaction (extension commands execute immediately)
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text);
			} else {
				this.queueCompactionMessage(text, "followUp");
			}
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (this.session.isStreaming) {
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			await this.session.prompt(text, { streamingBehavior: "followUp" });
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (this.editor.onSubmit) {
			this.editor.setText("");
			this.editor.onSubmit(text);
		}
	}

	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	private updateEditorBorderColor(): void {
		if (this.isBashMode) {
			// Bash mode keeps its colored rule — that's a MODE signal (you're about
			// to run a shell command), not decoration.
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else if (this.isPlanPermissionMode) {
			// Plan permission mode: read-only scaffold — same "MODE signal" rationale
			// as bash, distinct color so it is not confused with model role "plan".
			this.editor.borderColor = theme.getPlanModeBorderColor();
		} else {
			// Idle focus: match getEditorTheme().borderColor (`border`) so the primary
			// control stays visible. Thinking level stays on the footer ✦ chip only.
			this.editor.borderColor = (str: string) => theme.fg("border", str);
		}
		this.ui.requestRender();
	}

	/** Forward the OSC 9;4 terminal progress state when the user has it enabled. */
	private setTerminalProgress(on: boolean): void {
		if (this.settingsManager.getShowTerminalProgress()) {
			this.ui.terminal.setProgress(on);
		}
	}

	/** Repaint the model/thinking signals: footer chips + editor border. */
	private refreshModelIndicators(): void {
		this.footer.invalidate();
		this.updateEditorBorderColor();
	}

	/** Switch the active model and refresh all the model-dependent UI/state. */
	private async applyModel(model: Model<any>): Promise<void> {
		await this.session.setModel(model);
		this.refreshModelIndicators();
		this.showStatus(`Model: ${model.id}`);
		void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
		this.checkDaxnutsEasterEgg(model);
	}

	private cycleThinkingLevel(): void {
		const newLevel = this.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.showStatus("Current model does not support thinking");
		} else {
			this.applyThinkingLevel(newLevel);
			this.refreshModelIndicators();
			this.showStatus(`Thinking level: ${newLevel}`);
		}
	}

	/** Propagate thinking level to live assistant bubbles (gutter tint). */
	private applyThinkingLevel(level: ThinkingLevel): void {
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setThinkingLevel(level);
				this.chatContainer.markChildStale(child);
			}
		}
		if (this.streamingComponent) {
			this.streamingComponent.setThinkingLevel(level);
		}
		this.ui.requestRender();
	}

	/**
	 * Ctrl+P model cycling.
	 *
	 * If the active role has a configured chain (settings.modelRoles[role] with a
	 * fallback list, or settings.retry.fallbackChains[role]), cycle through that
	 * chain instead of the global scoped-models list. Falls back to the original
	 * `session.cycleModel(direction)` when no role chain is configured.
	 */
	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		try {
			const roleChain = this.resolveActiveRoleChain();
			if (roleChain && roleChain.length > 1) {
				const currentModel = this.session.model;
				let idx = currentModel
					? roleChain.findIndex(
							(e) => e.model.provider === currentModel.provider && e.model.id === currentModel.id,
						)
					: -1;
				if (idx === -1) idx = 0;
				const len = roleChain.length;
				const nextIdx = direction === "forward" ? (idx + 1) % len : (idx - 1 + len) % len;
				const next = roleChain[nextIdx];
				await this.session.setModel(next.model);
				this.session.setThinkingLevel(next.thinkingLevel);
				this.applyThinkingLevel(next.thinkingLevel);
				this.refreshModelIndicators();
				const thinkingStr =
					next.model.reasoning && next.thinkingLevel !== "off" ? ` (thinking: ${next.thinkingLevel})` : "";
				this.showStatus(`Role ${this.activeRole}: ${next.model.name || next.model.id}${thinkingStr}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(next.model);
				return;
			}

			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
				this.showStatus(msg);
			} else {
				this.applyThinkingLevel(result.thinkingLevel);
				this.refreshModelIndicators();
				const thinkingStr =
					result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
				this.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(result.model);
			}
		} catch (error) {
			this.showError(errMsg(error));
		}
	}

	/**
	 * Cycle the permission mode between plan and auto by invoking the permissions
	 * extension's `permission-cycle` command (which owns the shared
	 * PermissionChecker and updates the footer status).
	 */
	private async cyclePermissionMode(): Promise<void> {
		const runner = this.session.extensionRunner;
		const command = runner.getCommand("permission-cycle");
		if (!command) return;
		try {
			await command.handler("", runner.createCommandContext());
		} catch (error) {
			this.showError(errMsg(error));
		}
	}

	private resolveActiveRoleChain(): Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }> | undefined {
		const settings = this.settingsManager.getModelRoleSettings();
		const roleCfg = settings.modelRoles?.[this.activeRole];
		const retryChain = settings.retry?.fallbackChains?.[this.activeRole];
		if (!roleCfg && (!retryChain || retryChain.length === 0)) return undefined;
		const availableModels = this.session.modelRegistry.getAll();
		const resolution = resolveRole({
			role: this.activeRole,
			availableModels,
			settings,
			cwd: this.sessionManager.getCwd(),
		});
		return resolution?.chain;
	}

	private toggleToolOutputExpansion(): void {
		// While the welcome screen is the focus, the expand key grows the startup
		// help (there is no tool output yet). After the first prompt it toggles
		// tool output and leaves the static welcome header alone — no flicker.
		if (this.welcomeActive) {
			this.setStartupHeaderExpanded(!this.startupHeaderExpanded);
		} else {
			this.setToolsExpanded(!this.toolOutputExpanded);
		}
	}

	private setStartupHeaderExpanded(expanded: boolean): void {
		this.startupHeaderExpanded = expanded;
		if (isExpandable(this.builtInHeader)) {
			this.builtInHeader.setExpanded(expanded);
		}
		this.ui.requestRender();
	}

	private setToolsExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		// Only a custom extension header follows tool expansion; the built-in
		// startup header owns its own state so it never flickers on a tool toggle.
		if (this.customHeader && isExpandable(this.customHeader)) {
			this.customHeader.setExpanded(expanded);
		}
		for (const child of this.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
				this.chatContainer.markChildStale(child);
			}
		}
		this.ui.requestRender();
	}

	/**
	 * Apply a hide/show-thinking-block change to the live chat without a full
	 * rebuild. `rebuildChatFromMessages()` disposes every chat child and
	 * re-parses markdown for the WHOLE session synchronously — fine for a
	 * genuine structural change but wasteful busywork for a setting that
	 * `AssistantMessageComponent.setHideThinkingBlock()` already knows how to
	 * apply in place (it re-renders its own content from `lastMessage`).
	 *
	 * Grouped tool-activity mode is the one case that genuinely needs the
	 * rebuild: `renderSessionContext()` decides whether a thinking-only message
	 * gets its own bubble at all via `messageHasVisibleContent(message,
	 * !hideThinkingBlock)` — toggling the setting can make bubbles appear/
	 * disappear and shift tool-activity group boundaries, which an in-place
	 * patch of existing components cannot reproduce (there is nothing to patch
	 * for a bubble that was never created). Legacy mode always renders one
	 * component per assistant message regardless of visibility, so patching in
	 * place is safe there and skips the synchronous re-parse.
	 */
	private applyHideThinkingBlock(hidden: boolean): void {
		// Grouped mode only needs a full rebuild when a thinking-only message would
		// appear/disappear as its own bubble (messageHasVisibleContent boundary).
		// When every assistant message already has visible text, in-place patch is safe
		// and avoids re-parsing the whole transcript on a hotkey.
		if (
			this.settingsManager.getToolActivity() === "grouped" &&
			sessionHasThinkingOnlyAssistant(this.session.state.messages)
		) {
			this.rebuildChatFromMessages();
			return;
		}
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHideThinkingBlock(hidden);
				this.chatContainer.markChildStale(child);
			}
		}
		this.ui.requestRender();
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

		this.applyHideThinkingBlock(this.hideThinkingBlock);

		// If streaming, refresh the streaming component with updated visibility and
		// re-render. Preserved from the rebuild path, with one guard: the re-attach
		// only happens when the component is NOT already a chatContainer child. In
		// grouped mode applyHideThinkingBlock ran rebuildChatFromMessages (container
		// cleared → includes() is false → re-attach happens exactly as before); in
		// legacy mode the container was patched in place and the streaming component
		// is still attached from its message_start addChild — an unconditional
		// addChild here would append a SECOND reference and duplicate the streaming
		// message in the transcript for good (nothing removes the extra child).
		// children.includes is O(n) but this is a user hotkey, not a hot path.
		if (this.streamingComponent && this.streamingMessage) {
			this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
			this.streamingComponent.updateContent(this.streamingMessage);
			if (!this.chatContainer.children.includes(this.streamingComponent)) {
				this.chatContainer.addChild(this.streamingComponent);
			}
		}

		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private async openExternalEditor(): Promise<void> {
		// Determine editor (respect $VISUAL, then $EDITOR)
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
		const tmpFile = path.join(os.tmpdir(), `pi-editor-${Date.now()}.pit.md`);

		try {
			// Write current content to temp file
			fs.writeFileSync(tmpFile, currentText, "utf-8");

			// Stop TUI to release terminal
			this.ui.stop();

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			process.stdout.write(
				`Launching external editor: ${editorCmd}\n${APP_NAME} will resume when the editor exits.\n`,
			);

			// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
			// Node/libuv's console input read active after ui.stop() pauses stdin, racing
			// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
			const status = await new Promise<number | null>((resolve) => {
				const child = spawn(editor, [...editorArgs, tmpFile], {
					stdio: "inherit",
					shell: process.platform === "win32",
				});
				child.on("error", () => resolve(null));
				child.on("close", (code) => resolve(code));
			});

			// On successful exit (status 0), replace editor content
			if (status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			// Clean up temp file
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			// Restart TUI
			this.ui.start();
			// Force full re-render since external editor uses alternate screen
			this.ui.requestRender(true);
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		// Leading blank only — mirror showWarning. A trailing Spacer here stacked a
		// second blank against the next block's own leading gap (double gap after errors).
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	/** Surface a paste-truncation event from the editor as a visible warning. The
	 * editor has no warning channel of its own, so it plumbs this here. */
	private _onPasteTruncated(info: { originalBytes: number; keptBytes: number }): void {
		const bytesPerMB = 1024 * 1024;
		const originalMB = (info.originalBytes / bytesPerMB).toFixed(1);
		const keptMB = Math.round(info.keptBytes / bytesPerMB);
		this.showWarning(
			`Paste truncado: ${originalMB} MB excede o limite de ${keptMB} MB, mantido os primeiros ${keptMB} MB.`,
		);
	}

	showNewVersionNotification(release: LatestPiRelease): void {
		const action = theme.fg("accent", `${APP_NAME} update`);
		const updateInstruction = theme.fg("muted", `New version ${release.version} is available. Run `) + action;
		const note = release.note?.trim();

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(`${theme.bold(theme.fg("warning", "Update Available"))}\n${updateInstruction}`, 1, 0),
		);
		if (note) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(note, 1, 0, this.getMarkdownThemeWithSettings(), {
					color: (text) => theme.fg("muted", text),
				}),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	showPackageUpdateNotification(packages: string[]): void {
		const action = theme.fg("accent", `${APP_NAME} update`);
		const updateInstruction = theme.fg("muted", "Package updates are available. Run ") + action;
		const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				`${theme.bold(theme.fg("warning", "Package Updates Available"))}\n${updateInstruction}\n${theme.fg("muted", "Packages:")}\n${packageLines}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		const steer: string[] = [];
		const followUp: string[] = [];
		for (const m of this.compactionQueuedMessages) (m.mode === "steer" ? steer : followUp).push(m.text);
		return {
			steering: [...this.session.getSteeringMessages(), ...steer],
			followUp: [...this.session.getFollowUpMessages(), ...followUp],
		};
	}

	/**
	 * Clear all queued messages and return their contents.
	 * Clears both session queue and compaction queue.
	 */
	private clearAllQueues(): { steering: string[]; followUp: string[] } {
		const { steering, followUp } = this.session.clearQueue();
		const steer: string[] = [];
		const followUpCompaction: string[] = [];
		for (const m of this.compactionQueuedMessages) (m.mode === "steer" ? steer : followUpCompaction).push(m.text);
		this.compactionQueuedMessages = [];
		return {
			steering: [...steering, ...steer],
			followUp: [...followUp, ...followUpCompaction],
		};
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		if (steeringMessages.length > 0 || followUpMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steeringMessages) {
				this.pendingMessagesContainer.addChild(new PendingUserMessageComponent("steer", message));
			}
			for (const message of followUpMessages) {
				this.pendingMessagesContainer.addChild(new PendingUserMessageComponent("queued", message));
			}
			const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
			const hintText = theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`);
			this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.clearAllQueues();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.agent.abort();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.editor.getText();
		const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.agent.abort();
		}
		return allQueued.length;
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.compactionQueuedMessages.push({ text, mode });
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;

		const extensionRunner = this.session.extensionRunner;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return !!extensionRunner.getCommand(commandName);
	}

	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${errMsg(error)}`);
		};

		try {
			if (options?.willRetry) {
				// When retry is pending, queue messages for the retry turn
				for (const message of queuedMessages) {
					if (this.isExtensionCommand(message.text)) {
						await this.session.prompt(message.text);
					} else if (message.mode === "followUp") {
						await this.session.followUp(message.text);
					} else {
						await this.session.steer(message.text);
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			// Find first non-extension-command message to use as prompt
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all
				for (const message of queuedMessages) {
					await this.session.prompt(message.text);
				}
				return;
			}

			// Execute any extension commands before the first prompt
			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text);
			}

			// Send first prompt (starts streaming)
			const promptPromise = this.session.prompt(firstPrompt.text).catch((error) => {
				restoreQueue(error);
			});

			// Queue remaining messages
			for (const message of rest) {
				if (this.isExtensionCommand(message.text)) {
					await this.session.prompt(message.text);
				} else if (message.mode === "followUp") {
					await this.session.followUp(message.text);
				} else {
					await this.session.steer(message.text);
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// User-input bus (ask tool)
	// =========================================================================

	private bindUserInputBus(): void {
		// Publish the active bus to the module-level registry so tools can
		// reach it without per-call ctx plumbing across every wrapper.
		setCurrentUserInputBus(this.userInputBus);
		this.userInputBusUnsubscribe = this.userInputBus.onRequest((req) => {
			this.handleAskRequest(req);
		});
		this.signalCleanupHandlers.push(() => {
			this.userInputBusUnsubscribe?.();
			this.userInputBusUnsubscribe = undefined;
			this.userInputBus.cancelAll("shutdown");
			setCurrentUserInputBus(undefined);
		});
	}

	private handleAskRequest(req: AskOptionsRequest): void {
		// Queue if another picker is already up; resolve immediately with
		// the recommended/first option to avoid stacking overlays.
		if (this.pendingAskRequest) {
			this.userInputBus.resolve(req.requestId, computeAutoAnswer(req));
			return;
		}
		this.pendingAskRequest = req;
		const releaseAskWait = this.beginUserInputWait(this.awaitingUserInputMessage);

		let timer: ReturnType<typeof setTimeout> | undefined;
		let close: (() => void) | undefined;
		// Single funnel for every resolution path (user answer, timeout, cancel)
		// so the bus is resolved once and the UI is always torn down.
		const resolveOnce = (answer: Omit<AskOptionsAnswer, "requestId">) => {
			if (this.pendingAskRequest !== req) return;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			this.pendingAskRequest = undefined;
			releaseAskWait();
			this.userInputBus.resolve(req.requestId, answer);
			close?.();
		};

		const displayMode = req.displayMode ?? "inline";
		if (displayMode === "overlay") {
			let handle: OverlayHandle | undefined;
			const hooks = { onToggleVisibility: () => handle?.setHidden(!handle.isHidden()) };
			void this.showExtensionCustom<void>(
				(_tui, _theme, _kb, done) => {
					close = () => done(undefined);
					const { component } = createAskPicker(req, resolveOnce, hooks);
					return component;
				},
				{
					overlay: true,
					overlayOptions: { width: "60%", anchor: "center" },
					onHandle: (h) => {
						handle = h;
					},
				},
			);
		} else {
			this.showSelector((done) => {
				close = done;
				const { component, focus } = createAskPicker(req, resolveOnce);
				return { component, focus };
			});
		}

		if (typeof req.timeout === "number" && req.timeout > 0) {
			timer = setTimeout(() => resolveOnce(computeAutoAnswer(req)), req.timeout);
		}
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		// Blocks the turn on the user (selector in place of the editor) → freeze the clock.
		const releaseWait = this.beginUserInputWait(this.userWaitMessage);
		const done = () => {
			releaseWait();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const { component, focus } = create(done);
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender();
	}

	private showSettingsSelector(): void {
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				{
					autoCompact: this.session.autoCompactionEnabled,
					showImages: this.settingsManager.getShowImages(),
					imageWidthCells: this.settingsManager.getImageWidthCells(),
					autoResizeImages: this.settingsManager.getImageAutoResize(),
					blockImages: this.settingsManager.getBlockImages(),
					enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
					steeringMode: this.session.steeringMode,
					followUpMode: this.session.followUpMode,
					transport: this.settingsManager.getTransport(),
					thinkingLevel: this.session.thinkingLevel,
					availableThinkingLevels: this.session.getAvailableThinkingLevels(),
					currentTheme: this.settingsManager.getTheme() || "dark",
					availableThemes: getAvailableThemes(),
					hideThinkingBlock: this.hideThinkingBlock,
					doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
					treeFilterMode: this.settingsManager.getTreeFilterMode(),
					showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
					editorPaddingX: this.settingsManager.getEditorPaddingX(),
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
					quietStartup: this.settingsManager.getQuietStartup(),
					clearOnShrink: this.settingsManager.getClearOnShrink(),
					showTerminalProgress: this.settingsManager.getShowTerminalProgress(),
					warnings: this.settingsManager.getWarnings(),
					fusionVerify: this.settingsManager.getFusionSettings().verify,
					fusionBrief: this.settingsManager.getFusionSettings().brief,
				},
				{
					onAutoCompactChange: (enabled) => {
						this.session.setAutoCompactionEnabled(enabled);
						this.footer.setAutoCompactEnabled(enabled);
					},
					onShowImagesChange: (enabled) => {
						this.settingsManager.setShowImages(enabled);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setShowImages(enabled);
								this.chatContainer.markChildStale(child);
							}
						}
						this.ui.requestRender();
					},
					onImageWidthCellsChange: (width) => {
						this.settingsManager.setImageWidthCells(width);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setImageWidthCells(width);
								this.chatContainer.markChildStale(child);
							}
						}
						this.ui.requestRender();
					},
					onAutoResizeImagesChange: (enabled) => {
						this.settingsManager.setImageAutoResize(enabled);
					},
					onBlockImagesChange: (blocked) => {
						this.settingsManager.setBlockImages(blocked);
					},
					onEnableSkillCommandsChange: (enabled) => {
						this.settingsManager.setEnableSkillCommands(enabled);
						this.setupAutocompleteProvider();
					},
					onSteeringModeChange: (mode) => {
						this.session.setSteeringMode(mode);
					},
					onFollowUpModeChange: (mode) => {
						this.session.setFollowUpMode(mode);
					},
					onTransportChange: (transport) => {
						this.settingsManager.setTransport(transport);
						this.session.agent.transport = transport;
					},
					onThinkingLevelChange: (level) => {
						this.session.setThinkingLevel(level);
						this.applyThinkingLevel(level);
						this.refreshModelIndicators();
					},
					onThemeChange: (themeName) => {
						const result = setTheme(themeName, true);
						this.settingsManager.setTheme(themeName);
						this.ui.invalidate();
						this.invalidateLoaderInterruptSuffix();
						if (!result.success) {
							this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
						}
					},
					onThemePreview: (themeName) => {
						this.previewTheme(themeName);
					},
					onHideThinkingBlockChange: (hidden) => {
						this.hideThinkingBlock = hidden;
						this.settingsManager.setHideThinkingBlock(hidden);
						this.applyHideThinkingBlock(hidden);
					},
					onQuietStartupChange: (enabled) => {
						this.settingsManager.setQuietStartup(enabled);
					},
					onDoubleEscapeActionChange: (action) => {
						this.settingsManager.setDoubleEscapeAction(action);
					},
					onTreeFilterModeChange: (mode) => {
						this.settingsManager.setTreeFilterMode(mode);
					},
					onShowHardwareCursorChange: (enabled) => {
						this.settingsManager.setShowHardwareCursor(enabled);
						this.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						this.settingsManager.setEditorPaddingX(padding);
						this.defaultEditor.setPaddingX(padding);
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							this.editor.setPaddingX(padding);
						}
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						this.settingsManager.setAutocompleteMaxVisible(maxVisible);
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onClearOnShrinkChange: (enabled) => {
						this.settingsManager.setClearOnShrink(enabled);
						this.ui.setClearOnShrink(enabled);
					},
					onShowTerminalProgressChange: (enabled) => {
						this.settingsManager.setShowTerminalProgress(enabled);
					},
					onWarningsChange: (warnings) => {
						this.settingsManager.setWarnings(warnings);
					},
					onFusionVerifyChange: (enabled) => {
						this.settingsManager.setFusionFlags({ verify: enabled });
					},
					onFusionBriefChange: (enabled) => {
						this.settingsManager.setFusionFlags({ brief: enabled });
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			this.showModelSelector();
			return;
		}

		// `/model role` (no extra arg) prints the current active role config.
		if (searchTerm === "role") {
			const current = this.activeRole;
			const cfg = this.settingsManager.getModelRoleSettings().modelRoles?.[current];
			if (cfg) {
				const chainStr =
					cfg.fallbackChain && cfg.fallbackChain.length > 0 ? ` chain=[${cfg.fallbackChain.join(", ")}]` : "";
				const thinkStr = cfg.thinkingLevel ? ` thinking=${cfg.thinkingLevel}` : "";
				this.showStatus(`Role: ${current} -> ${cfg.model}${thinkStr}${chainStr}`);
			} else {
				this.showStatus(`Role: ${current} (no configuration in settings.modelRoles)`);
			}
			return;
		}

		// `/model <role>` switches the active role for subsequent turns.
		// MODEL_ROLES is the single source of truth; the cast is safe after the
		// includes check and avoids a hardcoded ||-chain that would silently drift
		// if a new role were added upstream.
		if ((MODEL_ROLES as readonly string[]).includes(searchTerm)) {
			await this.applyModelRole(searchTerm as ModelRole);
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				await this.applyModel(model);
			} catch (error) {
				this.showError(errMsg(error));
			}
			return;
		}

		this.showModelSelector(searchTerm);
	}

	/**
	 * Switch to a model role (resolveRole + setModel + thinking + indicators).
	 * Shared by `/model <role>` and the permission-mode-change callback so the
	 * two paths never drift. `showStatus` is suppressed when called from the
	 * callback (silent swap) — the mode change itself already notifies.
	 */
	private async applyModelRole(role: ModelRole, opts?: { silent?: boolean }): Promise<void> {
		this.activeRole = role;
		const roleSettings = this.settingsManager.getModelRoleSettings();
		const availableModels = this.session.modelRegistry.getAll();
		const resolution = resolveRole({
			role,
			availableModels,
			settings: roleSettings,
			cwd: this.sessionManager.getCwd(),
		});
		if (resolution) {
			try {
				await this.session.setModel(resolution.model);
				this.session.setThinkingLevel(resolution.thinkingLevel);
				this.applyThinkingLevel(resolution.thinkingLevel);
				this.refreshModelIndicators();
				if (!opts?.silent) {
					this.showStatus(`Role: ${role} -> ${resolution.model.provider}/${resolution.model.id}`);
				}
			} catch (error) {
				this.showError(errMsg(error));
			}
		} else if (!opts?.silent) {
			this.showStatus(`Role: ${role} active (no model configured; using current)`);
		}
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		const models = await this.getModelCandidates();
		return findExactModelReferenceMatch(searchTerm, models);
	}

	private async getModelCandidates(): Promise<Model<any>[]> {
		if (this.session.scopedModels.length > 0) {
			return this.session.modelRegistry.filterScopedModels(this.session.scopedModels).map((scoped) => scoped.model);
		}

		this.session.modelRegistry.refresh();
		try {
			return await this.session.modelRegistry.getAvailable();
		} catch (error) {
			// getAvailable() is a sync filter that essentially can't throw; if it
			// does (unexpected internal/auth-storage failure), surface it so the
			// degraded path (exact-match falls back to the selector, footer shows
			// 0 providers) isn't silent. console.warn, not showError: this runs on
			// the background footer-refresh path as well as user /model lookups.
			console.warn(chalk.yellow(`Warning: model registry getAvailable() failed: ${errMsg(error)}`));
			return [];
		}
	}

	/** Update the footer's available provider count from current model candidates */
	private async updateAvailableProviderCount(): Promise<void> {
		const models = await this.getModelCandidates();
		const uniqueProviders = new Set(models.map((m) => m.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	private async maybeWarnAboutAnthropicSubscriptionAuth(
		model: Model<any> | undefined = this.session.model,
	): Promise<void> {
		if (this.settingsManager.getWarnings().anthropicExtraUsage === false) {
			return;
		}
		if (this.anthropicSubscriptionWarningShown) {
			return;
		}
		if (!model || model.provider !== "anthropic") {
			return;
		}

		const storedCredential = this.session.modelRegistry.authStorage.get("anthropic");
		if (storedCredential?.type === "oauth") {
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
			return;
		}

		try {
			const apiKey = await this.session.modelRegistry.getApiKeyForProvider(model.provider);
			if (!isAnthropicSubscriptionAuthKey(apiKey)) {
				return;
			}
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
		} catch {
			// Ignore auth lookup failures for warning-only checks.
		}
	}

	/**
	 * `detectCliAsync` shells out via a non-blocking spawn (10s timeout) so a slow or
	 * hung CLI never freezes the TUI frame. Memoize the result per CLI for the session
	 * so repeated /fusion invocations don't re-probe PATH — the probe runs at most once
	 * per CLI per session.
	 */
	private async detectCliCached(cli: "codex" | "claude"): Promise<boolean> {
		const cached = this._cliDetectCache.get(cli);
		if (cached !== undefined) return cached;
		const found = await detectCliAsync(cli);
		this._cliDetectCache.set(cli, found);
		return found;
	}

	private async handleFusionCommand(): Promise<void> {
		const clis: Array<"codex" | "claude"> = [];
		if (await this.detectCliCached("codex")) clis.push("codex");
		if (await this.detectCliCached("claude")) clis.push("claude");
		if (clis.length === 0) {
			this.showError(
				"Fusion needs the codex and/or claude CLI on PATH. Install at least one, then run /fusion again.",
			);
			return;
		}
		const providers = new Set<string>();
		if (clis.includes("claude")) providers.add("anthropic");
		if (clis.includes("codex")) providers.add("openai-codex");
		const candidates = this.session.modelRegistry.getAll().filter((m) => providers.has(m.provider));
		if (candidates.length === 0) {
			const missing = clis.map((c) => (c === "claude" ? "anthropic" : "openai-codex")).join(" / ");
			this.showError(
				`No installed-CLI models available for Fusion (${missing}). Use /login to add providers, then /fusion.`,
			);
			return;
		}

		const synthId = this.session.model?.id ?? "active model";
		const fusion = this.settingsManager.getFusionSettings();

		this.showSelector((done) => {
			const selector = new FusionSetupComponent(
				this.ui,
				synthId,
				candidates,
				{ verify: fusion.verify, brief: fusion.brief, panel: fusion.panel },
				(result) => {
					this.settingsManager.setFusionPanel([
						{ cli: result.advisors[0].cli, model: result.advisors[0].model.id },
						{ cli: result.advisors[1].cli, model: result.advisors[1].model.id },
					]);
					this.settingsManager.setFusionFlags({ verify: result.verify, brief: result.brief });
					// Match Alt+P Fusion·Plan: activate orchestration + plan (read-only) mode.
					this.runtimeHost.services.permissionChecker.updateMode("plan");
					this.session.setOrchestration("fusion");
					// updateMode alone does not fire bindPermissionModeChange — notify so
					// role swap / editor border / isPlanPermissionMode stay in sync.
					this.runtimeHost.services.notifyPermissionModeChange?.("plan");
					this.setExtensionStatus(
						"permissions",
						`permissions: ${modeDisplayLabel(this.runtimeHost.services.permissionChecker, "fusion")}`,
					);
					this.refreshModelIndicators();
					done();
					const a = result.advisors[0].model.id;
					const b = result.advisors[1].model.id;
					this.showStatus(`${humanModeNotifyLabel("fusion", "plan")} · synth: ${synthId} · advisors: ${a} + ${b}`);
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showModelSelector(initialSearchInput?: string): void {
		// `/model <term>` passes an explicit term; a bare open (keybinding or
		// `/model` with no arg) restores the last search so re-opening keeps the
		// user's place instead of resetting to the full list.
		const restoredSearch = initialSearchInput ?? this.lastModelSearch;
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.settingsManager,
				this.session.modelRegistry,
				this.session.scopedModels,
				async (model) => {
					// Remember the search so the next open continues where this one left off.
					this.lastModelSearch = selector.getSearchInput().getValue();
					// Not folded into applyModel(): done() is interleaved between the
					// indicator refresh and the status/warn/easter-egg tail, so the
					// editor-restore ordering must stay exactly here.
					try {
						await this.session.setModel(model);
						this.refreshModelIndicators();
						done();
						this.showStatus(`Model: ${model.id}`);
						void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
						this.checkDaxnutsEasterEgg(model);
					} catch (error) {
						done();
						this.showError(errMsg(error));
					}
				},
				() => {
					this.lastModelSearch = selector.getSearchInput().getValue();
					done();
					this.ui.requestRender();
				},
				restoredSearch,
			);
			return { component: selector, focus: selector };
		});
	}

	private showUserMessageSelector(): void {
		const userMessages = this.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			this.showStatus("No messages to fork from");
			return;
		}

		const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					try {
						const result = await this.runtimeHost.fork(entryId);
						if (result.cancelled) {
							done();
							this.ui.requestRender();
							return;
						}

						this.renderCurrentSessionState();
						this.editor.setText(result.selectedText ?? "");
						done();
						this.showStatus("Forked to new session");
					} catch (error: unknown) {
						done();
						this.showError(errMsg(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSelectedId,
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private showTreeSelector(initialSelectedId?: string): void {
		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.defaultEditor.onEscape;

					if (wantsSummary) {
						this.defaultEditor.onEscape = () => {
							this.session.abortBranchSummary();
						};
						this.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ui,
							workingPulsePalette(),
							(text) => theme.fg("muted", text),
							`Summarizing branch… (${keyText("app.interrupt")} to cancel)`,
							reducedMotionLoaderIndicator(),
						);
						this.statusContainer.addChild(summaryLoader);
						this.ui.requestRender();
					}

					try {
						const result = await this.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("Branch summarization cancelled");
							this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						this._disposeChatComponents();
						this.chatContainer.clear();
						this.renderInitialMessages();
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("Navigated to selected point");
						void this.flushCompactionQueue({ willRetry: false });
					} catch (error) {
						this.showError(errMsg(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.clearStatusContainer();
						}
						this.defaultEditor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.ui.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
				// The debounced search-filter recompute (see TreeList.onFilterApplied)
				// lands on a timer callback outside the input pipeline, so it needs an
				// explicit repaint request — the same one the other tree-selector
				// callbacks above already trigger for their own UI-affecting actions.
				() => this.ui.requestRender(),
			);
			return { component: selector, focus: selector };
		});
	}

	private showSessionSelector(): void {
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress) =>
					SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress),
				SessionManager.listAll,
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.ui.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const mgr = SessionManager.open(sessionFilePath);
						mgr.appendSessionInfo(next);
					},
					showRenameHint: true,
					keybindings: this.keybindings,
				},

				this.sessionManager.getSessionFile(),
				this.ui,
			);
			return { component: selector, focus: selector.getSessionList() };
		});
	}

	private async handleResumeSession(
		sessionPath: string,
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean }> {
		this.stopWorkingLoader();
		try {
			const result = await this.runtimeHost.switchSession(sessionPath, {
				withSession: options?.withSession,
			});
			if (result.cancelled) {
				return result;
			}
			this.renderCurrentSessionState();
			this.showStatus("Resumed session");
			return result;
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Resume cancelled");
					return { cancelled: true };
				}
				const result = await this.runtimeHost.switchSession(sessionPath, {
					cwdOverride: selectedCwd,
					withSession: options?.withSession,
				});
				if (result.cancelled) {
					return result;
				}
				this.renderCurrentSessionState();
				this.showStatus("Resumed session in current cwd");
				return result;
			}
			return this.handleFatalRuntimeError("Failed to resume session", error);
		}
	}

	private getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[] {
		const authStorage = this.session.modelRegistry.authStorage;
		const oauthProviders = authStorage.getOAuthProviders();
		const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));
		const options: AuthSelectorProvider[] = oauthProviders.map((provider) => ({
			id: provider.id,
			name: provider.name,
			authType: "oauth",
		}));

		const modelProviders = new Set(this.session.modelRegistry.getAll().map((model) => model.provider));
		for (const providerId of modelProviders) {
			if (isHiddenModelProvider(providerId)) {
				continue;
			}
			if (!isApiKeyLoginProvider(providerId, oauthProviderIds)) {
				continue;
			}
			options.push({
				id: providerId,
				name: this.session.modelRegistry.getProviderDisplayName(providerId),
				authType: "api_key",
			});
		}

		const filteredOptions = authType ? options.filter((option) => option.authType === authType) : options;
		return filteredOptions.sort((a, b) => a.name.localeCompare(b.name));
	}

	private getLogoutProviderOptions(): AuthSelectorProvider[] {
		const authStorage = this.session.modelRegistry.authStorage;
		const options: AuthSelectorProvider[] = [];

		for (const providerId of authStorage.list()) {
			const credential = authStorage.get(providerId);
			if (!credential) {
				continue;
			}
			options.push({
				id: providerId,
				name: this.session.modelRegistry.getProviderDisplayName(providerId),
				authType: credential.type,
			});
		}

		return options.sort((a, b) => a.name.localeCompare(b.name));
	}

	private showLoginAuthTypeSelector(): void {
		const subscriptionLabel = "Use a subscription";
		const apiKeyLabel = "Use an API key";
		const openAICompatibleLabel = "Add OpenAI-compatible endpoint (custom URL + key)";
		this.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				"Select authentication method:",
				[subscriptionLabel, apiKeyLabel, openAICompatibleLabel],
				(option) => {
					done();
					if (option === openAICompatibleLabel) {
						void this.showOpenAICompatibleLoginDialog();
						return;
					}
					const authType = option === subscriptionLabel ? "oauth" : "api_key";
					this.showLoginProviderSelector(authType);
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showLoginProviderSelector(authType: "oauth" | "api_key"): void {
		const providerOptions = this.getLoginProviderOptions(authType);
		if (providerOptions.length === 0) {
			this.showStatus(
				authType === "oauth" ? "No subscription providers available." : "No API key providers available.",
			);
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				"login",
				this.session.modelRegistry.authStorage,
				providerOptions,
				async (providerId: string) => {
					done();

					const providerOption = providerOptions.find((provider) => provider.id === providerId);
					if (!providerOption) {
						return;
					}

					if (providerOption.authType === "oauth") {
						await this.showLoginDialog(providerOption.id, providerOption.name);
					} else {
						await this.showApiKeyLoginDialog(providerOption.id, providerOption.name);
					}
				},
				() => {
					done();
					this.showLoginAuthTypeSelector();
				},
				(providerId) => this.session.modelRegistry.getProviderAuthStatus(providerId),
			);
			return { component: selector, focus: selector };
		});
	}

	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		if (mode === "login") {
			this.showLoginAuthTypeSelector();
			return;
		}

		const providerOptions = this.getLogoutProviderOptions();
		if (providerOptions.length === 0) {
			this.showStatus(
				"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
			);
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				mode,
				this.session.modelRegistry.authStorage,
				providerOptions,
				async (providerId: string) => {
					done();

					const providerOption = providerOptions.find((provider) => provider.id === providerId);
					if (!providerOption) {
						return;
					}

					try {
						this.session.modelRegistry.authStorage.logout(providerOption.id);
						this.session.modelRegistry.refresh();
						await this.updateAvailableProviderCount();
						const message =
							providerOption.authType === "oauth"
								? `Logged out of ${providerOption.name}`
								: `Removed stored API key for ${providerOption.name}. Environment variables and models.json config are unchanged.`;
						this.showStatus(message);
					} catch (error: unknown) {
						this.showError(`Logout failed: ${errMsg(error)}`);
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async completeProviderAuthentication(
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
		previousModel: Model<any> | undefined,
	): Promise<void> {
		this.session.modelRegistry.refresh();

		const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;

		let selectedModel: Model<any> | undefined;
		let selectionError: string | undefined;
		if (isUnknownModel(previousModel)) {
			const availableModels = this.session.modelRegistry.getAvailable();
			const providerModels = availableModels.filter((model) => model.provider === providerId);
			if (providerModels.length === 0) {
				selectionError = `${actionLabel}, but no models are available for that provider. Use /model to select a model.`;
			} else {
				// Prefer the provider's curated default; otherwise (presets, custom
				// OpenAI-compatible providers) fall back to the first available model.
				const defaultModelId = hasDefaultModelProvider(providerId)
					? defaultModelPerProvider[providerId]
					: undefined;
				const candidate = defaultModelId
					? providerModels.find((model) => model.id === defaultModelId)
					: providerModels[0];
				if (!candidate) {
					selectionError = `${actionLabel}, but its default model "${defaultModelId}" is not available. Use /model to select a model.`;
				} else {
					try {
						await this.session.setModel(candidate);
						selectedModel = candidate;
					} catch (error: unknown) {
						const errorMessage = errMsg(error);
						selectionError = `${actionLabel}, but selecting a model failed: ${errorMessage}. Use /model to select a model.`;
					}
				}
			}
		}

		await this.updateAvailableProviderCount();
		this.refreshModelIndicators();
		if (selectedModel) {
			this.showStatus(`${actionLabel}. Selected ${selectedModel.id}. Credentials saved to ${getAuthPath()}`);
			void this.maybeWarnAboutAnthropicSubscriptionAuth(selectedModel);
			this.checkDaxnutsEasterEgg(selectedModel);
		} else {
			this.showStatus(`${actionLabel}. Credentials saved to ${getAuthPath()}`);
			if (selectionError) {
				this.showError(selectionError);
			} else {
				void this.maybeWarnAboutAnthropicSubscriptionAuth();
			}
		}
	}

	private async showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void> {
		const previousModel = this.session.model;

		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
		);

		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			const apiKey = (await dialog.showPrompt("Enter API key:")).trim();
			if (!apiKey) {
				throw new Error("API key cannot be empty.");
			}

			// For OpenAI-compatible providers (presets like Z.ai GLM/Verboo, or any
			// provider whose model uses an openai-* API), verify the key right away.
			// A clear rejection (401/403) aborts before persisting an unusable key.
			const probe = await this.maybeProbeProviderApiKey(providerId, apiKey, dialog);
			if (probe?.authRejected) {
				restoreEditor();
				this.showError(`API key for ${providerName} was rejected: ${probe.detail}`);
				return;
			}

			this.session.modelRegistry.authStorage.set(providerId, { type: "api_key", key: apiKey });

			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "api_key", previousModel);
			if (probe) {
				this.showStatus(
					probe.ok
						? `${providerName} — connection test passed: ${probe.detail}`
						: `${providerName} — saved, but connection test could not verify: ${probe.detail}`,
				);
			}
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = errMsg(error);
			if (errorMsg !== "Login cancelled") {
				this.showError(`Failed to save API key for ${providerName}: ${errorMsg}`);
			}
		}
	}

	/**
	 * Probe the API key against an OpenAI-compatible provider's endpoint right after
	 * the user enters it. Returns undefined when a probe doesn't apply (no model,
	 * non-http baseUrl, or a non-OpenAI API like anthropic-messages/google).
	 */
	private async maybeProbeProviderApiKey(
		providerId: string,
		apiKey: string,
		dialog: LoginDialogComponent,
	): Promise<ProbeResult | undefined> {
		const model = this.session.modelRegistry.getAll().find((candidate) => candidate.provider === providerId);
		if (!model?.baseUrl) {
			return undefined;
		}
		if (!String(model.api).startsWith("openai")) {
			return undefined;
		}
		if (!/^https?:\/\//i.test(model.baseUrl)) {
			return undefined;
		}
		dialog.showBusy("Testing connection…");
		return probeOpenAICompatibleConnection({ baseUrl: model.baseUrl, apiKey, model: model.id });
	}

	/**
	 * Login flow for an arbitrary OpenAI-compatible endpoint: prompt for base URL,
	 * model id, and API key; test the connection; then persist the provider to
	 * models.json (key goes to auth.json) so it survives restarts and appears in
	 * `/model`.
	 */
	private async showOpenAICompatibleLoginDialog(): Promise<void> {
		const dialog = new LoginDialogComponent(
			this.ui,
			"openai-compatible",
			() => {
				// Completion handled below.
			},
			"OpenAI-compatible provider",
			"Add OpenAI-compatible provider",
		);

		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			const baseUrlRaw = (
				await dialog.showStepPrompt("Base URL (OpenAI-compatible):", {
					placeholder: "https://api.z.ai/api/coding/paas/v4",
				})
			).trim();
			if (!baseUrlRaw) {
				throw new Error("Base URL cannot be empty.");
			}
			const baseUrl = normalizeBaseUrl(baseUrlRaw);
			if (!/^https?:\/\//i.test(baseUrl)) {
				throw new Error("Base URL must start with http:// or https://");
			}

			const modelId = (
				await dialog.showStepPrompt("Model ID:", {
					placeholder: "glm-5.2",
					context: [`Base URL: ${baseUrl}`],
				})
			).trim();
			if (!modelId) {
				throw new Error("Model ID cannot be empty.");
			}

			const apiKey = (
				await dialog.showStepPrompt("API key:", {
					context: [`Base URL: ${baseUrl}`, `Model: ${modelId}`],
				})
			).trim();
			if (!apiKey) {
				throw new Error("API key cannot be empty.");
			}

			const displayName = (
				await dialog.showStepPrompt("Display name (optional, Enter to skip):", {
					placeholder: "My Provider",
					context: [`Base URL: ${baseUrl}`, `Model: ${modelId}`],
				})
			).trim();

			dialog.showBusy("Testing connection…");
			const probe = await probeOpenAICompatibleConnection({ baseUrl, apiKey, model: modelId });
			if (probe.authRejected) {
				restoreEditor();
				this.showError(`Not saved — ${probe.detail}`);
				return;
			}

			const takenIds = new Set<string>(this.session.modelRegistry.getAll().map((model) => model.provider));
			const providerId = deriveProviderIdFromBaseUrl(baseUrl, takenIds);
			const providerName = displayName || providerId;

			const modelsJsonPath = this.session.modelRegistry.getModelsJsonPath();
			if (!modelsJsonPath) {
				throw new Error("No models.json path is configured to persist the provider.");
			}

			persistOpenAICompatibleProviderToModelsJson(modelsJsonPath, providerId, {
				name: providerName,
				baseUrl,
				api: "openai-completions",
				models: [{ id: modelId, name: modelId }],
			});
			this.session.modelRegistry.authStorage.set(providerId, { type: "api_key", key: apiKey });
			this.session.modelRegistry.refresh();

			restoreEditor();

			const newModel = this.session.modelRegistry.find(providerId, modelId);
			if (newModel) {
				try {
					await this.session.setModel(newModel);
				} catch (error: unknown) {
					this.showError(
						`Provider added, but selecting the model failed: ${errMsg(error)}. Use /model to select.`,
					);
				}
			}
			await this.updateAvailableProviderCount();
			this.refreshModelIndicators();

			const verifyNote = probe.ok ? probe.detail : `connection unverified (${probe.detail})`;
			this.showStatus(
				`Added ${providerName} as ${providerId}/${modelId} — ${verifyNote}. Credentials saved to ${getAuthPath()}`,
			);
		} catch (error: unknown) {
			restoreEditor();
			const message = errMsg(error);
			if (message !== "Login cancelled") {
				this.showError(`Failed to add OpenAI-compatible provider: ${message}`);
			}
		}
	}

	private showOAuthLoginSelect(dialog: LoginDialogComponent, prompt: OAuthSelectPrompt): Promise<string | undefined> {
		return new Promise((resolve) => {
			const restoreDialog = () => {
				this.editorContainer.clear();
				this.editorContainer.addChild(dialog);
				this.ui.setFocus(dialog);
				this.ui.requestRender();
			};
			const labels = prompt.options.map((option) => option.label);
			const selector = new ExtensionSelectorComponent(
				prompt.message,
				labels,
				(optionLabel) => {
					restoreDialog();
					resolve(prompt.options.find((option) => option.label === optionLabel)?.id);
				},
				() => {
					restoreDialog();
					resolve(undefined);
				},
			);
			this.editorContainer.clear();
			this.editorContainer.addChild(selector);
			this.ui.setFocus(selector);
			this.ui.requestRender();
		});
	}

	private async showLoginDialog(providerId: string, providerName: string): Promise<void> {
		const providerInfo = this.session.modelRegistry.authStorage
			.getOAuthProviders()
			.find((provider) => provider.id === providerId);
		const previousModel = this.session.model;

		// Providers that use callback servers (can paste redirect URL)
		const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;

		// Create login dialog component
		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
		);

		// Show dialog in editor container
		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		// Promise for manual code input (racing with callback server)
		let manualCodeResolve: ((code: string) => void) | undefined;
		let manualCodeReject: ((err: Error) => void) | undefined;
		const manualCodePromise = new Promise<string>((resolve, reject) => {
			manualCodeResolve = resolve;
			manualCodeReject = reject;
		});

		// Restore editor helper
		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			await this.session.modelRegistry.authStorage.login(providerId as OAuthProviderId, {
				onAuth: (info: { url: string; instructions?: string }) => {
					dialog.showAuth(info.url, info.instructions);

					if (usesCallbackServer) {
						// Show input for manual paste, racing with callback
						dialog
							.showManualInput("Paste redirect URL below, or complete login in browser:")
							.then((value) => {
								if (value && manualCodeResolve) {
									manualCodeResolve(value);
									manualCodeResolve = undefined;
								}
							})
							.catch(() => {
								if (manualCodeReject) {
									manualCodeReject(new Error("Login cancelled"));
									manualCodeReject = undefined;
								}
							});
					}
					// For Anthropic: onPrompt is called immediately after
				},

				onPrompt: async (prompt: { message: string; placeholder?: string }) => {
					return dialog.showPrompt(prompt.message, prompt.placeholder);
				},

				onProgress: (message: string) => {
					dialog.showProgress(message);
				},

				onSelect: (prompt: OAuthSelectPrompt) => this.showOAuthLoginSelect(dialog, prompt),

				onManualCodeInput: () => manualCodePromise,

				signal: dialog.signal,
			});

			// Success
			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "oauth", previousModel);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = errMsg(error);
			if (errorMsg !== "Login cancelled") {
				this.showError(`Failed to login to ${providerName}: ${errorMsg}`);
			}
		}
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private async handleReloadCommand(): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return;
		}

		this.resetExtensionUI();

		const reloadBox = new Container();
		const borderColor = (s: string) => theme.fg("border", s);
		reloadBox.addChild(new DynamicBorder(borderColor));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(
			new Text(theme.fg("muted", "Reloading keybindings, extensions, skills, prompts, themes…"), 1, 0),
		);
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new DynamicBorder(borderColor));

		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(reloadBox);
		this.ui.setFocus(reloadBox);
		this.ui.requestRender(true);
		await new Promise((resolve) => process.nextTick(resolve));

		const dismissReloadBox = (editor: Component) => {
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.ui.requestRender();
		};

		try {
			await this.session.reload();
			this.keybindings.reload();
			// Keybindings (and possibly the theme, below) just changed — drop the
			// memoized loader interrupt-key suffix so the next render reflects them.
			this.invalidateLoaderInterruptSuffix();
			const activeHeader = this.customHeader ?? this.builtInHeader;
			if (isExpandable(activeHeader)) {
				activeHeader.setExpanded(this.toolOutputExpanded);
			}
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			const themeName = this.settingsManager.getTheme();
			const themeResult = themeName ? setTheme(themeName, true) : { success: true };
			if (!themeResult.success) {
				this.showError(`Failed to load theme "${themeName}": ${themeResult.error}\nFell back to dark theme.`);
			}
			const editorPaddingX = this.settingsManager.getEditorPaddingX();
			const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
			this.defaultEditor.setPaddingX(editorPaddingX);
			this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
			if (this.editor !== this.defaultEditor) {
				this.editor.setPaddingX?.(editorPaddingX);
				this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
			}
			this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
			this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
			this.setupAutocompleteProvider();
			const runner = this.session.extensionRunner;
			this.setupExtensionShortcuts(runner);
			this.rebuildChatFromMessages();
			dismissReloadBox(this.editor as Component);
			this.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const modelsJsonError = this.session.modelRegistry.getError();
			if (modelsJsonError) {
				this.showError(`models.json error: ${modelsJsonError}`);
			}
			this.showStatus("Reloaded keybindings, extensions, skills, prompts, themes");
		} catch (error) {
			dismissReloadBox(previousEditor as Component);
			this.showError(`Reload failed: ${errMsg(error)}`);
		}
	}

	private handleNameCommand(text: string): void {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.sessionManager.getSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
			} else {
				this.showWarning("Usage: /name <name>");
			}
			this.ui.requestRender();
			return;
		}

		this.session.setSessionName(name);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${name}`), 1, 0));
		this.ui.requestRender();
	}

	private async handleSkillsCommand(args: string): Promise<void> {
		const sub = args.trim().toLowerCase();
		const skillsResult = this.session.resourceLoader.getSkills();
		const discovery = this.settingsManager.getSkillDiscoverySettings();
		const input = {
			cwd: this.sessionManager.getCwd(),
			skills: skillsResult.skills,
			diagnostics: skillsResult.diagnostics,
			discovery,
		};
		let body: string;
		const verboseDoctor = sub === "doctor verbose" || sub === "doctor paths";
		if (sub === "doctor fix" || sub === "fix") {
			body = await this.runSkillsDoctorFix(input);
		} else if (sub === "doctor" || verboseDoctor) {
			body = formatSkillsDoctorReport({ ...input, verbose: verboseDoctor });
		} else if (sub === "") {
			body = formatSkillsDoctorBrief(input);
		} else {
			body = `${formatSkillsDoctorBrief(input)}\n\n${theme.fg("muted", `Unknown subcommand "${sub}". Try /skills doctor.`)}`;
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(body, 1, 0));
		this.ui.requestRender();
	}

	private async runSkillsDoctorFix(input: {
		diagnostics: readonly ResourceDiagnostic[];
		discovery: ResolvedSkillDiscoverySettings;
	}): Promise<string> {
		if (this.session.isStreaming) {
			return theme.fg("warning", "Wait for the current response to finish before fixing skills.");
		}
		const beforeCounts = tallySkillDiagnostics(input.diagnostics);
		const plan = planSkillsDoctorFix(input.diagnostics, input.discovery);
		const applied = applySkillsDoctorFix(this.settingsManager, plan);
		if (applied.length > 0) {
			await this.session.reload();
		}
		const afterCounts = tallySkillDiagnostics(this.session.resourceLoader.getSkills().diagnostics);
		return formatSkillsDoctorFixResult(beforeCounts, afterCounts, applied);
	}

	private handleSessionCommand(): void {
		const stats = this.session.getSessionStats();
		const sessionName = this.sessionManager.getSessionName();

		let info = `${theme.bold("Session Info")}\n\n`;
		if (sessionName) {
			info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
		}
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.tokens.cacheWrite > 0) {
			info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		if (stats.cost > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}`;
		}

		const fixedCost = this.session.getFixedCostSurface();
		const cacheStatsForFixed = this.session.getCacheStats();
		const kFmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
		const pctFmt = (r: number): string => `${Math.round(r * 100)}%`;
		info += `\n${theme.bold("Fixed Cost")}\n`;
		if (fixedCost) {
			const sysDyn =
				fixedCost.dynamicSystemTokens > 0
					? ` (${kFmt(fixedCost.staticSystemTokens)} static + ${kFmt(fixedCost.dynamicSystemTokens)} dyn)`
					: "";
			info += `${theme.fg("dim", "System:")} ${kFmt(fixedCost.systemTokens)} tok${sysDyn} (est.)\n`;
			info += `${theme.fg("dim", "Tools:")}  ${kFmt(fixedCost.toolTokens)} tok (est.)\n`;
		} else {
			info += `${theme.fg("muted", "— no request yet")}\n`;
		}
		if (cacheStatsForFixed.turns.length > 0) {
			const stability =
				cacheStatsForFixed.instabilityTurn !== null
					? theme.fg("warning", `⚠ collapsed #${cacheStatsForFixed.instabilityTurn}`)
					: cacheStatsForFixed.cacheObserved && cacheStatsForFixed.hitRate >= 0.5
						? theme.fg("success", "stable")
						: theme.fg("muted", "warming");
			info += `${theme.fg("dim", "Prefix:")}  ${pctFmt(cacheStatsForFixed.hitRate)} hit  ${stability}\n`;
			const prefixDiag = this.session.getCachePrefixDiagnostics();
			if (prefixDiag.rebuilds > 0) {
				const breakdown = prefixDiag.reasons.map((r) => `${r.reason} ×${r.count}`).join(", ");
				info += `${theme.fg("dim", "Rewrites:")} ${prefixDiag.rebuilds}× (${breakdown})\n`;
			}
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private handleCacheStatusCommand(): void {
		const stats = this.session.getCacheStats();

		if (stats.turns.length === 0) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("muted", "No assistant turns yet — nothing to report."), 1, 0));
			this.ui.requestRender();
			return;
		}

		const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
		const pct = (r: number): string => `${Math.round(r * 100)}%`;

		let info = `${theme.bold("Cache Status")}\n\n`;
		if (!stats.cacheObserved) {
			info += `${theme.fg("muted", "No cache activity observed — this provider/model may not report prompt caching.")}\n\n`;
		}
		info += `${theme.bold("Session")}\n`;
		info += `${theme.fg("dim", "Hit rate:")}     ${pct(stats.hitRate)}\n`;
		info += `${theme.fg("dim", "Cache reads:")}  ${stats.totalCacheRead.toLocaleString()} tok\n`;
		info += `${theme.fg("dim", "Cache writes:")} ${stats.totalCacheWrite.toLocaleString()} tok\n`;
		info += `${theme.fg("dim", "Uncached in:")}  ${stats.totalInput.toLocaleString()} tok\n`;
		info += `${theme.fg("dim", "Est. saved:")}   ~${stats.estReadSavingsTokens.toLocaleString()} tok-equiv (reads billed ~10%)\n`;

		const recent = stats.turns.slice(-12);
		info += `\n${theme.bold(`Per turn (last ${recent.length})`)}\n`;
		for (const t of recent) {
			const hit = theme.fg(t.hitRate >= 0.5 ? "success" : "warning", `hit ${pct(t.hitRate)}`);
			info += `${theme.fg("dim", `#${t.index}`)}  in ${k(t.input)}  read ${k(t.cacheRead)}  write ${k(t.cacheWrite)}  ${hit}\n`;
		}

		info += "\n";
		if (stats.instabilityTurn !== null) {
			info += theme.fg(
				"warning",
				`⚠ Hit-rate collapsed at turn #${stats.instabilityTurn} — something volatile may be in the cached prefix.`,
			);
		} else if (stats.cacheObserved && stats.hitRate >= 0.5) {
			info += theme.fg("success", "✓ Prefix stable — cache hit-rate ramped and held.");
		} else if (stats.cacheObserved) {
			info += theme.fg("muted", "Cache warming up — hit-rate should rise over the next few turns.");
		}

		// Source-measured prefix churn — complements the usage-derived line above by
		// naming *what* rewrote the cacheable prefix (vs. merely flagging a collapse).
		const prefixDiag = this.session.getCachePrefixDiagnostics();
		if (prefixDiag.rebuilds > 0) {
			const breakdown = prefixDiag.reasons.map((r) => `${r.reason} ×${r.count}`).join(", ");
			info += `\n${theme.fg("dim", `Prefix rewritten ${prefixDiag.rebuilds}× this session (${breakdown}).`)}`;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	// Surfaces the process-global runtime-diagnostics channel (@pit/ai). In an
	// interactive run the underlying guards (output caps, idle timeouts, process
	// kills, retries) are otherwise invisible; this prints a per-category roll-up
	// ordered by count so the user can see what fired this session.
	private handleDiagnosticsCommand(): void {
		const text = formatRuntimeDiagnostics(getRuntimeDiagnostics());
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(text, 1, 0));
		this.ui.requestRender();
	}

	private handleTTSRCommand(rest: string): void {
		const parts = rest.split(/\s+/).filter((p) => p.length > 0);
		const sub = parts[0];
		const rules = this.settingsManager.getTTSRRules();

		if (!sub || sub === "list") {
			if (rules.length === 0) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("muted", "No TTSR rules configured."), 1, 0));
				this.ui.requestRender();
				return;
			}
			let info = `${theme.bold("TTSR Rules")}\n\n`;
			info += `${theme.fg("dim", "name | enabled | regex | message")}\n`;
			for (const rule of rules) {
				const enabled = rule.disabled ? "no" : "yes";
				info += `${rule.name} | ${enabled} | ${rule.regex} | ${rule.message}\n`;
			}
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(info, 1, 0));
			this.ui.requestRender();
			return;
		}

		if (sub === "enable" || sub === "disable") {
			const name = parts.slice(1).join(" ").trim();
			if (!name) {
				this.showWarning(`Usage: /ttsr ${sub} <name>`);
				return;
			}
			const idx = rules.findIndex((r) => r.name === name);
			if (idx < 0) {
				this.showWarning(`No TTSR rule named "${name}".`);
				return;
			}
			const updated = rules.map((r, i) => (i === idx ? { ...r, disabled: sub === "disable" } : r));
			this.settingsManager.setTTSRRules(updated);
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(
					theme.fg(
						"muted",
						`TTSR rule "${name}" ${sub === "disable" ? "disabled" : "enabled"}. Run /reload or restart to rebuild the matcher.`,
					),
					1,
					0,
				),
			);
			this.ui.requestRender();
			return;
		}

		this.showWarning("Usage: /ttsr list | enable <name> | disable <name>");
	}

	private async handleHindsightCommand(rest: string): Promise<void> {
		const parts = rest.split(/\s+/).filter((p) => p.length > 0);
		const sub = parts[0];
		const bank = getCurrentHindsightBank();

		if (!sub || sub === "list") {
			if (!bank) {
				this.showWarning("Hindsight bank is not enabled. Set `hindsight.enabled: true` in settings.json.");
				return;
			}
			const all = bank.all();
			if (all.length === 0) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("muted", "Hindsight bank is empty."), 1, 0));
				this.ui.requestRender();
				return;
			}
			const sorted = [...all].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
			let info = `${theme.bold("Hindsight (last 20 by updatedAt)")}\n\n`;
			info += `${theme.fg("dim", "id | kind | subject | body")}\n`;
			for (const entry of sorted) {
				const subject = entry.subject ?? "-";
				const body = entry.body.replace(/\s+/g, " ");
				const snippet = body.length > 60 ? `${sliceSafe(body, 0, 60)}…` : body;
				info += `${entry.id} | ${entry.kind} | ${subject} | ${snippet}\n`;
			}
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(info, 1, 0));
			this.ui.requestRender();
			return;
		}

		if (sub === "clear") {
			if (!bank) {
				this.showWarning("Hindsight bank is not enabled.");
				return;
			}
			const confirmText = parts[1];
			if (confirmText !== "--yes") {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(
					new Text(
						theme.fg(
							"warning",
							`This will clear ${bank.all().length} hindsight entries. Re-run as: /hindsight clear --yes`,
						),
						1,
						0,
					),
				);
				this.ui.requestRender();
				return;
			}
			bank.clear();
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("muted", "Hindsight bank cleared."), 1, 0));
			this.ui.requestRender();
			return;
		}

		if (sub === "export") {
			if (!bank) {
				this.showWarning("Hindsight bank is not enabled.");
				return;
			}
			const exportPath = parts.slice(1).join(" ").trim();
			if (!exportPath) {
				this.showWarning("Usage: /hindsight export <path>");
				return;
			}
			try {
				fs.writeFileSync(exportPath, JSON.stringify(bank.all(), null, 2));
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(
					new Text(theme.fg("muted", `Exported ${bank.all().length} entries to ${exportPath}`), 1, 0),
				);
				this.ui.requestRender();
			} catch (err) {
				const message = errMsg(err);
				this.showError(`Failed to export hindsight: ${message}`);
			}
			return;
		}

		this.showWarning("Usage: /hindsight list | clear [--yes] | export <path>");
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppKeybinding): string {
		return keyDisplayText(action);
	}

	/**
	 * Get capitalized display string for an editor keybinding action.
	 */
	private getEditorKeyDisplay(action: Keybinding): string {
		return keyDisplayText(action);
	}

	private handleHelpCommand(): void {
		const visible = BUILTIN_SLASH_COMMANDS.filter((command) => !command.hidden);
		const rows = visible.map((command) => `| \`/${command.name}\` | ${command.description} |`).join("\n");
		const help = `**Slash commands**
| Command | Description |
|---------|-------------|
${rows}

Type \`/hotkeys\` for keyboard shortcuts.`;

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(mutedBorderRule());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Help")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(help.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(mutedBorderRule());
		this.ui.requestRender();
	}

	private handleHotkeysCommand(): void {
		// Navigation keybindings
		const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
		const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
		const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
		const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
		const cursorWordLeft = this.getEditorKeyDisplay("tui.editor.cursorWordLeft");
		const cursorWordRight = this.getEditorKeyDisplay("tui.editor.cursorWordRight");
		const cursorLineStart = this.getEditorKeyDisplay("tui.editor.cursorLineStart");
		const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
		const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
		const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
		const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
		const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");

		// Editing keybindings
		const submit = this.getEditorKeyDisplay("tui.input.submit");
		const newLine = this.getEditorKeyDisplay("tui.input.newLine");
		const deleteWordBackward = this.getEditorKeyDisplay("tui.editor.deleteWordBackward");
		const deleteWordForward = this.getEditorKeyDisplay("tui.editor.deleteWordForward");
		const deleteToLineStart = this.getEditorKeyDisplay("tui.editor.deleteToLineStart");
		const deleteToLineEnd = this.getEditorKeyDisplay("tui.editor.deleteToLineEnd");
		const yank = this.getEditorKeyDisplay("tui.editor.yank");
		const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
		const undo = this.getEditorKeyDisplay("tui.editor.undo");
		const tab = this.getEditorKeyDisplay("tui.input.tab");

		// App keybindings
		const interrupt = this.getAppKeyDisplay("app.interrupt");
		const clear = this.getAppKeyDisplay("app.clear");
		const exit = this.getAppKeyDisplay("app.exit");
		const suspend = this.getAppKeyDisplay("app.suspend");
		const cycleThinkingLevel = this.getAppKeyDisplay("app.thinking.cycle");
		const cycleModelForward = this.getAppKeyDisplay("app.model.cycleForward");
		const selectModel = this.getAppKeyDisplay("app.model.select");
		const expandTools = this.getAppKeyDisplay("app.tools.expand");
		const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
		const externalEditor = this.getAppKeyDisplay("app.editor.external");
		const cycleModelBackward = this.getAppKeyDisplay("app.model.cycleBackward");
		const followUp = this.getAppKeyDisplay("app.message.followUp");
		const dequeue = this.getAppKeyDisplay("app.message.dequeue");
		const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");
		const cyclePermission = this.getAppKeyDisplay("app.permission.cycle");

		let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history (Up when empty) |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${cyclePermission}\` | Cycle mode (plan → auto → fusion) |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste image from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

		// Add extension-registered shortcuts
		const extensionRunner = this.session.extensionRunner;
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size > 0) {
			hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
			for (const [key, shortcut] of shortcuts) {
				const description = shortcut.description ?? shortcut.extensionPath;
				const keyDisplay = formatKeyText(key, { capitalize: true });
				hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
			}
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(mutedBorderRule());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(mutedBorderRule());
		this.ui.requestRender();
	}

	private async handleClearCommand(): Promise<void> {
		this.stopWorkingLoader();
		try {
			const result = await this.runtimeHost.newSession();
			if (result.cancelled) {
				return;
			}
			this.renderCurrentSessionState();
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1));
			this.ui.requestRender();
		} catch (error: unknown) {
			await this.handleFatalRuntimeError("Failed to create session", error);
		}
	}

	private handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);

		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
		);
		this.ui.requestRender();
	}

	private handleArminSaysHi(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ArminComponent(this.ui));
		this.ui.requestRender();
	}

	private handleDementedDelves(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new EarendilAnnouncementComponent());
		this.ui.requestRender();
	}

	private handleDaxnuts(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DaxnutsComponent(this.ui));
		this.ui.requestRender();
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
			this.handleDaxnuts();
		}
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		const eventResult = await extensionRunner.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: this.sessionManager.getCwd(),
		});

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.ui.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		const entries = this.sessionManager.getEntries();
		const messageCount = entries.filter((e) => e.type === "message").length;

		if (messageCount < 2) {
			this.showWarning("Nothing to compact (no messages yet)");
			return;
		}

		this.stopWorkingLoader();

		try {
			await this.session.compact(customInstructions);
		} catch {
			// Ignore, will be emitted as an event
		}
	}

	stop(): void {
		this.unregisterSignalHandlers();
		this.setTerminalProgress(false);
		this.clearInterruptWatchdog();
		if (this._themePreviewInvalidateTimer) {
			clearTimeout(this._themePreviewInvalidateTimer);
			this._themePreviewInvalidateTimer = undefined;
		}
		this.ephemeralStatus.dispose();
		// Drop the hero-ignition ticker if the ease is still mid-flight at teardown.
		this.heroIgnitionUnsub?.();
		this.heroIgnitionUnsub = null;
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.clearExtensionTerminalInputListeners();
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.diagnosticsUnsubscribe) {
			this.diagnosticsUnsubscribe();
			this.diagnosticsUnsubscribe = undefined;
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}
}

/**
 * True when any assistant message has thinking content but no text — toggling
 * hide-thinking in grouped mode changes whether that message gets a bubble.
 */
export function sessionHasThinkingOnlyAssistant(messages: ReadonlyArray<unknown>): boolean {
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const message = raw as { role?: string; content?: unknown };
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		let hasText = false;
		let hasThinking = false;
		for (const block of message.content) {
			if (!block || typeof block !== "object") continue;
			const c = block as { type?: string; text?: string; thinking?: string };
			if (c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0) {
				hasText = true;
			}
			if (c.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim().length > 0) {
				hasThinking = true;
			}
		}
		if (hasThinking && !hasText) return true;
	}
	return false;
}
