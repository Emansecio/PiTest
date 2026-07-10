/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	AgentToolCall,
	ThinkingLevel,
} from "@pit/agent-core";
import { isStreamGuardAbortMessage, setUnknownToolHintProvider } from "@pit/agent-core";
import type { AssistantMessage, ImageContent, Message, Model, TextContent } from "@pit/ai";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	DEFAULT_IDLE_TIMEOUT_MS,
	getRuntimeDiagnostics,
	getSupportedThinkingLevels,
	isContextOverflow,
	isEntryCooledDown,
	markEntryCooldown,
	modelsAreEqual,
	onDiagnostic,
	prewarmProviderModule,
	recordDiagnostic,
	resetApiProviders,
	splitSystemPromptOnDynamic,
	streamSimple,
} from "@pit/ai";
import { theme } from "../modes/interactive/theme/theme.ts";
import { settleOrAbort } from "../utils/abort-race.ts";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { sleep } from "../utils/sleep.ts";
import { sliceSafe } from "../utils/surrogate.ts";
import {
	applyMidTurnPressureRelief,
	awaitBackgroundCompaction,
	CompactionController,
	type CompactionHost,
	checkCompaction,
	checkPresendOverflow,
	compactSession,
	measureMidTurnWirePressure,
	resolveCompactModel,
} from "./agent-session-compaction.ts";
import {
	type AgentSessionEvent,
	AgentSessionEventBus,
	type AgentSessionEventListener,
} from "./agent-session-events.ts";
import { type FusionHost, runFusionSessionTurn } from "./agent-session-fusion.ts";
import {
	applyLightContextEconomyAtTurnEnd,
	applyLiveContextEconomyAfterToolSuccess,
} from "./agent-session-live-prune.ts";
import {
	armVerificationGate,
	upsertLearnedErrorOnFailure,
	type VerificationGateState,
} from "./agent-session-tool-end.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import { type CacheStats, computeCacheStats } from "./cache-stats.js";
import {
	ChromeDevtoolsManager,
	getCurrentChromeDevtoolsManager,
	setCurrentChromeDevtoolsManager,
} from "./chrome/chrome-devtools-manager.ts";
import { buildHarnessDispatcher, type CodeModeDispatcher } from "./code-mode/bridge.ts";
import {
	adaptivePruneThreshold,
	applyOldThinkingCap,
	applySupersedeOnly,
	cloneToolResultMessagesForPrune,
	planContextPrune,
	pressurePruneProtectTurns,
	pruneOldToolOutputs,
	wouldApplyOldThinkingCap,
	wouldApplySupersedeOnly,
	wouldPruneOldToolOutputs,
} from "./compaction/compaction.ts";
import {
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	estimateContextTokens,
	estimateTokens,
	estimateWireTokens,
	generateBranchSummary,
	proactivePruneFloor,
	type WireToolSurface,
} from "./compaction/index.ts";
import { extractToolFileOp } from "./compaction/utils.js";
import { composeContext, isContextComposerDisabled } from "./conditioning/context-composer.ts";
import { buildAsyncDeliveryBody } from "./coordinator/async-delivery.ts";
import { SubagentRegistry, spawnSubagent } from "./coordinator/index.ts";
import { dapSessionManager } from "./dap/index.ts";
import { debugVerifyContextPrompt, maybeRunDebugVerify } from "./debug-verify.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import {
	createDeferredOutputStore,
	getCurrentDeferredOutputStore,
	setCurrentDeferredOutputStore,
} from "./deferred-output-store.ts";
import { getEngineeringStyleGuidelines } from "./engineering-styles.js";
import {
	createEvalKernelManager,
	type EvalKernelManager,
	getCurrentEvalKernelManager,
	setCurrentEvalKernelManager,
} from "./eval-kernel/index.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.js";
import { emitSessionShutdownEvent } from "./extensions/runner.js";
import {
	computeFrequentFiles,
	defaultFrequentFilesPath,
	type FrequentFile,
	FrequentFilesTracker,
	loadFrequentFilesSnapshot,
	saveFrequentFilesSnapshot,
} from "./frequent-files.js";
import type { Orchestration } from "./fusion/types.ts";
import { readGitBranch } from "./git-state.js";
import {
	GoalManager,
	type GoalSnapshot,
	type GoalState,
	getCurrentGoalManager,
	setCurrentGoalManager,
} from "./goal/goal-manager.ts";
import {
	defaultBankPath,
	ensureBankDir,
	formatHindsightHintForPrompt,
	formatSessionSummariesForPrompt,
	getCurrentHindsightBank,
	type HindsightBank,
	openBank,
	setCurrentHindsightBank,
} from "./hindsight/index.js";
import { getCurrentHistoryRecallSource, setCurrentHistoryRecallSource } from "./history-recall.ts";
import { defaultLearnedErrorsDir, type LearnedErrorEntry, persistSessionLearnedErrors } from "./learned-error-store.js";
import { createLspManager, getCurrentLspManager, type LspManager, setCurrentLspManager } from "./lsp/manager.ts";
import { setDiagnosticsOnWrite, setEnforceDiagnosticsOnWrite, setFormatOnWrite } from "./lsp/writethrough.ts";
import { formatMemoryForPrompt, formatMemoryHintForPrompt } from "./memory/index.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import {
	agentMessageBus,
	MESSAGE_RELAY_CUSTOM_TYPE,
	type MessageActivity,
	makeAgentDelivery,
	makeAgentResponder,
} from "./messaging/index.ts";
import type { ModelRegistry } from "./model-registry.js";
import { type RoleResolution, resolveRole } from "./model-resolver.js";
import { getCurrentPlanManager, PlanManager, type PlanState, setCurrentPlanManager } from "./plan/plan-manager.ts";
import {
	createPreviewQueue,
	getCurrentPreviewQueue,
	type PreviewQueue,
	setCurrentPreviewQueue,
} from "./preview-queue.ts";
import { expandPromptTemplate, type PromptTemplate, parseCommandArgs, substituteArgs } from "./prompt-templates.js";
import { getLivingRepoMap, type LivingRepoMap } from "./repo-map/living-index.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.js";
import {
	clearCurrentSelfReviewFindings,
	runSelfReviewLoop,
	SELF_REVIEW_SCHEMA,
	SELF_REVIEW_TIMEOUT_MS,
	type SelfReviewResult,
	type SelfReviewRunner,
} from "./self-review.ts";
import { getCurrentSessionContract, SessionContract, setCurrentSessionContract } from "./session-contract.ts";
import type { BranchSummaryEntry, SessionManager } from "./session-manager.js";
import { CURRENT_SESSION_VERSION, getLatestCompactionEntry, type SessionHeader } from "./session-manager.js";
import { type RecoveryLevel, SessionRecoveryController } from "./session-recovery.ts";
import type { SettingsManager } from "./settings-manager.js";
import type { SlashCommandInfo } from "./slash-commands.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";
import { getCurrentSupervisionThermostat } from "./supervision-thermostat.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt, patchSystemPromptToolSurface } from "./system-prompt.js";
import { DiagnosticsSink, defaultDiagnosticsDir, isTelemetrySinkDisabled } from "./telemetry/diagnostics-sink.ts";
import { GuardEfficacyCorrelator } from "./telemetry/guard-efficacy.ts";
import { buildSessionSummaryRecord } from "./telemetry/session-summary.ts";
import {
	getCurrentTodoManager,
	setCurrentTodoManager,
	type TodoItem,
	TodoManager,
	type TodoState,
} from "./todo/todo-manager.ts";
import {
	getCurrentTokenGovernor,
	setCurrentTokenGovernor,
	TokenBudgetGovernor,
	type TokenBudgetSnapshot,
} from "./token-governor.ts";
import {
	extractErrorMessage,
	fingerprintToolArgsExact,
	fingerprintToolResult,
	ToolCallStats,
	type ToolStat,
} from "./tool-call-stats.js";
import {
	buildHiddenToolHint,
	createToolDiscoveryIndex,
	getCurrentToolDiscoveryIndex,
	setCurrentToolDiscoveryIndex,
	type ToolDiscoveryIndex,
} from "./tool-discovery.ts";
import { agentToolToWireSurface, compactToolsForProviderContext, compactWireToolSurface } from "./tool-wire-schema.ts";
import {
	type BashBackgroundJob,
	type BashOperations,
	createLocalBashOperations,
	listBashBackgroundJobs,
} from "./tools/bash.js";
import { prewarmFffIndex } from "./tools/fff-search.ts";
import { FileMtimeStore } from "./tools/file-mtime-store.ts";
import { chromeFeatureToolNames, createAllToolDefinitions } from "./tools/index.js";
import { ReadDedupeStore } from "./tools/read.js";
import { listDeclarations } from "./tools/symbol.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.js";
import { configureTruncationCaps } from "./tools/truncate.ts";
import { TurnRiskAccumulator } from "./turn-risk.ts";
import { TurnSteeringEngine } from "./turn-steering-engine.ts";
import { registerBuiltinSchemes } from "./url-schemes/index.ts";
import { summarizeCheckFailure } from "./verification/failure-summary.ts";
import { functionalWebFixPrompt, runFunctionalWebCheck } from "./verification/functional-web.ts";
import { pendingVerificationJobs } from "./verification/pending-checks.ts";
import {
	type CheckResult,
	detectCheckCommand,
	detectSyntaxFallbackCommand,
	getCurrentVerificationProbe,
	runCheckCommand,
	setCurrentVerificationProbe,
} from "./verification/verification.ts";

export type { AgentSessionEvent, AgentSessionEventListener } from "./agent-session-events.ts";
// Re-export skill-parser utilities (moved to dedicated module)
export { type ParsedSkillBlock, parseSkillBlock } from "./skill-parser.ts";

// `FusionSummaryData` (the render-agnostic summary of a completed Fusion turn) lives in
// ./fusion/types.ts so both the core layer and the TUI presentation share one shape.

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for skills, prompts, themes, context files, system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** When true, suppress the hashline-anchor block normally appended to full-file reads. */
	disableHashlineAnchors?: boolean;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
// A fingerprint that has failed this many times in the current session gets a
// live Tier 4 hint rule registered (2 = the second failure arms it, so the
// third occurrence is the first to carry the corrective hint).

// LRU cap on the in-memory learned-error store. The fingerprint normalizes only
// digits, so path/identifier-varied errors mint unbounded distinct keys over a
// long exploration session. Evict the least-recently-used (coldest) entry when a
// NEW key would exceed the cap — cold entries are the least useful to the
// recurring-error guard, and the disk persist iterates values order-insensitively.

const FREQUENT_FILES_DISPOSE_WAIT_MS = 2_500;

/**
 * Fraction of the context window above which the pre-send overflow guard forces a
 * compaction, measured on the assembled payload (last usage + trailing tool
 * results). Kept high so it only catches an imminent overflow the normal
 * threshold check — which keys off `usage` alone — would miss.
 */

/** Build the continuation prompt that re-injects a failed verification check. */
function verificationFixPrompt(
	command: string,
	result: { exitCode: number; output: string; timedOut: boolean },
): string {
	const tail = summarizeCheckFailure(result.output, command);
	const status = result.timedOut ? "timed out" : `exited ${result.exitCode}`;
	return [
		`The change isn't verified yet — I ran the project check and it ${status}:`,
		"",
		`$ ${command}`,
		tail || "(no output)",
		"",
		"Fix the underlying cause and keep going; don't report the work done until this check passes. If the failure is pre-existing and unrelated to this change, say so explicitly instead of forcing a fix.",
	].join("\n");
}

/**
 * Distinctive "the work is finished" phrases, used ONLY to optionally append a
 * single contradiction sentence to the terminal verification message. Kept short
 * and high-signal; this is best-effort and locale-limited by design — a miss just
 * omits one sentence, a false hit only appends one, neither changes flow.
 */
const COMPLETION_PHRASES: readonly string[] = [
	"all done",
	"task is complete",
	"task complete",
	"task is done",
	"successfully completed",
	"is now complete",
	"all set",
	"completed the task",
	"the fix is complete",
	// pt-BR
	"tarefa concluída",
	"está concluído",
	"está pronto",
	"tudo certo",
];

/**
 * Terminal message injected when the project check is STILL failing after the
 * fix budget is exhausted. Distinct from `verificationFixPrompt`: it does NOT ask
 * for another fix (the loop is over) — it tells the model the check is still red
 * and to summarize honestly instead of declaring the task done. When the model's
 * last message already implied completion, `contradictClaim` appends one sentence
 * making the contradiction explicit.
 */
function verificationExhaustedPrompt(
	command: string,
	result: { exitCode: number; output: string; timedOut: boolean },
	attempts: number,
	contradictClaim: boolean,
): string {
	const tail = summarizeCheckFailure(result.output, command);
	const status = result.timedOut ? "timed out" : `exited ${result.exitCode}`;
	const attemptWord = attempts === 1 ? "attempt" : "attempts";
	const lines = [
		`The check \`${command}\` is STILL failing (${status}) after ${attempts} fix ${attemptWord}:`,
		"",
		`$ ${command}`,
		tail || "(no output)",
		"",
		"Do NOT report the task as done. Give an honest summary of what is still broken and what you tried, so the user can decide how to proceed.",
	];
	if (contradictClaim) {
		lines.push(
			"Your previous message implied the work was complete — that directly contradicts the still-failing check above. Correct that claim explicitly.",
		);
	}
	return lines.join("\n");
}

/**
 * Terminal message injected when the turn is about to hand back to the user while
 * a test/check the agent backgrounded is unfinished or failed. Keeps the agent
 * from reporting done / suggesting a commit on a result it never actually saw —
 * the exact "committed, then the test came back red" failure mode.
 */
function pendingChecksPrompt(failed: BashBackgroundJob[], running: BashBackgroundJob[]): string {
	const lines: string[] = [];
	if (failed.length > 0) {
		lines.push(
			"A test/check you ran in the background has FAILED. Do NOT report the task as done or suggest committing — the project is in a broken state.",
		);
		for (const job of failed) {
			const tail = summarizeCheckFailure(job.ringBuffer ?? "", job.command);
			lines.push("", `$ ${job.command}  (id=${job.id}, exit ${job.exitCode})`, tail || "(no output captured)");
		}
		lines.push("", "Fix the cause, re-run the check to green, and only then conclude.");
	} else if (running.length > 0) {
		lines.push(
			"A test/check you started in the background is STILL running. Do NOT report the task as done or suggest committing until it has finished and passed:",
		);
		for (const job of running) lines.push(`  • id=${job.id}: ${job.command}`);
		lines.push(
			"",
			"Wait for it to finish and confirm it passed before concluding. If it is a watcher that never exits, say so explicitly instead of assuming success.",
		);
	}
	return lines.join("\n");
}

/** Nudge the agent to actually look at a rendered artifact it changed but never previewed. */
function visualNudgePrompt(file: string): string {
	return [
		`You changed a rendered visual artifact (${file}) but didn't look at it this turn.`,
		"Before reporting done, render it with the `preview` tool (pass the file, a served directory, or your dev-server URL), then review the screenshot and the console/network for defects. If it can't be rendered (no browser, or it isn't independently viewable), say so explicitly instead of assuming it looks right.",
	].join("\n");
}

/**
 * Minimum interval between turn-driven goal persistence writes. Status changes
 * always persist immediately; token/iteration progress is throttled so a long
 * goal doesn't append a custom entry on every single turn.
 */
const GOAL_PERSIST_THROTTLE_MS = 10_000;

export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

/** Minimum abandoned-branch entries before `/tree` pays for an LLM summary. */
const BRANCH_SUMMARY_MIN_ENTRIES = 3;

// Hoisted so it isn't recompiled on every error message checked for retry.
const RETRYABLE_ERROR_RE =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|529|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

/**
 * Hard cap on a single auto-retry backoff wait, so a long provider-overloaded
 * (HTTP 529) window can't push a late attempt into a multi-minute sleep while
 * still letting the backoff grow enough to ride out the outage.
 */
const RETRY_MAX_DELAY_MS = 30_000;

// Adaptive idle-timeout backoff: a consistently slow provider re-fires the same
// idle timeout on every retry. Scale the body idle window ×1.5 per CONSECUTIVE
// idle-timeout retry (capped) so a genuinely slow-but-alive stream gets more room
// each attempt, then reset to the configured default on the next success.
const IDLE_BACKOFF_FACTOR = 1.5;
const IDLE_BACKOFF_MAX_MS = 300_000;
// Matches IdleStreamTimeoutError's message ("Stream idle timeout ... timed out").
const IDLE_TIMEOUT_ERROR_RE = /idle timeout|idlestreamtimeout/i;

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession implements CompactionHost, FusionHost {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventBus!: AgentSessionEventBus;
	readonly compaction!: CompactionController;

	// Fusion orchestration facet (session-local; resets to "solo" on a new session in v1).
	private _orchestration: Orchestration = "solo";
	// In-flight Fusion turn (panel fan-out + judge + writer). Aborted by interrupt().
	private _fusionAbort: AbortController | undefined = undefined;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/**
	 * Images attached out-of-band (e.g. clipboard paste in the TUI) to be merged
	 * into the NEXT user prompt's content. Consumed and cleared the first time a
	 * user message is built in `_promptOnce`, so a pasted image rides along with
	 * whatever text the user submits next regardless of which prompt path fires.
	 */
	private _attachedImages: ImageContent[] = [];

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	// Count of CONSECUTIVE idle-timeout retries, driving the adaptive idle backoff.
	// Reset to 0 on any non-idle retryable error and on a successful response.
	private _idleTimeoutRetryCount = 0;
	// Models in the active fallback chain that have already been tried this turn.
	// Reset on successful assistant response and at every run boundary
	// (_restoreFallbackModelIfActive) so an exhausted-chain run that ends in error
	// does not leave entries permanently tried; per-entry cooldown is the only
	// cross-run memory.
	private _triedFallbackEntries: Set<string> = new Set();
	// Original (primary) model + thinking level captured when the chain begins,
	// so we can revert if every chain entry fails and the agent retries.
	private _fallbackOriginal?: { model: Model<any>; thinkingLevel: ThinkingLevel };

	// Bash execution state
	private _bashAbortController: AbortController | undefined = undefined;
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _disableHashlineAnchors: boolean;
	private readonly _readDedupeStore: ReadDedupeStore | undefined;
	private readonly _fileMtimeStore: FileMtimeStore | undefined;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	// Model registry for API key resolution
	private _modelRegistry: ModelRegistry;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Per-session tool-call telemetry. Fed from tool_execution_end events.
	private readonly _toolCallStats = new ToolCallStats();

	// Per-session counters for the tool-rewrite registry. Maps tool name -> rule id -> count.
	// Drives the optional stats export on dispose so we can measure how often
	// each rule fires across real sessions.
	private readonly _registryRewrites = new Map<string, Map<string, number>>();
	private readonly _registryRejects = new Map<string, Map<string, number>>();
	// Per-session counter for Tier 4 error-hint rules: rule id -> fire count.
	// Mirrors the rewrite/reject counters so getRegistryStats() can expose which
	// hints actually fire across real sessions — previously hints were only held
	// transiently per toolCallId (_hintsByToolCallId) and dropped, leaving them
	// unmeasurable against tool error-rate deltas.
	private readonly _registryHints = new Map<string, number>();

	// Cross-session learned errors. Built during the session from
	// tool_error_hint_applied + tool_execution_end events; persisted incrementally
	// at each turn_end (and again on dispose) so the next session boots warm with
	// knowledge of recurring patterns — even when this session is killed/crashes
	// before teardown.
	private readonly _learnedErrors = new Map<string, LearnedErrorEntry>();
	// Set whenever `_learnedErrors` is mutated (new fingerprint or count bump) and
	// cleared by `_flushLearnedErrorsIfDirty`. Gates the per-turn flush so a turn
	// that learned nothing new triggers no writeFileSync/pruneOldFiles.
	private _learnedErrorsDirty = false;
	// Keys for which a same-session Tier 4 hint rule has already been registered
	// live, so a recurring fingerprint materialises its rule exactly once.
	private readonly _sameSessionHintKeys = new Set<string>();
	// Transient: which Tier 4 rules fired per in-flight toolCallId. Read once
	// in _handleToolExecutionEnd and dropped to keep memory bounded.
	private readonly _hintsByToolCallId = new Map<string, string[]>();
	// Transient: toolCallIds rejected pre-flight by the rewrite registry
	// (Tier 2 suggest / Tier 3 block). Their error text is a deliberate
	// registry message, not a model failure pattern worth learning — recording
	// it would materialise dynamic Tier 4 rules that hint about our own
	// refusal strings. Read once in _handleToolExecutionEnd and dropped.
	private readonly _rejectedToolCallIds = new Set<string>();

	// Per-session frequent-files tracker. Recorded on successful file-tool calls
	// and surfaced in the system prompt when settings.frequentFiles.enabled.
	private _frequentFiles: FrequentFilesTracker = new FrequentFilesTracker();

	// Repo-level frequent-files index (git log → mtime fallback). Computed at
	// session boot and cached for the lifetime of the session. A future
	// `_recomputeFrequentFiles` slash command may invalidate this.
	private _frequentFilesIndex: FrequentFile[] = [];
	private _hotFileOutlines: Array<{ path: string; symbols: string[] }> = [];
	private _frequentFilesAbort: AbortController | undefined;

	// Band P (P1/P3) context composer. The enriched living repo-map is cached from
	// the boot prewarm (and refreshed opportunistically); the composed block is
	// rebuilt per turn from the live prompt + most-recently-read file and rendered
	// in the dynamic suffix (cache-neutral). All best-effort — undefined/empty just
	// omits the block. Off entirely under PIT_NO_CONTEXT_COMPOSER.
	private _livingRepoMap: LivingRepoMap | undefined;
	private _composerPromptText = "";
	private _composerLastReadPath: string | undefined;
	private _composerLastReadContent: string | undefined;
	// Promise returned by the in-flight `computeFrequentFiles` call. Tracked so
	// `dispose()` can await it before returning, otherwise the spawned `git`
	// child still holds the cwd and `rmSync(tempDir)` in tests fails with EBUSY.
	private _frequentFilesPromise: Promise<unknown> | undefined;

	// Args captured at tool_execution_start so the tool_execution_end handler can
	// reference them (the end event only carries result/isError). Bounded by the
	// number of in-flight tool calls and aggressively pruned on completion.
	private readonly _toolCallArgsByCallId = new Map<string, unknown>();

	// Band P — Fase 0 telemetry. Durable per-session diagnostics sink + the
	// guard→next-call efficacy correlator that feeds it. Both are best-effort and
	// only wired for persisted sessions (see _initTelemetrySink); undefined means
	// telemetry is off (in-memory session, or PIT_NO_TELEMETRY_SINK=1).
	private _diagnosticsSink: DiagnosticsSink | undefined;
	private _guardEfficacy: GuardEfficacyCorrelator | undefined;
	private _guardEfficacyUnsub: (() => void) | undefined;
	// Session-wide verification-gate tally for the session-summary snapshot.
	private _verificationAttemptsTotal = 0;
	private _verificationFailuresTotal = 0;

	// Band P / P4: per-prompt-cycle patch-risk aggregator. Sums changed lines across
	// every successful write/edit this cycle so many small edits still trip the
	// high-risk self-review (the gap a per-patch scorer misses). Reset each prompt.
	private readonly _turnRisk = new TurnRiskAccumulator();

	// Reactive session recovery: lean by default, escalates on thrash signals.
	private readonly _recovery: SessionRecoveryController;
	// Per-session steering/reminder policy engine: owns the doom-loop / result-loop /
	// repeating-pattern / cross-error / stagnation / todo-cadence / failure-budget
	// detectors and their once-per-streak latches + the per-turn failure budget.
	// Created in the constructor once its injected collaborators exist.
	private readonly _steering: TurnSteeringEngine;

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;

	// Prompt-cache prefix diagnostics. Only the cache-stable prefix (everything
	// before SYSTEM_PROMPT_DYNAMIC_MARKER) matters for prompt caching: rewriting
	// it re-bills the whole prefix, while dynamic-suffix churn (date, cwd,
	// frequent-files) is free. Measured at the source in _rebuildSystemPrompt to
	// complement the usage-derived `instabilityTurn` in computeCacheStats with a
	// root-cause count. The first observed prefix is the baseline (never counted).
	// Note: rebuilds triggered during boot can register here too — they are cheap
	// (nothing is cached pre-first-request) but honest to surface.
	private _cachePrefixBaseline: string | undefined;
	private _cachePrefixRebuilds = 0;
	// Stable per-session count of discovery-hidden tools. Snapshotted once after
	// _seedToolDiscovery so the search_tool_bm25 nudge sits in the cacheable
	// prefix from the first request instead of flipping 0→N (and churning the
	// cache) when the live index is first consulted on a later rebuild.
	private _hiddenToolCountSnapshot = 0;
	private readonly _cachePrefixReasons = new Map<string, number>();

	// Hindsight memory bank, opened in the constructor when settings enable it.
	private _hindsightBank: HindsightBank | undefined;

	// Deferred-output store for PIT_DEFER_HISTORY=1. Session-scoped temp dir;
	// disposed on session close.
	private _deferredOutputStore: import("./deferred-output-store.ts").DeferredOutputStore | undefined;

	// Preview queue for staged mutations (edit/write/edit_v2 with preview:true).
	// Published via the module-level registry so tools can pull it on demand.
	private _previewQueue: PreviewQueue | undefined;

	// Autonomous goal state (the /goal command + goal_complete tool). Published
	// via the module-level registry so the tool can reach it on demand.
	private readonly _goal = new GoalManager();
	private readonly _tokenGovernor = new TokenBudgetGovernor();
	// Native todo list (the `todo` tool + /todos command + live overlay).
	private readonly _todo = new TodoManager();
	private readonly _plan = new PlanManager();
	/** Published to goal_complete via setCurrentVerificationProbe; cleared on dispose. */
	private _verificationProbe: (() => Promise<CheckResult | null>) | undefined;
	/** Band P / P5 conventions contract; registry-published, released on dispose. */
	private _sessionContract: SessionContract | undefined;
	// Chrome DevTools controller (the chrome_devtools_* tools + /chrome command).
	private _chromeDevtools: ChromeDevtoolsManager | undefined;
	// Guards against re-entering the goal auto-continuation loop from within a
	// continuation prompt.
	private _inGoalContinuation = false;
	// Set as the first synchronous step of dispose(). An orphaned subagent can settle
	// AFTER the session is torn down; _deliverAsyncResult checks this to drop the late
	// result instead of mutating a dead session (re-injecting a phantom turn).
	private _disposed = false;
	// Raised by interrupt() (Esc) and cleared when the next user prompt starts.
	// Makes the goal auto-continuation loop and the verification gate stop
	// re-dispatching the agent after the user cancels mid-task — without it, Esc
	// only aborts the current turn and the orchestration loop immediately restarts.
	private _userInterrupted = false;
	// Native verification gate: `_turnTouchedFiles` arms it (set when a file tool
	// writes/edits this prompt cycle), `_inVerification` guards re-entry, and
	// `_verificationAbort` cancels an in-flight check on interrupt/dispose.
	private _turnTouchedFiles = false;
	// Absolute paths of files this prompt cycle modified (op !== "read"). Feeds
	// debug-driven verify (`maybeRunDebugVerify`) so it can locate the touched
	// test/source as a runtime repro. Reset alongside `_turnTouchedFiles`.
	private readonly _turnTouchedFilePaths = new Set<string>();
	// Dominant source file:line edited this prompt cycle (from edit/edit-hashline
	// `firstChangedLine`). Refines the debug-verify breakpoint to the corrected
	// statement via `withFixSite`; last qualifying edit wins. Reset with the set above.
	private _turnFixSite: { file: string; line: number } | undefined;
	private _inVerification = false;
	private _verificationAbort: AbortController | undefined;
	// Pending-checks drain: blocks handoff while background verification jobs settle.
	private _inPendingChecksDrain = false;
	private _pendingChecksAbort: AbortController | undefined;
	// Visual definition-of-done tracking: did this prompt cycle change a rendered
	// artifact, did the agent actually `preview` it, and the last such file.
	private _turnTouchedVisual = false;
	private _turnUsedPreview = false;
	private _lastVisualFile: string | undefined;
	// Throttle state for turn-driven goal persistence.
	private _lastGoalStatus: string | undefined;
	private _lastGoalPersistMs = 0;

	// Hidden tool discovery index. Published at session boot so the
	// `search_tool_bm25` tool can BM25-search specialized tools that are NOT
	// in the active surface and (on request) pull them in on demand.
	private _toolDiscoveryIndex: ToolDiscoveryIndex | undefined;

	// Cache for getActiveToolNames() — keyed by array identity so it stays
	// fresh whenever setActiveToolsByName() reatribui agent.state.tools.
	private _activeToolNamesCache?: { tools: unknown; names: string[] };

	// Per-session eval kernel manager. Holds the persistent Python + JS kernels
	// for the `eval` tool. Spawned in the constructor when settings enable it;
	// kernels themselves are spawned lazily on first use by the manager.
	private _evalKernelManager: EvalKernelManager | undefined;
	private _lspManager: LspManager | undefined;
	private _messagingId?: string;
	private _unsubMessagingActivity?: () => void;

	constructor(config: AgentSessionConfig) {
		// Idempotent: registers built-in URL schemes (pr://, issue://, conflict://)
		// on the singleton registry so read/write tools can dispatch virtual paths.
		registerBuiltinSchemes();
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRegistry = config.modelRegistry;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._disableHashlineAnchors = config.disableHashlineAnchors ?? false;
		// Per-session de-dup of identical repeat reads. On by default; PIT_READ_DEDUPE=0
		// disables. Content-hashed + LRU-bounded, so edited or long-ago reads re-send.
		this._readDedupeStore =
			typeof process !== "undefined" && process.env.PIT_READ_DEDUPE === "0" ? undefined : new ReadDedupeStore();
		// Per-session file mtime tracking for the stale-read warning: edit/write flag
		// a file that changed on disk since the model read it. PIT_NO_STALE_READ_WARNING=1 disables.
		this._fileMtimeStore =
			typeof process !== "undefined" && process.env.PIT_NO_STALE_READ_WARNING === "1"
				? undefined
				: new FileMtimeStore();
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };

		// The boot-time model decides the supervision thermostat's start level
		// (native anthropic/openai start `leve`). A later /model switch does not
		// re-seed the start level — the thermostat is per-session and observe-only
		// in Fase 0; behavior earned in-session dominates the prior anyway.
		this._recovery = new SessionRecoveryController({ model: this.agent.state.model });

		// The boot-time model also scales the shared tool-output byte caps
		// (DEFAULT/BASH/hard-cap floors at ≤200k-token windows, up to 2× at 1M —
		// see configureTruncationCaps). Must run before _buildRuntime below so
		// tool descriptions advertise the scaled budgets. Same convention as the
		// thermostat above: a later /model switch does not re-scale.
		configureTruncationCaps({ contextWindow: this.agent.state.model?.contextWindow ?? 0 });

		// Band P conventions contract (P5): session-scoped, reached by
		// failure-summary (extraction) and system-prompt (injection) via the module
		// registry — without this registration the whole pillar is inert.
		this._sessionContract = new SessionContract();
		setCurrentSessionContract(this._sessionContract);

		// Steering/reminder policy engine. Reads settings + the (already standalone)
		// tool-call stats and todo manager, and posts steers/follow-ups via
		// sendCustomMessage — it never reaches back into the session. Created here
		// because its collaborators (settingsManager assigned above; _toolCallStats /
		// _todo field-initialized) all exist by the time the constructor body runs.
		this._steering = new TurnSteeringEngine({
			settingsManager: this.settingsManager,
			toolCallStats: this._toolCallStats,
			todo: this._todo,
			sendCustomMessage: this.sendCustomMessage.bind(this),
			recovery: this._recovery,
		});

		// Size the frequent-files tracker from settings so an opt-in user with a
		// very large session does not silently lose hot files to the default cap.
		const freqCfg = this.settingsManager.getFrequentFilesSettings();
		this._frequentFiles = new FrequentFilesTracker({
			maxFiles: freqCfg.maxFiles,
		});

		// Hydrate the tracker from <cwd>/.pit/frequent-files.json so a fresh
		// session re-uses the previous session's hot-file ranking instead of
		// the model re-discovering it via repeated reads. Best-effort — a
		// missing/corrupt file just leaves the tracker empty.
		if (freqCfg.enabled) {
			try {
				this._frequentFiles.loadSnapshot(loadFrequentFilesSnapshot(defaultFrequentFilesPath(this._cwd)));
			} catch {
				// best-effort hydrate; never block boot
			}
		}

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installContextPruneHook();
		this._installPrepareNextTurnHook();
		this._installWireToolEconomyHook();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});

		this._eventBus = new AgentSessionEventBus({
			onListenerError: (event, err) => {
				this._extensionRunner.emitError({
					extensionPath: "<event-listener>",
					event: `emit:${event.type}`,
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
				recordDiagnostic({
					category: "error.isolated",
					level: "error",
					source: "agent-session._emit",
					context: { note: event.type },
				});
			},
		});
		this.compaction = new CompactionController(this);

		this._openHindsightBank();
		this._openDeferredOutputStore();
		this._publishHistoryRecallSource();
		this._initTelemetrySink();

		// Compute the repo-level "frequent files" index in the background. First
		// turn may miss it; subsequent turns get the list in the system prompt's
		// dynamic suffix (after the cache marker), so the late arrival never
		// invalidates the cacheable prefix. Cheap: bounded by a 2s git timeout +
		// a fallback fs walk.
		this._kickoffFrequentFilesIndex();
		// Background index prewarm targets real git worktrees only: ephemeral test
		// temp dirs (no .git) would keep native scanners / cache writers busy and
		// EBUSY follow-up rmSync on Windows (see living-index runGit comment).
		const prewarmIndexes = existsSync(join(this._cwd, ".git"));
		if (prewarmIndexes && this.settingsManager.getGrepSettings().engine === "fff") {
			prewarmFffIndex(this._cwd);
		}
		if (prewarmIndexes) {
			void this._refreshLivingRepoMap();
		}

		// Publish a fresh preview queue for this session so mutation tools can
		// stage previews and the `resolve` tool can commit/discard them.
		this._previewQueue = createPreviewQueue();
		setCurrentPreviewQueue(this._previewQueue);

		// Publish the goal manager and restore any persisted goal from the
		// session file so `/reload` and reopening keep an unfinished goal.
		this._tokenGovernor.bindGoal(this._goal);
		setCurrentGoalManager(this._goal);
		setCurrentTokenGovernor(this._tokenGovernor);
		this._restoreGoalFromSession();

		// Same for the todo list: publish it. Restore already happened above via
		// _restoreGoalFromSession → _restoreStateFromSession (restores both).
		setCurrentTodoManager(this._todo);
		setCurrentPlanManager(this._plan);

		// Publish a one-shot project-check runner so goal_complete can refuse while red.
		this._verificationProbe = () => this.runConfiguredCheck();
		setCurrentVerificationProbe(this._verificationProbe);

		// Chrome DevTools controller (endpoint from settings + env). Created
		// regardless of enabled (cheap; connects lazily); tools only join the
		// surface when chromeDevtools.enabled. Published for the tools to reach.
		const cdpCfg = this.settingsManager.getChromeDevtoolsSettings();
		this._chromeDevtools = new ChromeDevtoolsManager({
			host: cdpCfg.host,
			port: cdpCfg.debugPort,
			launchBrowser: cdpCfg.launchBrowser,
			userDataDir: cdpCfg.userDataDir,
			binaryPath: cdpCfg.binaryPath,
		});
		setCurrentChromeDevtoolsManager(this._chromeDevtools);

		// Publish a fresh tool discovery index so the `search_tool_bm25` tool
		// can BM25-search hidden tools. Auto-seeding of hidden entries is gated
		// by `toolDiscovery.enabled` in settings (default on): callers / SDK
		// extensions also populate the index via setCurrentToolDiscoveryIndex().
		this._toolDiscoveryIndex = createToolDiscoveryIndex();
		this._seedToolDiscovery();
		setCurrentToolDiscoveryIndex(this._toolDiscoveryIndex);
		// Augment the agent-core unknown-tool error: when the model calls a name that
		// isn't active but matches a HIDDEN discovery entry, point it there (and
		// activate an exact match so it's callable next turn). Reads the current index
		// so it always reflects the live session; cleared on dispose.
		setUnknownToolHintProvider((name) => buildHiddenToolHint(getCurrentToolDiscoveryIndex(), name));
		// Snapshot the hidden-tool count now that discovery is seeded and (when
		// there are hidden tools) rebuild the base prompt so the search_tool_bm25
		// nudge is part of the cacheable prefix from the very first request and
		// stays stable for the session. Without this the nudge's presence tracks
		// the live mutable index: it flips 0→N on the first post-boot rebuild
		// (re-charging the cached prefix), or — with frequent-files off — never
		// renders, so the model never learns it can discover hidden tools. The
		// baseline reset makes this a true re-baseline, not counted churn: it runs
		// pre-request during construction, before anything is sent to a provider.
		this._hiddenToolCountSnapshot = this._toolDiscoveryIndex.listHidden().length;
		if (this._hiddenToolCountSnapshot > 0) {
			this._cachePrefixBaseline = undefined;
			this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames(), "tool-discovery-seed");
			this.agent.state.systemPrompt = this._baseSystemPrompt;
		}

		// Spin up the eval kernel manager when enabled. Kernels themselves are
		// only spawned on first `get(lang)` so an unused setting costs nothing.
		if (this.settingsManager.getEvalSettings().enabled) {
			this._evalKernelManager = createEvalKernelManager(this._cwd);
			setCurrentEvalKernelManager(this._evalKernelManager);
		}

		// Publish the LSP manager when enabled. Language servers cold-start on the
		// first `lsp` call (or via manager.warmup()); the manager owns teardown so
		// servers don't outlive the session.
		const lspSettings = this.settingsManager.getLspSettings();
		if (lspSettings.enabled) {
			this._lspManager = createLspManager(this._cwd);
			setCurrentLspManager(this._lspManager);
		}
		// Gate post-write LSP diagnostics (writethrough) for this session: errors
		// from a write/edit are attached to the tool result, IDE-style.
		setDiagnosticsOnWrite(lspSettings.enabled && lspSettings.diagnosticsOnWrite);
		setEnforceDiagnosticsOnWrite(lspSettings.enabled && lspSettings.diagnosticsOnWrite);
		setFormatOnWrite(lspSettings.enabled && lspSettings.formatOnWrite);

		// Register this session on the inter-agent message bus as the addressable
		// parent ("Main") so subagents can message it mid-execution. Replies are
		// computed via an ephemeral side-channel against this session's own
		// history, so messaging Main works even while it's blocked in a `task` call.
		if (this.settingsManager.getAgentMessagingSettings().enabled) {
			this._messagingId = agentMessageBus.reserve("Main", {
				kind: "main",
				displayName: this.sessionName ?? "Main",
			});
			agentMessageBus.attachResponder(this._messagingId, makeAgentResponder(this.agent));
			agentMessageBus.attachDelivery(this._messagingId, makeAgentDelivery(this.agent));
			// Live relay: surface inter-agent sends in this session's transcript as
			// display-only lines (the model never sees them — convertToLlm drops the
			// relay customType). Lets the user watch coordination happen.
			this._unsubMessagingActivity = agentMessageBus.onActivity((activity) => {
				this._relayMessageActivity(activity);
			});
		}
	}

	/** Emit a display-only relay line for one inter-agent send (model-invisible). */
	private _relayMessageActivity(activity: MessageActivity): void {
		const icon = activity.mode === "notify" ? "📨" : "🗨";
		const outcome =
			activity.delivered.length > 0
				? ""
				: activity.notFound > 0
					? " (offline)"
					: activity.failed > 0
						? " (failed)"
						: "";
		const relay = {
			role: "custom" as const,
			customType: MESSAGE_RELAY_CUSTOM_TYPE,
			content: `${icon} \`${activity.from}\` → \`${activity.to}\`${outcome}: ${activity.message}`,
			display: true,
			timestamp: Date.now(),
		};
		try {
			this.emit({ type: "message_start", message: relay });
			this.emit({ type: "message_end", message: relay });
		} catch {
			// A relay render failure must never affect messaging or the run.
		}
	}

	/**
	 * The default active tool surface — the single source of truth shared by
	 * `_buildRuntime` (which seeds the active set) and `_seedToolDiscovery`
	 * (which derives what stays OFF the discovery index). Gate settings are read
	 * live, so a per-feature `enabled: false` drops that feature's tools here and
	 * everywhere downstream.
	 *
	 * `read/grep/find/ls/symbol/bash/edit/write/ask/todo` are the always-on core;
	 * `search_tool_bm25` rides the same gate as the discovery index it queries
	 * (so it never surfaces with nothing to find); the remaining spreads are the
	 * default-ON gated features (each opt-out via its `enabled: false` setting).
	 *
	 * Tools the user listed in `toolDiscovery.hiddenByDefault` are subtracted from
	 * the gated (non-core) part so they leave the active surface AND get seeded as
	 * hidden by `_seedToolDiscovery` (which derives its exclude-set from this list)
	 * instead of being active and indexed-as-hidden at the same time. The core ten
	 * are never hideable — listing one in `hiddenByDefault` is a no-op for them.
	 */
	private _defaultActiveToolNames(): string[] {
		const s = this.settingsManager;
		const on = (enabled: boolean, names: string[]): string[] => (enabled ? names : []);
		const core = [
			"read",
			"grep",
			"find",
			"ls",
			"symbol",
			"find_symbol",
			"bash",
			"edit",
			"write",
			"ask",
			"todo",
			"search_skills",
		];
		const gated = [
			...on(s.getToolDiscoverySettings().enabled, ["search_tool_bm25"]),
			...on(s.getHindsightSettings().enabled, ["retain", "recall", "reflect", "forget"]),
			...on(s.getWebSearchSettings().enabled, ["web_search"]),
			...on(s.getEvalSettings().enabled, ["eval"]),
			// Code-mode is native + default-on. It rides on the JS eval kernel (its
			// bidirectional tool channel lives there), so it's gated on eval being
			// enabled; PIT_NO_CODE_MODE=1 is the emergency opt-out. The harness-routed
			// dispatcher is injected in `_buildRuntime`.
			...on(s.getEvalSettings().enabled && !isTruthyEnvFlag(process.env.PIT_NO_CODE_MODE), ["code"]),
			...on(s.getLspSettings().enabled, ["lsp"]),
			...on(s.getDebugSettings().enabled, ["debug"]),
			...on(!isTruthyEnvFlag(process.env.PIT_NO_DEFER_HISTORY), ["recall_tool_output"]),
			...on(!isTruthyEnvFlag(process.env.PIT_NO_RECALL_HISTORY), ["recall_history"]),
			...on(s.getChromeDevtoolsSettings().enabled, chromeFeatureToolNames),
		];
		const hidden = new Set(s.getToolDiscoverySettings().hiddenByDefault);
		return [...core, ...gated.filter((name) => !hidden.has(name))];
	}

	/**
	 * Seed the hidden tool discovery index from settings. Registers two
	 * disjoint sets of built-ins as hidden:
	 *
	 * 1. Tools the user explicitly listed in `toolDiscovery.hiddenByDefault`.
	 * 2. Tools that exist in `createAllToolDefinitions` but NOT in the
	 *    `createCodingTools` set — the runtime knows about them but
	 *    they are off the active surface. The `alwaysActive` setting can
	 *    override this so callers can keep a tool on the active surface.
	 *
	 * No-op when toolDiscovery is disabled or the index has not been created.
	 */
	private _seedToolDiscovery(): void {
		const index = this._toolDiscoveryIndex;
		if (!index) return;
		const cfg = this.settingsManager.getToolDiscoverySettings();
		if (!cfg.enabled) return;
		// Reuse the full definition set _buildRuntime already built into
		// _baseToolDefinitions (same cwd, same options) — it runs earlier in the
		// constructor. Only rebuild for the override case, where
		// _baseToolDefinitions holds the override set, not the full registry, and
		// discovery must still see every tool.
		let allDefs: Record<string, ToolDefinition>;
		if (this._baseToolsOverride) {
			const autoResizeImages = this.settingsManager.getImageAutoResize();
			const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
			const shellPath = this.settingsManager.getShellPath();
			try {
				allDefs = createAllToolDefinitions(this._cwd, {
					read: {
						autoResizeImages,
						embedHashlineAnchors: () =>
							!this._disableHashlineAnchors && this.getActiveToolNames().includes("edit_v2"),
						readDedupeStore: this._readDedupeStore,
						mtimeStore: this._fileMtimeStore,
					},
					edit: { mtimeStore: this._fileMtimeStore },
					edit_v2: { mtimeStore: this._fileMtimeStore },
					write: { mtimeStore: this._fileMtimeStore },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
					grep: { engine: this.settingsManager.getGrepSettings().engine },
					find: {
						engine: this.settingsManager.getGrepSettings().engine === "fff" ? "fff" : "fd",
					},
					ast_grep: { engine: this.settingsManager.getAstGrepSettings().engine },
				}) as Record<string, ToolDefinition>;
			} catch {
				return;
			}
		} else {
			allDefs = Object.fromEntries(this._baseToolDefinitions) as Record<string, ToolDefinition>;
		}
		// 1. Explicit hiddenByDefault entries.
		const explicit = new Set(cfg.hiddenByDefault);
		// 2. Delta = allTools − default-active surface, minus alwaysActive. The
		// active surface (single source) already covers the gated features that
		// are ON. We additionally hide, unconditionally: the chrome feature (its
		// gate also governs the auto-launched manager, so a discovered-while-off
		// chrome tool would only fail) and the meta/infra tools the model must
		// never pull in via discovery.
		//
		// `edit_v2` is deliberately NOT excluded here (unlike `resolve`,
		// `goal_complete`): the edit/write/ast_edit tool descriptions actively tell
		// the model "prefer edit_v2 for large files", but it is off the default
		// active surface, so leaving it out of the discovery seed made it
		// unreachable — not even the exact-name recovery hint in
		// `buildHiddenToolHint` could find it. `resolve` doesn't need the same fix:
		// it activates dynamically the moment a preview is staged (see
		// `_reconcilePreviewActivation`), so it never needs discovery to become
		// reachable.
		const codingNames = new Set([
			...this._defaultActiveToolNames(),
			...chromeFeatureToolNames,
			"resolve",
			"goal_complete",
			"recall_tool_output",
		]);
		const alwaysActive = new Set(cfg.alwaysActive);
		// Explicit entries are gated by the same active-surface guard so a tool that
		// is STILL active (a core tool, or a default-ON feature not subtracted by
		// _defaultActiveToolNames) can never be seeded as hidden — that would make it
		// active AND indexed-as-hidden at once. _defaultActiveToolNames already drops
		// the non-core hiddenByDefault entries, so a genuinely-hidden one is absent
		// from codingNames and survives this filter.
		const candidates = new Set<string>();
		for (const name of explicit) {
			if (codingNames.has(name)) continue;
			if (alwaysActive.has(name)) continue;
			candidates.add(name);
		}
		for (const name of Object.keys(allDefs)) {
			if (codingNames.has(name)) continue;
			if (alwaysActive.has(name)) continue;
			candidates.add(name);
		}
		for (const name of candidates) {
			const def = allDefs[name];
			if (!def) continue;
			const description = typeof def.description === "string" ? def.description : "";
			// BM25 ranks over name + description + promptSnippet + tags. Feed the
			// one-line snippet and the usage guidelines too: they carry capability
			// keywords the bare description often omits (e.g. calc's "math" and its
			// function names live in the guidelines), which lifts discovery recall
			// without bloating the model-facing description.
			index.register({
				name,
				description,
				promptSnippet: this._normalizePromptSnippet(def.promptSnippet),
				tags: this._normalizePromptGuidelines(def.promptGuidelines),
				definition: def,
			});
		}
	}

	/**
	 * Open the project's hindsight bank (if enabled) and publish it via the
	 * module-level registry so retain/recall/reflect/forget tool calls pick it up.
	 * No-op when `hindsight.enabled` is false.
	 */
	private _openHindsightBank(): void {
		const cfg = this.settingsManager.getHindsightSettings();
		if (!cfg.enabled) return;
		try {
			const path = cfg.bankPath ?? defaultBankPath(this._cwd);
			ensureBankDir(path);
			const bank = openBank(path, {
				maxEntries: cfg.maxEntries,
				pruneOlderThanDays: cfg.pruneOlderThanDays,
				perScopeMax: cfg.scopedSubagents ? cfg.scopedSubagentsMaxEntriesPerScope : undefined,
			});
			this._hindsightBank = bank;
			setCurrentHindsightBank(bank);
		} catch {
			// Silent: missing or unreadable banks should not crash the session.
		}
	}

	/**
	 * Open a session-scoped deferred-output store (default ON; opt out with
	 * PIT_NO_DEFER_HISTORY=1). Publishes it via the module-level registry so the
	 * live-context prune (pruneOldToolOutputs with defer=true) and the
	 * recall_tool_output tool can access it: large stale outputs collapse to a
	 * head+tail excerpt inline while the full text stays recoverable on disk.
	 */
	private _openDeferredOutputStore(): void {
		if (isTruthyEnvFlag(process.env.PIT_NO_DEFER_HISTORY)) return;
		try {
			const store = createDeferredOutputStore();
			this._deferredOutputStore = store;
			setCurrentDeferredOutputStore(store);
		} catch {
			// Silent: a failure here should not crash the session.
		}
	}

	/**
	 * Publish the live session branch as the `recall_history` source so the tool
	 * can BM25-search the compacted-away window. Default ON; opt out with
	 * `PIT_NO_RECALL_HISTORY=1` (also keeps the tool off the active surface and
	 * suppresses the summary footer). Reads the in-memory branch — no JSONL
	 * re-read — and is cleared on dispose (mirrors the deferred-output registry).
	 */
	private _publishHistoryRecallSource(): void {
		if (isTruthyEnvFlag(process.env.PIT_NO_RECALL_HISTORY)) return;
		setCurrentHistoryRecallSource(() => this.sessionManager.getBranch());
	}

	/**
	 * Kick off the repo-level frequent-files compute in the background. Resolves
	 * silently when the index is ready (or on failure). Subsequent system-prompt
	 * rebuilds pick up the cached value via `_frequentFilesIndex`. Re-runs are
	 * idempotent — an in-flight compute is aborted and replaced. No-op when the
	 * `frequentFiles` setting is disabled.
	 */
	private _kickoffFrequentFilesIndex(): void {
		const cfg = this.settingsManager.getFrequentFilesSettings();
		if (!cfg.enabled) return;
		// Abort any previous in-flight compute so a rapid `_recomputeFrequentFiles`
		// hook doesn't leak subprocesses.
		this._frequentFilesAbort?.abort();
		const controller = new AbortController();
		this._frequentFilesAbort = controller;
		const promise = computeFrequentFiles({ cwd: this._cwd, limit: cfg.topN, signal: controller.signal })
			.then(async (files) => {
				if (controller.signal.aborted) return;
				this._frequentFilesIndex = files;
				// Boot-outline (gated PIT_FREQ_OUTLINE, off by default): heuristic symbol
				// outline of the hottest files, rendered in the uncached suffix like
				// frequentFiles. Best-effort; unreadable files are skipped.
				if (isTruthyEnvFlag(process.env.PIT_FREQ_OUTLINE)) {
					const outlines: Array<{ path: string; symbols: string[] }> = [];
					for (const f of files.slice(0, 8)) {
						if (controller.signal.aborted) break;
						try {
							const content = readFileSync(isAbsolute(f.path) ? f.path : resolve(this._cwd, f.path), "utf-8");
							outlines.push({
								path: f.path,
								symbols: listDeclarations(content, f.path)
									.map((d) => d.name)
									.slice(0, 12),
							});
						} catch {
							// Unreadable hot file is skipped; outline is best-effort.
						}
					}
					this._hotFileOutlines = outlines;
				}
				// Rebuild so the next turn sees the index. The index now renders in
				// the dynamic suffix (after the cache marker), so this rebuild does
				// NOT rewrite the cacheable prefix — the prompt cache survives intact.
				try {
					this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames(), "frequent-files-index");
				} catch {
					// A rebuild failure must not break the session — surface on next turn.
				}
			})
			.catch(() => {
				// Compute failures are non-fatal; the prompt simply omits the block.
			})
			.finally(() => {
				// Clear the slot once settled so dispose's await is a no-op when the
				// compute has already finished naturally.
				if (this._frequentFilesPromise === promise) {
					this._frequentFilesPromise = undefined;
				}
			});
		this._frequentFilesPromise = promise;
	}

	/**
	 * Band P: refresh the cached enriched living repo-map in the background, then
	 * rebuild the system prompt so the next turn's context-composer block reflects
	 * the current tree. Incremental + best-effort (any failure leaves the prior
	 * map). No-op when the composer is disabled.
	 */
	private async _refreshLivingRepoMap(): Promise<void> {
		try {
			// Always warm the incremental repo-map cache (this is also the boot prewarm
			// the composer inherited); capturing the map is harmless when disabled.
			const result = await getLivingRepoMap(this._cwd);
			this._livingRepoMap = result.map;
			// Only the composer needs a rebuild; skip it when the composer is off.
			if (isContextComposerDisabled()) return;
			try {
				this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames(), "context-composer-index");
			} catch {
				// Rebuild failure is non-fatal; the block simply lags a turn.
			}
		} catch {
			// Map compute failure is non-fatal; composer degrades to no block.
		}
	}

	/**
	 * Band P: render the context-composer dynamic-suffix block for the current
	 * turn (predicted-file outline + optional style exemplar), dosed by the
	 * supervision thermostat level. Pure/synchronous over the cached map; returns
	 * "" when disabled, no map, or no prediction (fail-open, zero cost).
	 */
	private _composeGroundedContext(): string {
		if (isContextComposerDisabled()) return "";
		const map = this._livingRepoMap;
		if (!map || map.entries.length === 0) return "";
		const level = getCurrentSupervisionThermostat()?.getLevel() ?? "padrao";
		const ffCfg = this.settingsManager.getFrequentFilesSettings();
		const frequentFiles = ffCfg.enabled
			? this._frequentFiles.getTop({ topN: ffCfg.topN, minHits: ffCfg.minHits }).map((s) => s.path)
			: [];
		try {
			const result = composeContext({
				prompt: this._composerPromptText,
				entries: map.entries,
				level,
				frequentFiles,
				recentReadPath: this._composerLastReadPath,
				recentReadContent: this._composerLastReadContent,
				readFile: (rel) => this._readComposerFile(rel),
			});
			return result.block;
		} catch {
			return "";
		}
	}

	/** Best-effort, size-capped file read for the style exemplar body. */
	private _readComposerFile(relPath: string): string | null {
		try {
			const abs = isAbsolute(relPath) ? relPath : resolve(this._cwd, relPath);
			const content = readFileSync(abs, "utf-8");
			return content.length > 256 * 1024 ? content.slice(0, 256 * 1024) : content;
		} catch {
			return null;
		}
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		apiKey: string;
		headers?: Record<string, string>;
	}> {
		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!result.ok) {
			if (result.error.startsWith("No API key found")) {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw new Error(result.error);
		}
		if (result.apiKey) {
			return { apiKey: result.apiKey, headers: result.headers };
		}

		const isOAuth = this._modelRegistry.isUsingOAuth(model);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	async getCompactionRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
	}> {
		if (this.agent.streamFn === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		return result.ok ? { apiKey: result.apiKey, headers: result.headers } : {};
	}

	getRequiredRequestAuth(model: Model<any>): Promise<{ apiKey: string; headers?: Record<string, string> }> {
		return this._getRequiredRequestAuth(model);
	}

	get cwd(): string {
		return this._cwd;
	}

	get hindsightBank(): HindsightBank | undefined {
		return this._hindsightBank;
	}

	get readDedupeStore(): ReadDedupeStore | undefined {
		return this._readDedupeStore;
	}

	get fileMtimeStore(): FileMtimeStore | undefined {
		return this._fileMtimeStore;
	}

	get fusionAbort(): AbortController | undefined {
		return this._fusionAbort;
	}

	setFusionAbort(value: AbortController | undefined): void {
		this._fusionAbort = value;
	}

	get userInterrupted(): boolean {
		return this._userInterrupted;
	}

	emit(event: AgentSessionEvent): void {
		this._eventBus.emit(event);
	}

	setLastAssistantMessage(message: AssistantMessage): void {
		this._lastAssistantMessage = message;
	}

	disconnectFromAgent(): void {
		this._disconnectFromAgent();
	}

	reconnectToAgent(): void {
		this._reconnectToAgent();
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private static readonly _resolvedUndefined = Promise.resolve(undefined);

	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = ({ toolCall, args }, signal) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return AgentSession._resolvedUndefined;
			}

			// Race against the run signal so a tool_call handler parked on slow IO
			// can't wedge the turn — Esc/abort always unblocks the loop (settleOrAbort).
			return settleOrAbort(
				runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				}),
				signal,
			).catch((err) => {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			});
		};

		this.agent.afterToolCall = ({ toolCall, args, result, isError }, signal) => {
			const runner = this._extensionRunner;
			const extensionPromise = runner.hasHandlers("tool_result")
				? settleOrAbort(
						runner.emitToolResult({
							type: "tool_result",
							toolName: toolCall.name,
							toolCallId: toolCall.id,
							input: args as Record<string, unknown>,
							content: result.content,
							details: result.details,
							isError,
						}),
						signal,
					).then((hookResult) => {
						if (!hookResult) return undefined;
						return {
							content: hookResult.content,
							details: hookResult.details,
							isError: hookResult.isError ?? isError,
						};
					})
				: AgentSession._resolvedUndefined;

			return extensionPromise.then((hookResult) => {
				const effectiveError = hookResult?.isError ?? isError;
				this._applyLiveContextEconomyAfterTool(toolCall, effectiveError);
				return hookResult;
			});
		};
	}

	private _installContextPruneHook(): void {
		const existingTransform = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			// P02: skip re-running extension emitContext + prune when the transcript
			// identity is unchanged between tool rounds of the same turn.
			const key = this._ctxPruneCacheKey(messages);
			const cached = this._ctxPruneCache;
			if (cached && cached.key === key) {
				return cached.value;
			}
			const transformed = existingTransform ? await existingTransform(messages, signal) : messages;
			const pruned = this._pruneContextForProvider(transformed);
			this._ctxPruneCache = { key, value: pruned };
			return pruned;
		};
	}

	/** Identity key for transformContext/prune memoization (P02). */
	private _ctxPruneCacheKey(messages: AgentMessage[]): string {
		const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
		const lastStamp =
			last && typeof last === "object" && "timestamp" in last && typeof last.timestamp === "number"
				? last.timestamp
				: 0;
		const lastRole = last && typeof last === "object" && "role" in last ? String(last.role) : "";
		const contextWindow = this.model?.contextWindow ?? 0;
		// Env kill-switches affect prune decisions; include so toggling mid-session
		// (tests) does not serve a stale pruned array.
		const flags = [
			isTruthyEnvFlag(process.env.PIT_NO_THINKING_CAP) ? "1" : "0",
			isTruthyEnvFlag(process.env.PIT_NO_PROACTIVE_PRUNE) ? "1" : "0",
			process.env.PIT_PROACTIVE_PRUNE_FLOOR ?? "",
		].join(",");
		return `${messages.length}:${lastRole}:${lastStamp}:${contextWindow}:${this.thinkingLevel}:${flags}`;
	}

	private _invalidateCtxCaches(): void {
		this._ctxUsageCache = undefined;
		this._ctxPruneCache = undefined;
	}

	/**
	 * Turn-boundary light economy (supersede + mutating-arg elision) plus
	 * prune-only mid-turn wire pressure relief (B9). Proactive thinking-cap
	 * stays in transformContext; LLM compaction/abort are intentionally not
	 * hooked here (product policy since v0.17.0).
	 */
	private _installPrepareNextTurnHook(): void {
		this.agent.prepareNextTurn = (turnContext) => {
			// Defensive: a throw here runs inside the agent loop after a successful
			// assistant turn and becomes a synthetic error message ("Cannot read
			// properties of undefined (reading 'messages')"). Never fail the turn
			// for light economy bookkeeping.
			try {
				const messages = turnContext?.context?.messages;
				const toolResults = turnContext?.toolResults ?? [];
				if (!messages) return undefined;

				const contextWindow = this.model?.contextWindow ?? 0;
				let nextMessages = messages;
				let reclaimed = 0;

				const light = applyLightContextEconomyAtTurnEnd(nextMessages, toolResults, contextWindow);
				if (light.reclaimed > 0) {
					nextMessages = light.messages;
					reclaimed += light.reclaimed;
				}

				// Mid-turn wire pressure (between tool rounds): prune-only when
				// assembled+thinking exceeds ~92% of the window. No LLM compaction.
				const pressure = measureMidTurnWirePressure(nextMessages, this.model, {
					systemPrompt: this.agent.state.systemPrompt ?? this._baseSystemPrompt,
					tools: this._wireToolsForEstimate(),
					thinkingLevel: this.thinkingLevel,
					thinkingBudgets: this.settingsManager.getThinkingBudgets(),
				});
				if (pressure.tripped) {
					const relief = applyMidTurnPressureRelief(nextMessages, contextWindow);
					if (relief.reclaimed > 0) {
						nextMessages = relief.messages;
						reclaimed += relief.reclaimed;
					}
				}

				if (reclaimed <= 0) return undefined;
				this.agent.state.messages = nextMessages;
				this._invalidateCtxCaches();
				return {
					context: {
						...turnContext.context,
						messages: nextMessages,
					},
				};
			} catch (err) {
				recordDiagnostic({
					category: "error.isolated",
					level: "warn",
					source: "agent-session.prepareNextTurn",
					context: { note: err instanceof Error ? err.message : String(err) },
				});
				return undefined;
			}
		};
	}

	/**
	 * Memoized per tools-array reference (the agent state setter always swaps the
	 * reference; there are no in-place pushes) so the presend estimate reuses one
	 * surfaces array — which in turn lets estimateToolSurfaceTokens cache the
	 * schema stringify cost instead of paying it every turn. Both env-flag
	 * variants are kept so tests toggling PIT_NO_LAZY_TOOL_SCHEMAS stay correct.
	 */
	private _wireToolSurfaceCache = new WeakMap<object, { full?: WireToolSurface[]; compact?: WireToolSurface[] }>();

	private _wireToolsForEstimate(): WireToolSurface[] {
		const tools = this.agent.state.tools;
		let entry = this._wireToolSurfaceCache.get(tools);
		if (!entry) {
			entry = {};
			this._wireToolSurfaceCache.set(tools, entry);
		}
		if (isTruthyEnvFlag(process.env.PIT_NO_LAZY_TOOL_SCHEMAS)) {
			entry.full ??= tools.map(agentToolToWireSurface);
			return entry.full;
		}
		entry.compact ??= tools.map(agentToolToWireSurface).map(compactWireToolSurface);
		return entry.compact;
	}

	private _installWireToolEconomyHook(): void {
		const baseStreamFn = this.agent.streamFn;
		this.agent.streamFn = (model, context, options) => {
			if (isTruthyEnvFlag(process.env.PIT_NO_LAZY_TOOL_SCHEMAS) || !context.tools?.length) {
				return baseStreamFn(model, context, options);
			}
			return baseStreamFn(model, compactToolsForProviderContext(context), options);
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	private _emitQueueUpdate(): void {
		this.emit({
			type: "queue_update",
			steering: this._steeringMessages,
			followUp: this._followUpMessages,
		});
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this.compaction.overflowRecoveryAttempted = false;
			const messageText = this._getUserMessageText(event.message);
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		const payload = event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event;
		if (event.type === "message_update" || event.type === "tool_execution_update") {
			// Extensions and TUI listeners are independent — don't serialize streaming on hook latency.
			await Promise.all([this._emitExtensionEvent(event), Promise.resolve().then(() => this.emit(payload))]);
		} else {
			await this._emitExtensionEvent(event);
			this.emit(payload);
		}

		// Handle session persistence
		if (event.type === "message_end") {
			// Persisting to disk can fail (disk full, EBUSY/EPERM from AV on Windows).
			// This handler runs from the agent's failure path too, where a throw escapes
			// runWithLifecycle's catch → unhandledRejection → host death, and on any path
			// a throw here desyncs the lifecycle. Best-effort: record and continue.
			try {
				// Check if this is a custom message from extensions
				if (event.message.role === "custom") {
					// Persist as CustomMessageEntry
					this.sessionManager.appendCustomMessageEntry(
						event.message.customType,
						event.message.content,
						event.message.display,
						event.message.details,
					);
				} else if (
					event.message.role === "user" ||
					event.message.role === "assistant" ||
					event.message.role === "toolResult"
				) {
					const skipPersist = event.message.role === "assistant" && isStreamGuardAbortMessage(event.message);
					if (!skipPersist) {
						this.sessionManager.appendMessage(event.message);
					}
				}
				// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere
			} catch (err) {
				recordDiagnostic({
					category: "error.isolated",
					level: "warn",
					source: "agent-session.message_end",
					context: { note: err instanceof Error ? err.message : String(err) },
				});
			}

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error") {
					this.compaction.overflowRecoveryAttempted = false;
					// Reset the retry counter immediately on a successful response so it
					// doesn't accumulate across multiple LLM calls within a turn.
					if (this._retryAttempt > 0) {
						this.emit({
							type: "auto_retry_end",
							success: true,
							attempt: this._retryAttempt,
						});
						this._retryAttempt = 0;
					}
					// Reset the adaptive idle-timeout backoff: a clean response means the
					// stream is healthy, so drop back to the configured idle window.
					this._idleTimeoutRetryCount = 0;
					this.agent.idleTimeoutMs = undefined;
					// Reset the fallback chain so the next failure restarts from the
					// primary. The captured primary model (_fallbackOriginal) is NOT
					// cleared here — it is restored at the turn boundary in
					// _handlePostAgentRun so a multi-call turn stays on the working
					// fallback instead of ping-ponging back to a still-failing primary.
					this._triedFallbackEntries.clear();
				}
			}
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** Extract text content from a message */
	private _getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const content = message.content;
		if (typeof content === "string") return content;
		const textBlocks = content.filter((c) => c.type === "text");
		return textBlocks.map((c) => (c as TextContent).text).join("");
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	/**
	 * Best-effort, conservative check: did the LAST assistant message use completion
	 * language? Used ONLY to optionally strengthen the terminal verification message
	 * — never to gate or alter flow. Keyword matching is locale-limited and fragile
	 * by design: a miss just omits one sentence, a false hit only appends one.
	 */
	private _lastAssistantClaimedCompletion(): boolean {
		const message = this._findLastAssistantMessage();
		if (!message) return false;
		const content = message.content;
		let text = "";
		if (typeof content === "string") {
			text = content;
		} else {
			text = content
				.filter((c) => c.type === "text")
				.map((c) => (c as TextContent).text)
				.join(" ");
		}
		const lower = text.toLowerCase();
		return COMPLETION_PHRASES.some((phrase) => lower.includes(phrase));
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		switch (event.type) {
			case "agent_start":
				this._turnIndex = 0;
				if (this._extensionRunner.hasHandlers("agent_start")) {
					await this._extensionRunner.emit({ type: "agent_start" });
				}
				break;
			case "agent_end":
				this._toolCallArgsByCallId.clear();
				this._rejectedToolCallIds.clear();
				// Symmetric with the sibling maps: a turn aborted between hint-applied
				// and execution-end leaves an orphan entry that nothing collects.
				// Read happens earlier in _handleToolExecutionEnd, so the happy path
				// has already drained the relevant key before agent_end fires.
				this._hintsByToolCallId.clear();
				if (this._extensionRunner.hasHandlers("agent_end")) {
					await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
				}
				break;
			case "turn_start":
				if (this._extensionRunner.hasHandlers("turn_start")) {
					await this._extensionRunner.emit({
						type: "turn_start",
						turnIndex: this._turnIndex,
						timestamp: Date.now(),
					} satisfies TurnStartEvent);
				}
				break;
			case "turn_end":
				if (this._extensionRunner.hasHandlers("turn_end")) {
					await this._extensionRunner.emit({
						type: "turn_end",
						turnIndex: this._turnIndex,
						message: event.message,
						toolResults: event.toolResults,
					} satisfies TurnEndEvent);
				}
				this._recordGoalTurn(event.message);
				this._steering.maybeInjectStagnation(event.message, event.toolResults);
				this._steering.maybeInjectTodoCadence(event.message, event.toolResults);
				if (this._todo.takeDirty()) this._persistTodo();
				if (this._plan.takeDirty()) this._persistPlan();
				// Incremental persistence: flush newly-learned error fingerprints so a
				// session killed before dispose still warms the cross-session store. No-op
				// when nothing was learned this turn (dirty flag) or the session is
				// ephemeral/empty (guards inside _persistLearnedErrors). Best-effort.
				this._flushLearnedErrorsIfDirty();
				this._turnIndex++;
				break;
			case "message_start":
				if (this._extensionRunner.hasHandlers("message_start")) {
					await this._extensionRunner.emit({
						type: "message_start",
						message: event.message,
					} satisfies MessageStartEvent);
				}
				break;
			case "message_update":
				if (this._extensionRunner.hasHandlers("message_update")) {
					await this._extensionRunner.emit({
						type: "message_update",
						message: event.message,
						assistantMessageEvent: event.assistantMessageEvent,
					} satisfies MessageUpdateEvent);
				}
				break;
			case "message_end": {
				const replacement = await this._extensionRunner.emitMessageEnd({
					type: "message_end",
					message: event.message,
				});
				if (replacement) {
					this._replaceMessageInPlace(event.message, replacement);
				}
				break;
			}
			case "tool_execution_start":
				this._handleToolExecutionStart(event);
				if (this._extensionRunner.hasHandlers("tool_execution_start")) {
					await this._extensionRunner.emit({
						type: "tool_execution_start",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
					} satisfies ToolExecutionStartEvent);
				}
				break;
			case "tool_execution_update":
				if (this._extensionRunner.hasHandlers("tool_execution_update")) {
					await this._extensionRunner.emit({
						type: "tool_execution_update",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
						partialResult: event.partialResult,
					} satisfies ToolExecutionUpdateEvent);
				}
				break;
			case "tool_execution_end":
				this._handleToolExecutionEnd(event);
				if (this._extensionRunner.hasHandlers("tool_execution_end")) {
					await this._extensionRunner.emit({
						type: "tool_execution_end",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						result: event.result,
						isError: event.isError,
					} satisfies ToolExecutionEndEvent);
				}
				break;
			case "tool_call_rewritten":
				this._handleToolCallRewritten(event);
				break;
			case "tool_call_rejected":
				this._handleToolCallRejected(event);
				break;
			case "tool_error_hint_applied":
				this._handleToolErrorHintApplied(event);
				break;
		}
	}

	private _handleToolExecutionStart(event: Extract<AgentEvent, { type: "tool_execution_start" }>): void {
		// Record (name, args) now; the result hash is backfilled at execution end.
		// The doom-loop check itself runs at end (see _handleToolExecutionEnd) so it
		// can compare RESULTS — a call with identical args but a new result each step
		// (debugger stepping) is real progress, not a loop, and must not trip it.
		this._toolCallStats.recordInvocation(event.toolName, fingerprintToolArgsExact(event.args), event.toolCallId);
		this._toolCallArgsByCallId.set(event.toolCallId, event.args);
	}

	private _handleToolExecutionEnd(event: Extract<AgentEvent, { type: "tool_execution_end" }>): void {
		const errorMessage = event.isError ? extractErrorMessage(event.result?.content) : undefined;
		this._toolCallStats.record(event.toolName, event.isError, errorMessage);
		// The agent looked at rendered output this turn — satisfies the visual DoD.
		if (event.toolName === "preview" && !event.isError) this._turnUsedPreview = true;
		// Todo-first safety net: count successful non-todo/plan work actions this prompt;
		// at the 2nd one without a todo, the triage protocol was skipped — nudge once. ADR-0007.
		if (!event.isError && event.toolName !== "todo" && event.toolName !== "plan") {
			this._steering.recordWorkAction();
		}
		const args = this._toolCallArgsByCallId.get(event.toolCallId);
		this._toolCallArgsByCallId.delete(event.toolCallId);
		// Backfill the result hash onto the invocation recorded at start, then run
		// the doom-loop check now that the RESULT is known. Deferring the check to
		// end (vs start) is what makes it result-aware: a call repeated with the same
		// args but a NEW result each time (debugger stepping) is progress, not a loop.
		// Tier 3 throws here to abort the turn — same propagation as the old start-time
		// throw, just gated on "same call AND same result".
		this._toolCallStats.recordInvocationResult(
			fingerprintToolResult(event.result, event.isError),
			event.isError,
			event.toolCallId,
		);
		// Band P Fase 0: reconcile any pending guard-fire for this tool with the
		// call's outcome (fail-open; no-op when telemetry is off or nothing pending).
		this._guardEfficacy?.onToolExecutionEnd(event.toolName, event.toolCallId, event.isError);
		this._steering.maybeInjectDoomLoop(event.toolName, args, errorMessage);
		// Complementary to the doom-loop above (same call repeated): detect a
		// repeating MULTI-tool cycle [A,B,C]x3 of DIFFERENT tools. Runs after — if
		// the doom-loop Tier-3 aborted, this is skipped (identical-loop abort wins).
		this._steering.maybeInjectRepeatingPattern();
		// Capture the learned-error fingerprint so the next session boots warm
		// with knowledge of recurring patterns. Looked up via the matching
		// hint event recorded earlier in finalize.
		const matchedHintRules = this._hintsByToolCallId.get(event.toolCallId);
		this._hintsByToolCallId.delete(event.toolCallId);
		// Pre-flight registry rejections (Tier 2/3) are excluded from the learned-
		// error store: their text is our own deliberate refusal message, not a model
		// failure pattern. Learning them would materialise dynamic Tier 4 rules that
		// hint about our own refusal strings. The per-rule reject counters already
		// track them.
		const wasRegistryRejected = this._rejectedToolCallIds.delete(event.toolCallId);
		// Per-turn, per-tool failure budget (complements doom-loop + cross-error):
		// bump the by-NAME failure count for this turn and surface the remaining
		// budget to the reflection prompt. Computed once for both error branches.
		const budget = event.isError ? this._steering.recordTurnToolFailure(event.toolName) : undefined;
		if (event.isError && wasRegistryRejected) {
			this._steering.maybeInjectToolErrorReflection(event.toolName, args, event.result, budget?.attemptsLeft);
			if (budget) this._steering.maybeInjectFailureBudget(event.toolName, budget.count, budget.max);
		} else if (event.isError) {
			const rawError = errorMessage ?? "";
			const learned = upsertLearnedErrorOnFailure({
				toolName: event.toolName,
				args,
				rawError,
				matchedHintRules,
				state: {
					learnedErrors: this._learnedErrors,
					sameSessionHintKeys: this._sameSessionHintKeys,
					toolErrorHintRegistry: this.agent.toolErrorHintRegistry,
				},
			});
			if (learned.dirty) this._learnedErrorsDirty = true;
			this._steering.maybeInjectCrossError(learned.fingerprint, args, rawError);
			this._steering.maybeInjectToolErrorReflection(event.toolName, args, event.result, budget?.attemptsLeft);
			if (budget) this._steering.maybeInjectFailureBudget(event.toolName, budget.count, budget.max);
		} else {
			this._steering.observeToolSuccess(event.toolName);
			const fileOp = extractToolFileOp(event.toolName, args);
			if (fileOp) {
				this._frequentFiles.record(fileOp.path, fileOp.op);
				// Band P: the most-recently-read file is the edit-target signal for the
				// context composer (import layer + style exemplar). Best-effort content
				// capture for cheap import extraction; content failure just drops that layer.
				if (fileOp.op === "read" && !isContextComposerDisabled()) {
					this._composerLastReadPath = fileOp.path;
					this._composerLastReadContent = this._readComposerFile(fileOp.path) ?? undefined;
				}
			}
			armVerificationGate(this._verificationGate, event.toolName, args, {
				result: event.result as { details?: { firstChangedLine?: number } },
			});
			// Band P / P4: fold this mutation into the per-cycle risk aggregate. No-op
			// for non-mutating results (measurePatch returns undefined).
			this._turnRisk.add({
				toolName: event.toolName,
				input: (args ?? {}) as Record<string, unknown>,
				details: event.result?.details,
				isError: false,
			});
		}
		// A tool may have pulled a hidden tool into the active surface this turn
		// (search_tool_bm25 with activate_top). Reconcile so it is callable next
		// turn. Cheap no-op when nothing was activated.
		this._reconcileDiscoveryActivations();
		// A tool may have staged (edit/write/edit_v2/ast_edit with preview:true) or
		// drained (resolve itself) the preview queue this turn. Mirror the
		// goal_complete dynamic-activation pattern: `resolve` is off the default
		// TUI surface, but must be reachable the instant there is something to
		// commit — and dropped again once the queue is empty, so it doesn't
		// linger as dead surface for the rest of the session.
		this._reconcilePreviewActivation();
	}

	/**
	 * Keep `resolve`'s presence on the active surface in sync with whether the
	 * preview queue has staged items. Cheap no-op when the queue is absent or its
	 * staged/active state already matches (the common case on every turn).
	 */
	private _reconcilePreviewActivation(): void {
		const queue = this._previewQueue;
		if (!queue) return;
		const hasStaged = queue.count() > 0;
		const isActive = this.getActiveToolNames().includes("resolve");
		if (hasStaged === isActive) return;
		const names = new Set(this.getActiveToolNames());
		if (hasStaged) {
			names.add("resolve");
		} else {
			names.delete("resolve");
		}
		this.setActiveToolsByName([...names]);
	}

	/**
	 * Bring any tools activated in the discovery index onto the active surface.
	 * Two cases: a hidden built-in already lives in the registry (just mark it
	 * active), or a deferred tool (e.g. an MCP tool registered into the index but
	 * not the registry) must first be registered as a custom tool. Idempotent and
	 * a no-op when the index has no activations, so it is safe to call after every
	 * tool execution regardless of whether deferral is enabled.
	 */
	private _reconcileDiscoveryActivations(): void {
		const index = this._toolDiscoveryIndex;
		if (!index) return;
		const activated = index.activatedNames();
		if (activated.length === 0) return;

		const activeNow = new Set(this.getActiveToolNames());
		const toActivate: string[] = [];
		let registeredNew = false;
		for (const name of activated) {
			if (activeNow.has(name)) continue;
			if (this._toolRegistry.has(name)) {
				toActivate.push(name);
			} else if (!this._customTools.some((t) => t.name === name)) {
				const def = index.activate(name);
				if (def) {
					this._customTools.push(def as ToolDefinition);
					registeredNew = true;
				}
			}
		}
		if (!registeredNew && toActivate.length === 0) return;
		// Refresh registers any new custom tools (and auto-activates them); then
		// fold in the already-registered hidden tools we want live.
		if (registeredNew) {
			this._refreshToolRegistry();
		}
		if (toActivate.length > 0) {
			this.setActiveToolsByName([...new Set([...this.getActiveToolNames(), ...toActivate])]);
		}
	}

	private _handleToolCallRewritten(event: Extract<AgentEvent, { type: "tool_call_rewritten" }>): void {
		const perTool = this._registryRewrites.get(event.toolName) ?? new Map<string, number>();
		for (const ruleId of event.ruleIds) {
			perTool.set(ruleId, (perTool.get(ruleId) ?? 0) + 1);
		}
		this._registryRewrites.set(event.toolName, perTool);
	}

	private _handleToolCallRejected(event: Extract<AgentEvent, { type: "tool_call_rejected" }>): void {
		const perTool = this._registryRejects.get(event.toolName) ?? new Map<string, number>();
		perTool.set(event.ruleId, (perTool.get(event.ruleId) ?? 0) + 1);
		this._registryRejects.set(event.toolName, perTool);
		this._rejectedToolCallIds.add(event.toolCallId);
	}

	private _handleToolErrorHintApplied(event: Extract<AgentEvent, { type: "tool_error_hint_applied" }>): void {
		const existing = this._hintsByToolCallId.get(event.toolCallId) ?? [];
		for (const h of event.hints) {
			// Count each (toolCallId, ruleId) once, mirroring the transient dedupe,
			// so the persistent counter tracks distinct hint applications.
			if (!existing.includes(h.ruleId)) {
				existing.push(h.ruleId);
				this._registryHints.set(h.ruleId, (this._registryHints.get(h.ruleId) ?? 0) + 1);
			}
		}
		this._hintsByToolCallId.set(event.toolCallId, existing);
	}

	/**
	 * Snapshot of every tool-rewrite registry rule that fired this session,
	 * grouped by tool name and tier. Used by the optional stats export to
	 * compare error-rate deltas across before/after measurement windows.
	 */
	getRegistryStats(): {
		rewrites: Array<{ tool: string; rule: string; count: number }>;
		rejects: Array<{ tool: string; rule: string; count: number }>;
		hints: Array<{ rule: string; count: number }>;
	} {
		const flatten = (source: Map<string, Map<string, number>>) => {
			const out: Array<{ tool: string; rule: string; count: number }> = [];
			for (const [tool, perRule] of source) {
				for (const [rule, count] of perRule) {
					out.push({ tool, rule, count });
				}
			}
			return out.sort((a, b) => b.count - a.count);
		};
		const hints = [...this._registryHints.entries()]
			.map(([rule, count]) => ({ rule, count }))
			.sort((a, b) => b.count - a.count);
		return { rewrites: flatten(this._registryRewrites), rejects: flatten(this._registryRejects), hints };
	}

	/**
	 * Write a single-session stats snapshot to `$PIT_STATS_EXPORT_DIR/<sessionId>.json`
	 * when that env var is set. Best-effort: failures are swallowed because the
	 * stats export is observability infrastructure, not load-bearing for the
	 * session lifecycle.
	 */
	private _maybeExportStats(): void {
		const dir = process.env.PIT_STATS_EXPORT_DIR;
		if (!dir) return;
		const toolStats = this.getToolCallStats();
		const registry = this.getRegistryStats();
		// Skip empty snapshots: keeps the export dir noise-free on quick
		// sessions that never invoked a tool.
		if (
			toolStats.length === 0 &&
			registry.rewrites.length === 0 &&
			registry.rejects.length === 0 &&
			registry.hints.length === 0
		) {
			return;
		}
		try {
			mkdirSync(dir, { recursive: true });
			const payload = {
				sessionId: this.sessionId,
				timestamp: new Date().toISOString(),
				cwd: this._cwd,
				toolStats,
				registry,
			};
			writeFileSync(join(dir, `${this.sessionId}.json`), `${JSON.stringify(payload, null, 2)}\n`);
		} catch {
			// Best-effort: never block dispose on a telemetry write.
		}
	}

	/**
	 * Band P Fase 0: stand up the durable diagnostics sink + guard-efficacy
	 * correlator for this session. Best-effort and observability-only, so it never
	 * throws into boot. Skipped for in-memory sessions (same rationale as the
	 * learned-error store: synthetic errors must not pollute the on-disk store) and
	 * when PIT_NO_TELEMETRY_SINK=1.
	 */
	private _initTelemetrySink(): void {
		if (isTelemetrySinkDisabled()) return;
		if (!this.sessionManager.isPersisted()) return;
		try {
			const sink = new DiagnosticsSink(defaultDiagnosticsDir(), { sessionId: this.sessionId, cwd: this._cwd });
			sink.start();
			this._diagnosticsSink = sink;
			// Correlator emits onto the same JSONL lane as the raw events.
			const correlator = new GuardEfficacyCorrelator((record) => sink.writeRecord(record));
			this._guardEfficacy = correlator;
			this._guardEfficacyUnsub = onDiagnostic((event) => correlator.onDiagnostic(event));
		} catch {
			// Fail-open: telemetry must never break session boot.
			this._diagnosticsSink = undefined;
			this._guardEfficacy = undefined;
		}
	}

	/**
	 * Band P Fase 0: write the session-summary snapshot (recovery + verification
	 * tally + diagnostics totals + cache totals) onto the diagnostics lane at
	 * dispose. Cache stats are skipped if the transcript is unreachable. Best-effort.
	 */
	private _persistDiagnosticsSummary(): void {
		const sink = this._diagnosticsSink;
		if (!sink) return;
		try {
			let cache: CacheStats | undefined;
			try {
				cache = computeCacheStats(this.state.messages);
			} catch {
				cache = undefined;
			}
			sink.writeRecord(
				buildSessionSummaryRecord({
					recovery: this._recovery.getSnapshot(),
					diagnostics: getRuntimeDiagnostics(),
					verification: { attempts: this._verificationAttemptsTotal, failures: this._verificationFailuresTotal },
					cache,
					cachePrefix: this.getCachePrefixDiagnostics(),
				}),
			);
		} catch {
			// Best-effort: never block dispose on telemetry.
		}
	}

	/**
	 * Append this session's learned-error fingerprints to a per-session JSONL
	 * file under `~/.pit/agent/learned-errors/`. Best-effort: failures are
	 * swallowed because the learned-error store is observability, not load-
	 * bearing for the session lifecycle.
	 */
	private _persistLearnedErrors(): void {
		if (this._learnedErrors.size === 0) return;
		// In-memory sessions (test harnesses, ephemeral SDK embeds) must not
		// pollute the shared cross-session store: their errors are synthetic
		// (temp-dir paths, faux providers) and would materialise misleading
		// dynamic Tier 4 rules for real sessions.
		if (!this.sessionManager.isPersisted()) return;
		try {
			persistSessionLearnedErrors(
				defaultLearnedErrorsDir(),
				{
					sessionId: this.sessionId,
					timestamp: new Date().toISOString(),
					cwd: this._cwd,
				},
				Array.from(this._learnedErrors.values()),
			);
		} catch {
			// Best-effort: never block dispose on telemetry.
		}
	}

	/**
	 * Persist the learned-error store at runtime when it changed this turn, so a
	 * session that is killed/crashes before dispose still contributes its warmed
	 * fingerprints to the cross-session store. Idempotent: `persistSessionLearnedErrors`
	 * OVERWRITES this session's single `${sessionId}.jsonl` (no append), so flushing
	 * every turn keeps one file at the latest accumulated state and never inflates
	 * `aggregateLearnedErrors`' per-file sessionCount. The dirty flag skips the
	 * writeFileSync/pruneOldFiles on turns that learned nothing new. Reuses
	 * `_persistLearnedErrors`' guards (size==0, !isPersisted, try/catch) verbatim.
	 */
	private _flushLearnedErrorsIfDirty(): void {
		if (!this._learnedErrorsDirty) return;
		this._learnedErrorsDirty = false;
		this._persistLearnedErrors();
	}

	/**
	 * Snapshot of per-tool call counts and top error fingerprints for this
	 * session. Sorted by descending error count, then by call count.
	 */
	getToolCallStats(): ToolStat[] {
		return this._toolCallStats.snapshot();
	}

	/**
	 * Number of consecutive identical (toolName,argsFingerprint) calls at the tail
	 * of the recent-invocation window. Useful for diagnostics overlays and for
	 * deciding when to inject a doom-loop reminder.
	 */
	getConsecutiveSimilarToolCalls(): number {
		return this._toolCallStats.getConsecutiveSimilarCount();
	}

	/** True when the recent-invocation tail has hit the doom-loop threshold. */
	isInToolCallDoomLoop(threshold?: number): boolean {
		return this._toolCallStats.isInDoomLoop(threshold);
	}

	/**
	 * Snapshot of the hottest files touched in this session, sorted by
	 * descending hits. Respects the configured `topN`/`minHits` floors when no
	 * options are passed.
	 */
	getFrequentFiles(options?: { topN?: number; minHits?: number }) {
		const cfg = this.settingsManager.getFrequentFilesSettings();
		return this._frequentFiles.getTop({
			topN: options?.topN ?? cfg.topN,
			minHits: options?.minHits ?? cfg.minHits,
		});
	}

	private get _verificationGate(): VerificationGateState {
		const self = this;
		return {
			get turnTouchedFiles() {
				return self._turnTouchedFiles;
			},
			set turnTouchedFiles(value: boolean) {
				self._turnTouchedFiles = value;
			},
			turnTouchedFilePaths: self._turnTouchedFilePaths,
			get turnTouchedVisual() {
				return self._turnTouchedVisual;
			},
			set turnTouchedVisual(value: boolean) {
				self._turnTouchedVisual = value;
			},
			get lastVisualFile() {
				return self._lastVisualFile;
			},
			set lastVisualFile(value: string | undefined) {
				self._lastVisualFile = value;
			},
			get turnFixSite() {
				return self._turnFixSite;
			},
			set turnFixSite(value: { file: string; line: number } | undefined) {
				self._turnFixSite = value;
			},
		};
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		return this._eventBus.subscribe(listener);
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // Already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	async dispose(): Promise<void> {
		// First synchronous step: mark disposed so a subagent that settles during/after
		// teardown is dropped by _deliverAsyncResult instead of mutating a dead session.
		this._disposed = true;
		// Cancel any in-flight verification check so its child process does not keep
		// holding the session cwd (Windows rmSync EBUSY in tests).
		this._verificationAbort?.abort();
		// Abort and drain any in-flight background (predictive) compaction BEFORE we
		// flush and disconnect below. A compaction started at the end of the prior
		// turn can otherwise append a CompactionEntry and reassign agent.state.messages
		// AFTER dispose — a write-after-dispose that corrupts the old session's branch
		// (and pollutes the hindsight bank) when the user switches/forks/new-sessions.
		this.abortCompaction();
		await awaitBackgroundCompaction(this.compaction);
		// Opt-in stats export for baseline measurement. Set PIT_STATS_EXPORT_DIR
		// to a writable directory to get one JSON file per session containing
		// tool-call totals + per-rule rewrite/reject counts. Used to measure
		// the before/after delta of the rewrite registry on real workloads.
		this._maybeExportStats();
		this._persistLearnedErrors();
		// Band P Fase 0: snapshot the session outcome, then tear down the sink.
		this._guardEfficacyUnsub?.();
		this._guardEfficacyUnsub = undefined;
		this._guardEfficacy = undefined;
		this._persistDiagnosticsSummary();
		this._diagnosticsSink?.dispose();
		this._diagnosticsSink = undefined;
		this._recovery.dispose();

		await this.sessionManager.flushWrites();
		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventBus.clear();
		cleanupSessionResources(this.sessionId);
		// Abort the background frequent-files compute and wait for it to settle.
		// The compute spawns a `git` child whose cwd is the session cwd; without
		// this await, tests that `rmSync(tempDir)` immediately after dispose hit
		// EBUSY on Windows because the child still holds the directory.
		if (this._frequentFilesAbort) {
			this._frequentFilesAbort.abort();
			this._frequentFilesAbort = undefined;
		}
		if (this._frequentFilesPromise) {
			try {
				// Frequent-files is a best-effort prompt hint. It is aborted above, but
				// Windows can occasionally leave the child-process callback delayed;
				// dispose must not hang the CLI or the test harness indefinitely for it.
				await Promise.race([this._frequentFilesPromise, sleep(FREQUENT_FILES_DISPOSE_WAIT_MS)]);
			} catch {
				// ignore
			}
			this._frequentFilesPromise = undefined;
		}
		// Persist the session tracker so the next session boots warm. Same
		// gate as hydrate; failures are swallowed (the next session just
		// starts cold).
		if (this.settingsManager.getFrequentFilesSettings().enabled && this._frequentFiles.size() > 0) {
			try {
				saveFrequentFilesSnapshot(defaultFrequentFilesPath(this._cwd), this._frequentFiles.toSnapshot());
			} catch {
				// best-effort persist; never block dispose
			}
		}
		// Clear hindsight bank registry only if this session owns the current bank.
		if (this._hindsightBank && getCurrentHindsightBank() === this._hindsightBank) {
			setCurrentHindsightBank(undefined);
		}
		this._hindsightBank = undefined;
		// Dispose deferred-output store and clear registry if this session owns it.
		if (this._deferredOutputStore && getCurrentDeferredOutputStore() === this._deferredOutputStore) {
			this._deferredOutputStore.dispose();
			setCurrentDeferredOutputStore(undefined);
		}
		this._deferredOutputStore = undefined;
		// Clear the recall_history source if this session owns it.
		if (getCurrentHistoryRecallSource() !== undefined) {
			setCurrentHistoryRecallSource(undefined);
		}
		// Clear preview queue registry only if this session owns the current queue.
		if (this._previewQueue && getCurrentPreviewQueue() === this._previewQueue) {
			setCurrentPreviewQueue(undefined);
		}
		this._previewQueue = undefined;
		// Tear down Chrome DevTools connections.
		if (this._chromeDevtools) {
			this._chromeDevtools.dispose();
			if (getCurrentChromeDevtoolsManager() === this._chromeDevtools) {
				setCurrentChromeDevtoolsManager(undefined);
			}
			this._chromeDevtools = undefined;
		}
		// Clear tool discovery index registry only if this session owns it.
		if (this._toolDiscoveryIndex && getCurrentToolDiscoveryIndex() === this._toolDiscoveryIndex) {
			setCurrentToolDiscoveryIndex(undefined);
			// The unknown-tool hint provider reads the current index; drop it with the
			// index so a disposed session leaves no dangling global.
			setUnknownToolHintProvider(undefined);
		}
		this._toolDiscoveryIndex = undefined;
		// Tear down eval kernels owned by this session.
		if (this._evalKernelManager) {
			if (getCurrentEvalKernelManager() === this._evalKernelManager) {
				setCurrentEvalKernelManager(undefined);
			}
			try {
				await this._evalKernelManager.closeAll();
			} catch {
				// ignore
			}
			this._evalKernelManager = undefined;
		}
		// Tear down LSP servers owned by this session.
		if (this._lspManager) {
			if (getCurrentLspManager() === this._lspManager) {
				setCurrentLspManager(undefined);
			}
			try {
				await this._lspManager.dispose();
			} catch {
				// ignore
			}
			this._lspManager = undefined;
		}
		setDiagnosticsOnWrite(false);
		setFormatOnWrite(false);
		// Leave the message bus so a stale Main can't receive routed messages.
		this._unsubMessagingActivity?.();
		this._unsubMessagingActivity = undefined;
		if (this._messagingId) {
			agentMessageBus.unregister(this._messagingId);
			this._messagingId = undefined;
		}
		if (getCurrentGoalManager() === this._goal) {
			setCurrentGoalManager(undefined);
		}
		if (getCurrentTokenGovernor() === this._tokenGovernor) {
			setCurrentTokenGovernor(undefined);
		}
		if (getCurrentTodoManager() === this._todo) {
			setCurrentTodoManager(undefined);
		}
		if (getCurrentPlanManager() === this._plan) {
			setCurrentPlanManager(undefined);
		}
		if (getCurrentVerificationProbe() === this._verificationProbe) {
			setCurrentVerificationProbe(undefined);
		}
		this._verificationProbe = undefined;
		// Band P / P4: drop any self-review findings so a torn-down session can't
		// block a later goal_complete via the module-level R9 registry.
		clearCurrentSelfReviewFindings();
		// Band P / P5: release the conventions contract (identity-checked so a
		// newer session's contract is never clobbered by a stale dispose).
		if (getCurrentSessionContract() === this._sessionContract) {
			setCurrentSessionContract(undefined);
		}
		this._sessionContract = undefined;
		// Tear down any active debug session so adapters don't outlive the session.
		if (this.settingsManager.getDebugSettings().enabled) {
			void dapSessionManager.disposeAll().catch(() => {});
		}
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** The id under which this session is registered on the inter-agent message bus, if any. */
	get messagingId(): string | undefined {
		return this._messagingId;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 * Result is cached by array identity: recomputed only when setActiveToolsByName()
	 * reassigns agent.state.tools to a new array.
	 */
	getActiveToolNames(): string[] {
		if (this._activeToolNamesCache?.tools !== this.agent.state.tools) {
			this._activeToolNamesCache = {
				tools: this.agent.state.tools,
				names: this.agent.state.tools.map((t) => t.name),
			};
		}
		return this._activeToolNamesCache.names;
	}

	/**
	 * Get all configured tools with name, description, parameter schema, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	// =========================================================================
	// Autonomous goal mode (/goal command + goal_complete tool)
	// =========================================================================

	/** Snapshot of the current goal, or undefined when none is active. */
	goalSnapshot(): GoalSnapshot | undefined {
		return this._goal.snapshot();
	}

	/** Current reactive recovery level (`lean` when disabled or no thrash yet). */
	getRecoveryLevel(): RecoveryLevel {
		return this._recovery.getLevel();
	}

	/** Compact statusline string for the footer (empty when no goal). */
	goalStatusLine(): string {
		// ⟳ marker when the agent is actively driving the goal (streaming a turn
		// or inside the auto-continuation loop) vs. an idle active goal.
		return this._goal.statusLine(this.goalIsDriving());
	}

	/** True quando o agente está ativamente dirigindo o goal (streaming ou continuation). */
	goalIsDriving(): boolean {
		return this._inGoalContinuation || this.isStreaming;
	}

	/** Multi-line human summary for `/goal` with no args. */
	goalSummaryText(): string {
		return this._goal.summaryText();
	}

	/** Whether the agent should auto-continue after the current prompt. */
	goalShouldAutoContinue(): boolean {
		return this._goal.shouldAutoContinue();
	}

	/** Start (or replace) the autonomous goal and surface the goal_complete tool. */
	startGoal(objective: string, opts: { tokenBudget?: number } = {}): GoalSnapshot {
		const snap = this._goal.start(objective, opts);
		this._tokenGovernor.reset();
		this._tokenGovernor.bindGoal(this._goal);
		this._tokenGovernor.setBudget(opts.tokenBudget);
		this._activateGoalTool(true);
		this._persistGoal();
		return snap;
	}

	editGoal(objective: string): void {
		this._goal.edit(objective);
		this._persistGoal();
	}

	pauseGoal(): void {
		this._goal.pause();
		this._persistGoal();
	}

	resumeGoal(): void {
		this._goal.resume();
		this._persistGoal();
	}

	/** Raise the active goal's token budget (lifts a budget_limited goal). */
	setGoalTokenBudget(tokenBudget: number): void {
		this._goal.setTokenBudget(tokenBudget);
		this._tokenGovernor.setBudget(tokenBudget);
		this._persistGoal();
	}

	clearGoal(): void {
		this._goal.clear();
		this._tokenGovernor.reset();
		this._activateGoalTool(false);
		this._persistGoal();
	}

	getTokenBudgetSnapshot(): TokenBudgetSnapshot {
		return this._tokenGovernor.snapshot();
	}

	recordFusionSpend(tokens: number): void {
		this._tokenGovernor.recordFusion(tokens);
	}

	private _activateGoalTool(active: boolean): void {
		const names = new Set(this.getActiveToolNames());
		if (active) names.add("goal_complete");
		else names.delete("goal_complete");
		this.setActiveToolsByName([...names]);
	}

	/** Record a finished turn into the goal (token usage + interruption status). */
	private _recordGoalTurn(message: unknown): void {
		if (!this._goal.get()) return;
		const m = message as { usage?: { input?: number; output?: number }; stopReason?: string } | undefined;
		const usage = m?.usage;
		const tokens = usage ? (usage.input ?? 0) + (usage.output ?? 0) : 0;
		this._tokenGovernor.recordMain(tokens);
		this._goal.recordIteration();
		if (typeof m?.stopReason === "string") this._goal.onInterrupted(m.stopReason);
		// Persist progress so token/iteration counts survive /reload. Status
		// changes flush immediately; otherwise writes are throttled.
		const after = this._goal.get();
		if (!after) return;
		const statusChanged = after.status !== this._lastGoalStatus;
		if (statusChanged || Date.now() - this._lastGoalPersistMs > GOAL_PERSIST_THROTTLE_MS) {
			this._persistGoal();
		}
	}

	private _persistGoal(): void {
		try {
			const snapshot = this._goal.serialize() ?? null;
			this.sessionManager.appendCustomEntry("goal", snapshot);
			this._lastGoalStatus = snapshot?.status;
			this._lastGoalPersistMs = Date.now();
		} catch {
			// Persistence is best-effort; a write failure must not break the session.
		}
	}

	private _restoreGoalFromSession(): void {
		this._restoreStateFromSession();
	}

	// =========================================================================
	// Native todo list (the `todo` tool + /todos command + live overlay)
	// =========================================================================

	/** Todos + counts for the live overlay (interactive mode). */
	todoForOverlay(): { items: TodoItem[]; done: number; total: number } {
		const { done, total } = this._todo.counts();
		return { items: this._todo.list(), done, total };
	}

	/** Multi-line human summary for the `/todos` command. */
	todoSummaryText(): string {
		return this._todo.summaryText();
	}

	/**
	 * Register a listener fired whenever the todo list changes, so the interactive
	 * mode can repaint the live overlay in real time (instead of relying on an
	 * incidental render). Re-applied on every session rebind. `undefined` clears it.
	 */
	setTodoChangeListener(listener: (() => void) | undefined): void {
		this._todo.setChangeListener(listener);
	}

	/** True while any todo is in_progress (drives the overlay spinner). */
	todoHasInProgress(): boolean {
		return this._todo.hasInProgress();
	}

	/**
	 * `/chrome` command: ensure a Chrome with the debug port is up (reconnect or
	 * auto-launch), then return a human status string.
	 */
	async ensureChrome(): Promise<string> {
		const cfg = this.settingsManager.getChromeDevtoolsSettings();
		if (!cfg.enabled) return "Chrome DevTools is disabled (set chromeDevtools.enabled to use it).";
		const mgr = this._chromeDevtools;
		if (!mgr) return "Chrome DevTools is unavailable in this session.";
		try {
			const { launched } = await mgr.ensureBrowser();
			const selected = mgr.selectedPageId();
			return [
				`🌐 Chrome DevTools — ${launched ? "launched" : "connected"} at ${cfg.host}:${cfg.debugPort}`,
				launched ? `   profile: ${cfg.userDataDir}` : "",
				selected ? `   selected page: ${selected}` : "   no page selected (ask me to open a URL)",
			]
				.filter(Boolean)
				.join("\n");
		} catch (err) {
			return `🌐 Chrome DevTools — could not start: ${(err as Error).message}`;
		}
	}

	private _persistTodo(): void {
		try {
			this.sessionManager.appendCustomEntry("todo", this._todo.serialize());
		} catch {
			// Best-effort; a write failure must not break the session.
		}
	}

	private _persistPlan(): void {
		try {
			this.sessionManager.appendCustomEntry("plan", this._plan.serialize());
		} catch {
			// Best-effort; a write failure must not break the session.
		}
	}

	/**
	 * Single-pass restore of both goal and todo state from the session file.
	 * Called once in the constructor (via _restoreGoalFromSession) so that
	 * getEntries() is iterated only once instead of twice.
	 */
	private _restoreStateFromSession(): void {
		try {
			let latestGoal: GoalState | undefined;
			let latestTodo: TodoState | undefined;
			let latestPlan: PlanState | undefined;
			let latestOrchestration: Orchestration | undefined;
			for (const e of this.sessionManager.getEntries()) {
				const entry = e as {
					type?: string;
					customType?: string;
					data?: GoalState | TodoState | PlanState | { orchestration?: Orchestration } | null;
				};
				if (entry.type !== "custom") continue;
				if (entry.customType === "goal") {
					latestGoal = (entry.data as GoalState | null) ?? undefined;
				} else if (entry.customType === "todo") {
					latestTodo = (entry.data as TodoState | null) ?? undefined;
				} else if (entry.customType === "plan") {
					latestPlan = (entry.data as PlanState | null) ?? undefined;
				} else if (entry.customType === "orchestration") {
					const data = entry.data as { orchestration?: Orchestration } | null;
					if (data?.orchestration === "solo" || data?.orchestration === "fusion") {
						latestOrchestration = data.orchestration;
					}
				}
			}
			if (latestGoal && latestGoal.status !== "complete") {
				this._goal.restore(latestGoal);
				this._tokenGovernor.restoreSpend(latestGoal.tokensUsed, latestGoal.tokenBudget, latestGoal.tokenSpendSplit);
				this._activateGoalTool(true);
			}
			if (latestTodo) this._todo.restore(latestTodo);
			if (latestPlan) this._plan.restore(latestPlan);
			if (latestOrchestration) this._orchestration = latestOrchestration;
		} catch {
			// Best-effort restore; ignore malformed/legacy entries.
		}
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Preferentially patches the tools/guidelines surface in-place (keeps
	 * append/context/skills/dynamic suffix intact); falls back to a full rebuild
	 * when the prompt is custom or anchors are missing.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) toolSnippets[name] = snippet;
			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) promptGuidelines.push(...toolGuidelines);
		}
		promptGuidelines.push(...getEngineeringStyleGuidelines(this.settingsManager.getEngineeringStyle()));

		// Skills block is gated on `read`; flipping its presence needs a full rebuild
		// so the skills section stays consistent with the tools list (T07).
		const prevHadRead = (this._baseSystemPromptOptions?.selectedTools ?? []).includes("read");
		const nextHasRead = validToolNames.includes("read");
		const readPresenceFlipped = prevHadRead !== nextHasRead;

		const patched =
			!readPresenceFlipped && this._baseSystemPrompt
				? patchSystemPromptToolSurface(this._baseSystemPrompt, {
						selectedTools: validToolNames,
						toolSnippets,
						hiddenToolCount: this._hiddenToolCountSnapshot ?? 0,
					})
				: undefined;

		if (patched) {
			this._baseSystemPrompt = patched;
			if (this._baseSystemPromptOptions) {
				this._baseSystemPromptOptions = {
					...this._baseSystemPromptOptions,
					selectedTools: validToolNames,
					toolSnippets,
					promptGuidelines,
				};
			}
			this._trackPrefixStability(patched, "tool-surface");
			this.agent.state.systemPrompt = this._baseSystemPrompt;
			return;
		}

		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames, "tool-surface");
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this.compaction.autoCompactionAbortController !== undefined ||
			this.compaction.compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[], reason = "init"): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		// Append engineering-style guideline pack (opt-in via settings). Pushed
		// before downstream caller-supplied guidelines so they remain authoritative
		// on conflict; buildSystemPrompt deduplicates verbatim repeats.
		promptGuidelines.push(...getEngineeringStyleGuidelines(this.settingsManager.getEngineeringStyle()));

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const memoryFiles = this._resourceLoader.getMemoryFiles();
		const appendSections = [...loaderAppendSystemPrompt];
		if (memoryFiles.length > 0 && !this.settingsManager.getMemorySettings().disableInjection) {
			const memoryOnDemand = !isTruthyEnvFlag(process.env.PIT_NO_MEMORY_ON_DEMAND);
			const memoryBlock = (
				memoryOnDemand ? formatMemoryHintForPrompt(memoryFiles, this._cwd) : formatMemoryForPrompt(memoryFiles)
			).trim();
			if (memoryBlock.length > 0) {
				appendSections.push(memoryBlock);
			}
		}
		// Session frequent-files tracker: surfaces hot files so the agent prefers
		// reading known-relevant paths before broad search. Handed to
		// buildSystemPrompt for the dynamic suffix (NOT appendSections, which
		// lands in the cacheable prefix): the tracker mutates as the session
		// works, and a mutable block in the prefix rewrites it on every rebuild.
		const ffCfg = this.settingsManager.getFrequentFilesSettings();
		const sessionFrequentFiles = ffCfg.enabled
			? this._frequentFiles.getTop({ topN: ffCfg.topN, minHits: ffCfg.minHits })
			: [];
		// Hindsight session-summary prefix: surfaces the most recent N
		// "session-summary" entries from the bank so the next turn starts with
		// a compact mental model of prior sessions. Section is only emitted
		// when the bank holds at least one session summary.
		if (this._hindsightBank) {
			const hindsightOnDemand = !isTruthyEnvFlag(process.env.PIT_NO_HINDSIGHT_ON_DEMAND);
			const summaryBlock = hindsightOnDemand ? formatHindsightHintForPrompt() : formatSessionSummariesForPrompt();
			if (summaryBlock) {
				appendSections.push(summaryBlock);
			}
		}
		const appendSystemPrompt = appendSections.length > 0 ? appendSections.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;
		const gitBranch = readGitBranch(this._cwd);

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
			// Repo-level frequent-files index — populated asynchronously after boot.
			// Empty until the first compute resolves; harmless to pass either way.
			frequentFiles: this._frequentFilesIndex.length > 0 ? this._frequentFilesIndex : undefined,
			hotFileOutlines: this._hotFileOutlines.length > 0 ? this._hotFileOutlines : undefined,
			// Session tracker — rendered in the dynamic suffix, wins over the boot
			// index once it has entries (only one <frequent_files> is emitted).
			sessionFrequentFiles: sessionFrequentFiles.length > 0 ? sessionFrequentFiles : undefined,
			// Git branch — read synchronously from .git/HEAD on every rebuild
			// (subprocess-free), rendered in the dynamic suffix only.
			gitState: gitBranch ? { branch: gitBranch } : undefined,
			// Band P (P1/P3) context-composer block — dynamic suffix only, recomputed
			// per rebuild from the live prompt + cached living map (cache-neutral).
			groundedContext: this._composeGroundedContext() || undefined,
			// Gate frequent_files / outlines when wire occupancy is high (T02).
			contextOccupancyPercent: this.getContextUsage()?.percent ?? undefined,
			// Stable per-session hidden-tool count (snapshotted after seeding) so the
			// discovery nudge stays in the cacheable prefix without flipping as the
			// live index mutates. Always passed explicitly (even when 0) rather than
			// `undefined` — `buildSystemPrompt`'s `hiddenToolCount ?? ...` fallback
			// reads the process-wide "current" discovery index (tool-discovery.ts),
			// which is safe for a single in-process session but would leak another
			// concurrently-running AgentSession's count into this one's prefix if we
			// ever deferred to it here. `??` treats an explicit 0 the same as
			// "no hidden tools", so this is behavior-neutral for the single-session
			// case and only removes the cross-session ambiguity.
			hiddenToolCount: this._hiddenToolCountSnapshot,
		};
		const prompt = buildSystemPrompt(this._baseSystemPromptOptions);
		this._trackPrefixStability(prompt, reason);
		return prompt;
	}

	/**
	 * Record whether this rebuild changed the cache-stable prefix (the slice
	 * before SYSTEM_PROMPT_DYNAMIC_MARKER). Only prefix changes invalidate the
	 * prompt cache; dynamic-suffix churn (date, cwd, frequent-files) is free. The
	 * first observed prefix is the baseline and never counts as a rewrite.
	 */
	private _trackPrefixStability(prompt: string, reason: string): void {
		const { staticPart } = splitSystemPromptOnDynamic(prompt);
		if (this._cachePrefixBaseline === undefined) {
			this._cachePrefixBaseline = staticPart;
			return;
		}
		if (staticPart === this._cachePrefixBaseline) {
			return;
		}
		this._cachePrefixBaseline = staticPart;
		this._cachePrefixRebuilds++;
		this._cachePrefixReasons.set(reason, (this._cachePrefixReasons.get(reason) ?? 0) + 1);
	}

	/**
	 * Recompute the hidden-tool snapshot after extension session_start handlers
	 * have populated the discovery index (e.g. MCP deferral). The nudge is binary
	 * (rendered when the count is > 0), so only a 0↔N transition changes the
	 * prompt — a count that stays > 0 leaves it identical and skips the rebuild.
	 * When it does flip, re-baseline (pre-request, so it is not counted as churn)
	 * so the nudge sits in the cacheable prefix from the first request.
	 */
	private _resyncHiddenToolSnapshot(): void {
		const count = this._toolDiscoveryIndex?.listHidden().length ?? 0;
		if (count === this._hiddenToolCountSnapshot) return;
		const nudgePresenceFlips = count > 0 !== this._hiddenToolCountSnapshot > 0;
		this._hiddenToolCountSnapshot = count;
		if (!nudgePresenceFlips) return;
		this._cachePrefixBaseline = undefined;
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames(), "tool-discovery-resync");
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	/**
	 * Source-measured prompt-cache prefix churn: how many times the cacheable
	 * prefix was rewritten this session and the trigger breakdown. Pairs with
	 * getCacheStats()'s usage-derived `instabilityTurn` — this answers *why* the
	 * prefix moved, that one answers *whether* hit-rate collapsed. `reasons` is
	 * sorted descending by count.
	 */
	getCachePrefixDiagnostics(): { rebuilds: number; reasons: Array<{ reason: string; count: number }> } {
		const reasons = Array.from(this._cachePrefixReasons, ([reason, count]) => ({ reason, count })).sort(
			(a, b) => b.count - a.count || a.reason.localeCompare(b.reason),
		);
		return { rebuilds: this._cachePrefixRebuilds, reasons };
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		// Drain any in-flight background/predictive compaction before starting ANY turn.
		// The compaction pipeline reassigns agent.state.messages outside runWithLifecycle;
		// a turn started concurrently (notably from _deliverAsyncResult and sendCustomMessage,
		// which enter here without going through _promptOnce) would clobber/lose messages.
		// Idempotent no-op when there is no background compaction.
		await awaitBackgroundCompaction(this.compaction);
		try {
			await this.agent.prompt(messages);
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} finally {
			this._flushPendingBashMessages();
		}
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!msg) {
			return false;
		}

		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true;
		}

		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this.emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
		}

		// The agent run is settling without a pending retry (success or terminal
		// error): revert any transient fallback model back to the primary so the
		// next turn starts on the preferred model instead of staying silently
		// pinned to the (typically weaker) fallback for the rest of the session.
		await this._restoreFallbackModelIfActive();

		// End-of-turn: allow predictive background compaction (overlaps the user's
		// read time so the next prompt rarely waits).
		return await checkCompaction(this.compaction, msg, true, true);
	}

	/**
	 * Attach images to be merged into the NEXT user prompt (e.g. a clipboard
	 * paste in the TUI, where the image arrives before the user submits text).
	 * They are consumed exactly once, when the next user message is built.
	 */
	attachImages(images: ImageContent[]): void {
		if (images.length > 0) this._attachedImages.push(...images);
	}

	/** Drop any pending attached images without sending them (e.g. input cleared). */
	clearAttachedImages(): void {
		this._attachedImages = [];
	}

	/** Number of images currently buffered for the next prompt. */
	getAttachedImageCount(): number {
		return this._attachedImages.length;
	}

	/**
	 * Clear the per-model-attempt failure budget (per-tool failure counts + the
	 * fire-once set). Called at the top of prompt() and before each goal
	 * continuation so the budget re-arms per attempt instead of lasting the whole
	 * goal — in autonomous mode a single prompt() drives many _promptOnce turns.
	 */
	private _resetTurnFailureBudget(): void {
		this._steering.resetTurnFailureBudget();
	}

	/**
	 * Send a prompt to the agent, then (in autonomous goal mode) keep driving
	 * continuation turns until the goal is complete, paused, budget-limited, or
	 * interrupted. A safety cap bounds runaway loops; hitting it pauses the goal.
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		// A fresh user/extension prompt clears any prior Esc interrupt so the goal
		// loop and verification gate are allowed to run again.
		this._userInterrupted = false;
		// Reset the per-prompt-cycle flag that arms the verification gate.
		this._turnTouchedFiles = false;
		this._turnTouchedFilePaths.clear();
		this._turnFixSite = undefined;
		this._turnTouchedVisual = false;
		this._turnUsedPreview = false;
		// Band P / P4: fresh per-cycle risk aggregate, and drop any stale self-review
		// findings from the previous cycle (they block goal_complete via R9).
		this._turnRisk.reset();
		clearCurrentSelfReviewFindings();
		// Per-prompt reset for the todo-first safety net (the cadence tracker itself
		// persists across the session, like _stagnation).
		this._steering.resetPromptWorkActions();
		// Reset the per-turn, per-tool failure budget so each tool starts the turn
		// with a fresh allowance. Re-armed before every goal continuation below so
		// the budget is per model-attempt, not shared across the whole goal.
		this._resetTurnFailureBudget();
		await this._promptOnce(text, options);

		// Re-entrant call from within a continuation: the outer prompt() owns the
		// continuation loop and the verification gate.
		if (this._inGoalContinuation) return;

		// Goal auto-continuation. Guarded so a continuation prompt (or a steer
		// arriving mid-loop) never spawns a nested loop, and stopped immediately
		// when the user interrupts (Esc) so the task doesn't restart itself.
		if (!this._userInterrupted && this._goal.shouldAutoContinue()) {
			this._inGoalContinuation = true;
			try {
				let iterations = 0;
				const maxIterations = this.settingsManager.getGoalMaxAutoIterations();
				while (!this._userInterrupted && this._goal.shouldAutoContinue()) {
					if (iterations++ >= maxIterations) {
						this.pauseGoal();
						this._emitGoalCapNote(maxIterations);
						break;
					}
					// Re-arm the per-attempt failure budget so each continuation gets a
					// fresh allowance instead of sharing 3 failures across the whole goal.
					this._resetTurnFailureBudget();
					await this._promptOnce(this._goal.continuationPrompt(), {
						expandPromptTemplates: false,
						source: options?.source,
					});
				}
			} finally {
				this._inGoalContinuation = false;
			}
		}

		// Background-check guard: if the agent backgrounded a test/check, make sure it
		// has finished and passed before the turn hands back — never report done or
		// suggest a commit on a test that is still running (or already failed).
		await this._awaitPendingChecksBeforeHandoff(options);

		// Native verification gate: after a code-modifying turn, run the project
		// check and re-inject failures so the agent self-corrects before "done".
		await this._runVerificationGate(options);
	}

	/**
	 * Drain background verification-class jobs before handoff. Polls until they
	 * exit or `pendingChecks.maxWaitMs` elapses, then runs a bounded internal fix
	 * loop while `isBusy` stays true. Independent of `verification.enabled`.
	 */
	private async _awaitPendingChecksBeforeHandoff(options?: PromptOptions): Promise<void> {
		if (this._userInterrupted || this._lastTurnAborted()) return;
		const settings = this.settingsManager.getPendingChecksSettings();
		if (!settings.enabled) return;

		const abort = new AbortController();
		this._pendingChecksAbort = abort;
		let fixes = 0;

		try {
			while (true) {
				if (abort.signal.aborted || this._userInterrupted) return;

				const pending = pendingVerificationJobs(listBashBackgroundJobs());
				if (pending.length === 0) return;

				const ids = new Set(pending.map((j) => j.id));
				const label = pending.length === 1 ? pending[0].command : `${pending.length} background checks`;
				const startMs = Date.now();
				const deadline = startMs + settings.maxWaitMs;

				this._inPendingChecksDrain = true;
				try {
					while (Date.now() < deadline) {
						if (abort.signal.aborted || this._userInterrupted) return;
						this.emit({
							type: "pending_check",
							phase: "waiting",
							command: label,
							elapsedMs: Date.now() - startMs,
						});
						if (listBashBackgroundJobs().every((j) => !ids.has(j.id) || j.exited)) break;
						await new Promise<void>((res) => {
							const onAbort = () => {
								clearTimeout(t);
								res();
							};
							const t = setTimeout(() => {
								abort.signal.removeEventListener("abort", onAbort);
								res();
							}, 500);
							abort.signal.addEventListener("abort", onAbort, { once: true });
						});
					}
				} finally {
					this._inPendingChecksDrain = false;
				}

				if (abort.signal.aborted || this._userInterrupted) return;

				const jobs = listBashBackgroundJobs().filter((j) => ids.has(j.id));
				// An exited job whose exitCode stayed `null` (spawn error / waitForChildProcess
				// rejection — see tools/bash.ts .catch) never actually succeeded, so it must
				// count as a non-success, not a silent pass.
				const failed = jobs.filter((j) => j.exited && j.exitCode !== 0);
				const running = jobs.filter((j) => !j.exited);
				if (failed.length === 0 && running.length === 0) {
					this.emit({ type: "pending_check", phase: "passed", command: label });
					continue;
				}

				const elapsedMs = Date.now() - startMs;
				if (failed.length > 0) {
					this.emit({
						type: "pending_check",
						phase: "failed",
						command: label,
						elapsedMs,
						exitCode: failed[0]?.exitCode ?? undefined,
						attempt: fixes + 1,
						maxAttempts: settings.maxFixAttempts,
					});
				} else {
					this.emit({
						type: "pending_check",
						phase: "timeout",
						command: label,
						elapsedMs,
						attempt: fixes + 1,
						maxAttempts: settings.maxFixAttempts,
					});
				}

				if (fixes >= settings.maxFixAttempts) return;

				fixes++;
				await this._promptOnce(pendingChecksPrompt(failed, running), {
					expandPromptTemplates: false,
					source: options?.source,
				});
			}
		} finally {
			this._inPendingChecksDrain = false;
			this._pendingChecksAbort = undefined;
		}
	}

	/**
	 * Verification gate — the "test what you built, then fix it" loop. After a
	 * turn that modified files, run the project's check command; on failure,
	 * re-inject the output as a continuation prompt so the agent fixes it, bounded
	 * by `maxAttempts`. No-op when disabled, when nothing changed, when the turn
	 * was aborted, or when no check command can be detected (gate stays inert).
	 */
	private _applyLiveContextEconomyAfterTool(toolCall: AgentToolCall, isError: boolean): void {
		const contextWindow = this.model?.contextWindow ?? 0;
		const outcome = applyLiveContextEconomyAfterToolSuccess(
			this.agent.state.messages,
			toolCall,
			isError,
			contextWindow,
		);
		if (outcome.reclaimed > 0) {
			this.agent.state.messages = outcome.messages;
			this._invalidateCtxCaches();
		}
	}

	private _pruneContextForProvider(messages: AgentMessage[]): AgentMessage[] {
		const contextWindow = this.model?.contextWindow ?? 0;
		const contextTokens = estimateContextTokens(messages).tokens;
		const protectTurns = pressurePruneProtectTurns(contextTokens, contextWindow);
		const runThinkingCap =
			!isTruthyEnvFlag(process.env.PIT_NO_THINKING_CAP) && wouldApplyOldThinkingCap(messages, protectTurns);
		const proactivePruneEnabled = !isTruthyEnvFlag(process.env.PIT_NO_PROACTIVE_PRUNE);

		let runToolPrune = false;
		let runSupersedeOnly = false;
		let floor = 0;
		let threshold = 0;

		const prunePlan = planContextPrune(messages, protectTurns);
		if (proactivePruneEnabled) {
			const floorRaw = Number(process.env.PIT_PROACTIVE_PRUNE_FLOOR);
			floor = proactivePruneFloor(contextWindow, Number.isFinite(floorRaw) ? floorRaw : undefined);
			if (contextTokens <= floor) {
				runSupersedeOnly = wouldApplySupersedeOnly(messages, protectTurns, prunePlan);
			} else {
				threshold = adaptivePruneThreshold(contextTokens, contextWindow);
				runToolPrune = wouldPruneOldToolOutputs(messages, threshold, protectTurns, prunePlan);
			}
		}

		if (!runThinkingCap && !runToolPrune && !runSupersedeOnly) return messages;

		const copy = cloneToolResultMessagesForPrune(messages);
		let reclaimed = 0;

		if (runThinkingCap) {
			const thinkingReclaimed = applyOldThinkingCap(copy, protectTurns);
			if (thinkingReclaimed > 0) {
				reclaimed += thinkingReclaimed;
				recordDiagnostic({
					category: "prune.thinking-cap",
					level: "info",
					source: "agent-session.pruneContextForProvider",
					context: {
						bytes: thinkingReclaimed,
						note: `ctx=${contextTokens}tok protectTurns=${protectTurns}`,
					},
				});
			}
		}

		if (runToolPrune) {
			const toolReclaimed = pruneOldToolOutputs(copy, threshold, protectTurns, true, prunePlan);
			if (toolReclaimed > 0) {
				reclaimed += toolReclaimed;
				recordDiagnostic({
					category: "prune.proactive",
					level: "info",
					source: "agent-session.pruneContextForProvider",
					context: {
						bytes: toolReclaimed,
						note: `ctx=${contextTokens}tok reclaimed=${toolReclaimed}tok protectTurns=${protectTurns}`,
					},
				});
			}
		} else if (runSupersedeOnly) {
			const supersedeReclaimed = applySupersedeOnly(copy, protectTurns, prunePlan);
			if (supersedeReclaimed > 0) {
				reclaimed += supersedeReclaimed;
				recordDiagnostic({
					category: "prune.supersede-only",
					level: "info",
					source: "agent-session.pruneContextForProvider",
					context: {
						bytes: supersedeReclaimed,
						note: `ctx=${contextTokens}tok floor=${floor} protectTurns=${protectTurns}`,
					},
				});
			}
		}

		return reclaimed > 0 ? copy : messages;
	}

	/**
	 * Emit a subagent lifecycle "start" event so the TUI can show a live status
	 * line while a subagent runs (instead of the subagent being a black box).
	 * @internal Wired from agent-session-services via __bindBuiltInRefs.
	 */
	_emitSubagentStart(handle: string): void {
		this.emit({ type: "subagent_start", handle });
	}

	/**
	 * Emit a lightweight per-turn progress event for a running subagent.
	 * @internal Wired from agent-session-services via __bindBuiltInRefs.
	 */
	_emitSubagentProgress(handle: string, info: { turn: number; lastTool?: string }): void {
		this.emit({ type: "subagent_progress", handle, turn: info.turn, lastTool: info.lastTool });
	}

	/**
	 * Handle a settled async (op:"spawn") subagent result. Always emits a
	 * `subagent_complete` status line so the TUI surfaces progress.
	 *
	 * Default (Claude Code parity): does NOT re-inject the result into the chat —
	 * the parent collects it explicitly via op:"join"/"poll", so finishing
	 * subagents never interrupt the parent mid-turn with a new message. Returning
	 * false leaves the handle undelivered so join returns the real payload.
	 *
	 * Opt-in legacy behavior (PIT_ASYNC_REINJECT): re-inject the result so the
	 * model never has to poll. Routes by liveness: while a run is in flight, queue
	 * it as a follow-up (guaranteed to run a turn before the agent stops); while
	 * idle, start a fresh turn (_runAgentPrompt) so the result surfaces on its own.
	 *
	 * NOTE: in the opt-in path it must NOT use injectPassive — a passive message is
	 * dropped if the current turn stops without more tool calls (common in
	 * fan-out), yet this returns true and the coordinator marks the handle
	 * delivered, silently losing the result. followUp keeps the loop alive until
	 * the message is consumed. Called from a detached spawn IIFE, so it must never
	 * throw.
	 *
	 * @internal Wired from agent-session-services via __bindBuiltInRefs; not part
	 * of the public API. Kept non-private only so that cross-module wiring can
	 * reach it without an unsafe cast.
	 * @returns true when the result was re-injected (so the coordinator marks the
	 * handle delivered and poll/join won't repeat it); false otherwise (the
	 * default — result stays collectible via join/poll).
	 */
	_deliverAsyncResult(handle: string, text: string, status: "done" | "error"): boolean {
		// Session torn down: an orphaned subagent settled late. Drop it without mutating
		// dead state. Return true so the coordinator marks the handle delivered (poll/join
		// won't repeat) — there is no live session left to collect it from anyway.
		if (this._disposed) return true;
		this.emit({ type: "subagent_complete", handle, status });
		// Default: no auto re-injection (Claude Code parity). Collect via join/poll.
		// PIT_ASYNC_REINJECT opts back into the legacy auto-delivery below.
		if (!isTruthyEnvFlag(process.env.PIT_ASYNC_REINJECT)) return false;
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: buildAsyncDeliveryBody(handle, status, text) }],
			timestamp: Date.now(),
		};
		if (this.isBusy) {
			this.agent.followUp(message);
			return true;
		}
		// Idle: spawn a turn. If a user prompt wins the race and a run is already
		// active by the time this lands, _runAgentPrompt rejects — fall back to a
		// follow-up so the result still rides (and is consumed by) that now-active
		// run instead of being dropped as a passive message.
		this._runAgentPrompt(message).catch((err) => {
			if (this.isBusy) {
				this.agent.followUp(message);
				return;
			}
			recordDiagnostic({
				category: "error.isolated",
				level: "warn",
				source: "agent-session._deliverAsyncResult",
				context: { note: err instanceof Error ? err.message : String(err) },
			});
		});
		return true;
	}

	/**
	 * Resolve the command the verification gate/probe should run, in priority
	 * order: explicit user setting -> detected project check (scripts / local tsc)
	 * -> per-file syntax fallback over THIS turn's touched files. The last tier is
	 * what catches broken syntax in repos with no toolchain at all. Returns null
	 * when nothing is runnable (fail-open: gate/probe then no-op).
	 */
	private _resolveCheckCommand(settingsCommand: string | null): string | null {
		if (settingsCommand) return settingsCommand;
		const detected = detectCheckCommand(this._cwd);
		if (detected) return detected;
		return detectSyntaxFallbackCommand(this._cwd, Array.from(this._turnTouchedFilePaths));
	}

	private async _runVerificationGate(options?: PromptOptions): Promise<void> {
		if (this._inVerification || !this._turnTouchedFiles) return;
		if (this._userInterrupted || this._lastTurnAborted()) return;
		const settings = this.settingsManager.getVerificationSettings();
		const maxAttempts = this._recovery.getEffectiveVerificationMaxAttempts(settings.maxAttempts);

		this._inVerification = true;
		const abort = new AbortController();
		this._verificationAbort = abort;
		try {
			// Check phase (visual nudge + project check + fix loop). Skipped entirely
			// when verification is disabled — but the self-review below still runs,
			// since P4 is independent of any check command (study §8, decision 6).
			let fixesUsed = 0;
			if (settings.enabled) {
				const phase = await this._runVerificationCheckPhase(settings, maxAttempts, abort, options);
				fixesUsed = phase.fixesUsed;
				// A still-red check that spent the budget, or an abort, ends the turn
				// here: the review shares that spent budget, and a broken check dominates.
				if (phase.status === "exhausted" || phase.status === "aborted") return;
			}
			if (this._userInterrupted || abort.signal.aborted) return;
			// Self-review phase (P4): runs on a high-risk diff regardless of whether a
			// check exists, SHARING the verification attempts budget so combined
			// verification + review fixes never exceed maxAttempts.
			await this._runSelfReviewPhase(maxAttempts, fixesUsed, abort, options);
		} finally {
			this._inVerification = false;
			this._verificationAbort = undefined;
		}
	}

	/**
	 * Verification check phase: visual nudge, native functional web DoD, then the
	 * project check + fix loop. Extracted from `_runVerificationGate` so the
	 * self-review phase can run afterward while SHARING the same fix budget.
	 * Returns how many fixes it consumed and a status: `passed` (green),
	 * `exhausted` (still red, budget spent), `aborted`, or `inert` (no check
	 * command and no functional-web failure). Only `passed`/`inert` let the
	 * review proceed.
	 */
	private async _runVerificationCheckPhase(
		settings: ReturnType<SettingsManager["getVerificationSettings"]>,
		maxAttempts: number,
		abort: AbortController,
		options?: PromptOptions,
	): Promise<{ fixesUsed: number; status: "passed" | "exhausted" | "aborted" | "inert" }> {
		// Visual definition-of-done: a rendered artifact changed but was never
		// viewed this turn — nudge the agent to render and review it (once).
		if (settings.visual && this._turnTouchedVisual && !this._turnUsedPreview && this._lastVisualFile) {
			this.emit({ type: "visual_review", file: this._lastVisualFile });
			await this._promptOnce(visualNudgePrompt(this._lastVisualFile), {
				expandPromptTemplates: false,
				source: options?.source,
			});
			if (abort.signal.aborted) return { fixesUsed: 0, status: "aborted" };
		}

		let fixes = 0;

		// Native functional web DoD (navigate / a11y / click / fill / console).
		// Shares maxAttempts with the project check + self-review below.
		if (settings.functionalWeb) {
			const fw = await this._runFunctionalWebPhase(settings, maxAttempts, fixes, abort, options);
			fixes = fw.fixesUsed;
			if (fw.status === "aborted") return { fixesUsed: fixes, status: "aborted" };
			if (fw.status === "exhausted") return { fixesUsed: fixes, status: "exhausted" };
		}

		// Code check: run the project's check and re-inject failures to fix.
		let command = this._resolveCheckCommand(settings.command);
		if (!command) return { fixesUsed: fixes, status: fixes > 0 ? "passed" : "inert" };
		for (let attempt = 1; ; attempt++) {
			// Re-resolve on each retry so the syntax-fallback tier picks up files the
			// model edited WHILE fixing: that tier embeds the touched-file list, so a
			// command frozen at gate entry would skip newly-touched files and pass a
			// turn that still has a syntax error. The script/tsc tiers are
			// touched-file independent and re-resolve to the same string; keep the
			// last good command if a retry resolves to null.
			if (attempt > 1) command = this._resolveCheckCommand(settings.command) ?? command;
			this._verificationAttemptsTotal += 1;
			this.emit({ type: "verification", phase: "running", command, attempt, maxAttempts });
			const result = await runCheckCommand(command, this._cwd, {
				signal: abort.signal,
				timeoutMs: settings.timeoutMs,
			});
			if (abort.signal.aborted) return { fixesUsed: fixes, status: "aborted" };
			if (result.ok) {
				this.emit({ type: "verification", phase: "passed", command, attempt, maxAttempts });
				this._recovery.noteCleanTool();
				// Band P contract expiry: three consecutive passes without a constraint
				// re-firing retire it (the TODO(band-p integration) line session-contract
				// exports for exactly this spot — the only place a real PASS is observed).
				getCurrentSessionContract()?.noteVerificationPass();
				// Debug-driven verify (additive, fail-open): on green, if a file this
				// turn touched is a debuggable repro (pytest+debugpy / go test+dlv),
				// launch it under the native DAP debugger and capture runtime state. A
				// "suspect" verdict (a fixed variable still nullish at the fix site) is
				// re-injected as context for the next turn. ANY failure / missing
				// adapter / non-applicable repro → no-op (NEVER blocks the green gate).
				if (!this._userInterrupted && !abort.signal.aborted && this._turnTouchedFilePaths.size > 0) {
					try {
						const snapshot = await maybeRunDebugVerify({
							cwd: this._cwd,
							touchedFiles: Array.from(this._turnTouchedFilePaths),
							checkResult: result,
							signal: abort.signal,
							fixSite: this._turnFixSite,
						});
						if (snapshot?.verdict === "suspect" && !abort.signal.aborted && !this._userInterrupted) {
							await this._promptOnce(debugVerifyContextPrompt(snapshot), {
								expandPromptTemplates: false,
								source: options?.source,
							});
						}
					} catch {
						// Fail-open absolute: debug-verify must never affect the passed result.
					}
				}
				return { fixesUsed: fixes, status: "passed" };
			}
			const willRetry = fixes < maxAttempts;
			this._verificationFailuresTotal += 1;
			this.emit({
				type: "verification",
				phase: "failed",
				command,
				attempt,
				maxAttempts,
				exitCode: result.exitCode,
				willRetry,
			});
			if (!willRetry) {
				// Fix budget exhausted with the check still red. Don't end the turn
				// silently — the model may have already claimed "done". Inject a single
				// TERMINAL message (NOT the fix prompt): tell it the check is still
				// failing and to summarize honestly instead of reporting success.
				// One-shot: no loop re-entry, `fixes` is not incremented.
				this._recovery.noteSignal("verification_exhausted");
				this._steering.maybeInjectNarrationSteer();
				await this._promptOnce(
					verificationExhaustedPrompt(command, result, fixes, this._lastAssistantClaimedCompletion()),
					{ expandPromptTemplates: false, source: options?.source },
				);
				return { fixesUsed: fixes, status: "exhausted" };
			}
			fixes++;
			await this._promptOnce(verificationFixPrompt(command, result), {
				expandPromptTemplates: false,
				source: options?.source,
			});
			if (abort.signal.aborted) return { fixesUsed: fixes, status: "aborted" };
		}
	}

	/**
	 * Native functional web DoD loop. Shares `fixesAlreadyUsed` / `maxAttempts`
	 * with the project check. Fail-open skips (no Chrome / not web / no URL) do
	 * not consume budget.
	 */
	private async _runFunctionalWebPhase(
		settings: ReturnType<SettingsManager["getVerificationSettings"]>,
		maxAttempts: number,
		fixesAlreadyUsed: number,
		abort: AbortController,
		options?: PromptOptions,
	): Promise<{ fixesUsed: number; status: "passed" | "exhausted" | "aborted" | "skipped" }> {
		// Tools surface may be off while the manager singleton still exists — treat
		// chromeDevtools.enabled:false as chrome_unavailable (fail-open skip).
		if (!this.settingsManager.getChromeDevtoolsSettings().enabled) {
			this.emit({
				type: "functional_web",
				phase: "skipped",
				attempt: 1,
				maxAttempts,
				reason: "chrome_unavailable",
			});
			return { fixesUsed: fixesAlreadyUsed, status: "skipped" };
		}

		let fixes = fixesAlreadyUsed;
		for (let attempt = 1; ; attempt++) {
			if (abort.signal.aborted || this._userInterrupted) {
				return { fixesUsed: fixes, status: "aborted" };
			}
			this.emit({
				type: "functional_web",
				phase: "running",
				attempt,
				maxAttempts,
			});
			const result = await runFunctionalWebCheck({
				cwd: this._cwd,
				mgr: getCurrentChromeDevtoolsManager(),
				lastVisualFile: this._lastVisualFile,
				touchedVisual: this._turnTouchedVisual,
				backgroundJobs: listBashBackgroundJobs(),
				maxInteractions: settings.functionalWebMaxInteractions,
				timeoutMs: settings.functionalWebTimeoutMs,
				signal: abort.signal,
			});
			if (abort.signal.aborted) return { fixesUsed: fixes, status: "aborted" };

			if (result.status === "skipped") {
				this.emit({
					type: "functional_web",
					phase: "skipped",
					url: result.url,
					attempt,
					maxAttempts,
					reason: result.reason,
				});
				return { fixesUsed: fixes, status: "skipped" };
			}

			if (result.status === "passed") {
				this._turnUsedPreview = true;
				this.emit({
					type: "functional_web",
					phase: "passed",
					url: result.url,
					attempt,
					maxAttempts,
				});
				return { fixesUsed: fixes, status: "passed" };
			}

			const willRetry = fixes < maxAttempts;
			this.emit({
				type: "functional_web",
				phase: "failed",
				url: result.url,
				attempt,
				maxAttempts,
				willRetry,
			});
			if (!willRetry) {
				this._recovery.noteSignal("verification_exhausted");
				await this._promptOnce(
					[
						functionalWebFixPrompt(result),
						"",
						`Fix budget exhausted after ${fixes} attempt(s). Summarize honestly — do NOT report the UI as verified.`,
					].join("\n"),
					{ expandPromptTemplates: false, source: options?.source },
				);
				return { fixesUsed: fixes, status: "exhausted" };
			}
			fixes++;
			await this._promptOnce(functionalWebFixPrompt(result), {
				expandPromptTemplates: false,
				source: options?.source,
			});
			if (abort.signal.aborted) return { fixesUsed: fixes, status: "aborted" };
		}
	}

	/**
	 * Self-review phase (Band P / P4). When this cycle's aggregate patch risk (or any
	 * single patch) is HIGH — or MEDIUM at the `assistido` thermostat level — spawn a
	 * read-only review subagent (mirroring fusion-verify), re-inject HIGH findings as
	 * a fix prompt sharing the verification budget, and re-review until they clear or
	 * the shared budget is spent. Unresolved HIGH findings stay registered so
	 * goal_complete (R9) refuses. Fail-open throughout; a no-op unless a real trigger
	 * fires (kill-switch `PIT_NO_SELF_REVIEW`, zero-mutation cycles skipped).
	 */
	private async _runSelfReviewPhase(
		maxAttempts: number,
		fixesAlreadyUsed: number,
		abort: AbortController,
		options?: PromptOptions,
	): Promise<void> {
		const totals = this._turnRisk.getTotals();
		const level = getCurrentSupervisionThermostat()?.getLevel();
		await runSelfReviewLoop({
			totals,
			level,
			runner: this._selfReviewRunner(abort),
			maxAttempts,
			fixesAlreadyUsed,
			injectFix: (prompt) => this._promptOnce(prompt, { expandPromptTemplates: false, source: options?.source }),
			isAborted: () => abort.signal.aborted || this._userInterrupted,
		});
	}

	/**
	 * Build the concrete review runner: one read-only `spawnSubagent` pass in the
	 * fusion-verify mould (read/grep/find/ls, maxTurns 6, strict SELF_REVIEW_SCHEMA).
	 * Throws on schema mismatch / timeout / abort — `runSelfReviewLoop` treats a throw
	 * as fail-open. Returns `{ findings: [] }` only when there is no usable model.
	 */
	private _selfReviewRunner(abort: AbortController): SelfReviewRunner {
		return async (args) => {
			const model = this.model;
			if (!model) return { findings: [] };
			const result = await spawnSubagent(
				{
					registry: new SubagentRegistry(),
					model,
					modelRegistry: this.modelRegistry,
					availableTools: this.agent.state.tools as AgentTool[],
					convertToLlm: (m) => m as never,
				},
				{
					prompt: args.prompt,
					systemPrompt: args.systemPrompt,
					allowedTools: ["read", "grep", "find", "ls"],
					resultSchema: SELF_REVIEW_SCHEMA,
					cwd: this._cwd,
					timeoutMs: SELF_REVIEW_TIMEOUT_MS,
					maxTurns: 6,
					thinkingLevel: "medium",
					signal: abort.signal,
				},
			);
			return (result.value as SelfReviewResult | undefined) ?? { findings: [] };
		};
	}

	/**
	 * Run the configured project check once (no fix loop, no events). Backs the
	 * verification probe so `goal_complete` can refuse while the check is red.
	 * Returns null when verification is disabled or no command can be detected.
	 */
	async runConfiguredCheck(signal?: AbortSignal): Promise<CheckResult | null> {
		const settings = this.settingsManager.getVerificationSettings();
		if (!settings.enabled) return null;
		const command = this._resolveCheckCommand(settings.command);
		if (!command) return null;
		return runCheckCommand(command, this._cwd, { signal, timeoutMs: settings.timeoutMs });
	}

	/** True when the most recent assistant message ended because the user aborted. */
	private _lastTurnAborted(): boolean {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i] as { role?: string; stopReason?: string };
			if (m.role === "assistant") return m.stopReason === "aborted";
		}
		return false;
	}

	/**
	 * Send a single prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	private async _promptOnce(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;

		try {
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.(true);
					return;
				}
			}

			// Fusion·Plan: route the turn to the panel+synthesizer unless it can't run (then fall through to solo).
			if (this._orchestration === "fusion" && !text.startsWith("/")) {
				const handled = await runFusionSessionTurn(this, text);
				if (handled) {
					preflightResult?.(true);
					return;
				}
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			// Merge any out-of-band attachments (clipboard paste etc.) into this turn,
			// then clear the buffer so they ride along exactly once.
			if (this._attachedImages.length > 0) {
				currentImages = currentImages ? [...currentImages, ...this._attachedImages] : [...this._attachedImages];
				this._attachedImages = [];
			}
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			if (!this._modelRegistry.hasConfiguredAuth(this.model)) {
				const isOAuth = this._modelRegistry.isUsingOAuth(this.model);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// Join any predictive background compaction started at the end of the
			// previous turn before we read/mutate session state. Instant if it
			// already finished during the user's read time.
			await awaitBackgroundCompaction(this.compaction);

			// Threshold/overflow compaction before send (presend wire guard runs later,
			// after the pending user message is assembled — B2).
			const lastAssistant = this._findLastAssistantMessage();
			if (
				lastAssistant &&
				(await checkCompaction(this.compaction, lastAssistant, false, false, { skipPresendGuard: true }))
			) {
				try {
					await this.agent.continue();
					while (await this._handlePostAgentRun()) {
						await this.agent.continue();
					}
				} finally {
					this._flushPendingBashMessages();
				}
			}

			// Band P: capture this turn's prompt and rebuild so the context-composer
			// block (dynamic suffix, cache-neutral) reflects the current request
			// before emitBeforeAgentStart hands the prompt to the provider. Fire a
			// background map refresh so subsequent turns see this turn's edits.
			if (!isContextComposerDisabled() && this._livingRepoMap) {
				if (expandedText !== this._composerPromptText) {
					this._composerPromptText = expandedText;
					try {
						this._baseSystemPrompt = this._rebuildSystemPrompt(
							this.getActiveToolNames(),
							"context-composer-turn",
						);
					} catch {
						// Non-fatal: the block simply lags this turn.
					}
				}
				void this._refreshLivingRepoMap();
			}

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						content: msg.content,
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply extension-modified system prompt, or reset to base
			if (result?.systemPrompt) {
				this.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}
			// Inject the autonomous-goal persistence section (per-turn, dynamic so
			// it tracks pause/clear/complete without a full system-prompt rebuild).
			const goalSection = this._goal.systemPromptSection();
			if (goalSection) {
				this.agent.state.systemPrompt = `${this.agent.state.systemPrompt}\n\n${goalSection}`;
			}
			const todoSection = this._todo.systemPromptSection();
			if (todoSection) {
				this.agent.state.systemPrompt = `${this.agent.state.systemPrompt}\n\n${todoSection}`;
			}
			const planSection = this._plan.systemPromptSection();
			if (planSection) {
				this.agent.state.systemPrompt = `${this.agent.state.systemPrompt}\n\n${planSection}`;
			}

			// Pre-send overflow guard with full wire estimate (messages + prefix + pending user).
			if (
				lastAssistant &&
				(await checkPresendOverflow(this.compaction, lastAssistant, {
					systemPrompt: this.agent.state.systemPrompt,
					tools: this._wireToolsForEstimate(),
					pendingMessages: messages,
				}))
			) {
				try {
					await this.agent.continue();
					while (await this._handlePostAgentRun()) {
						await this.agent.continue();
					}
				} finally {
					this._flushPendingBashMessages();
				}
			}
		} catch (error) {
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}

		// Esc during preflight (compaction / before_agent_start / presend) must not
		// start the provider run — interrupt() already aborted the signal, but the
		// async _promptOnce path can still reach here.
		if (this._userInterrupted || this.agent.signal?.aborted) {
			preflightResult?.(false);
			return;
		}

		preflightResult?.(true);
		await this._runAgentPrompt(messages);
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands to their full content. Skills are invoked as `/name`
	 * (Claude Code parity); the legacy `/skill:name` form is still accepted.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/")) return text;

		const spaceIndex = text.indexOf(" ");
		const rawName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		// Accept both the bare `/name` form and the legacy `/skill:name` prefix.
		const skillName = rawName.startsWith("skill:") ? rawName.slice(6) : rawName;
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkillByName(skillName);
		if (!skill) return text; // Not a skill — pass through (template / plain prompt)

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			// If the skill body references argument placeholders ($1, $@,
			// $ARGUMENTS, ${@:N}), substitute them in place — matching the
			// Claude Code / prompt-template contract. Only then; a body without
			// placeholders keeps the legacy behavior of appending the raw args
			// after the block, so existing placeholder-free skills are unchanged.
			const hasPlaceholder = /\$(?:\d+|@|ARGUMENTS|\{@:)/.test(body);
			const expandedBody = hasPlaceholder ? substituteArgs(body, parseCommandArgs(args)) : body;
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${expandedBody}\n</skill>`;
			return args && !hasPlaceholder ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
			/** Prepend to the steering queue so this steer drains before older ones. */
			steerPriority?: boolean;
		},
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else if (options?.steerPriority) {
				// Critical recovery steers must land in the live transcript immediately —
				// the default one-at-a-time steering queue can starve them behind softer
				// reminders when session recovery adds extra steers in the same turn.
				this.agent.state.messages.push(appMessage);
				this.sessionManager.appendCustomMessageEntry(
					message.customType,
					message.content,
					message.display,
					message.details,
				);
				this.emit({ type: "message_start", message: appMessage });
				this.emit({ type: "message_end", message: appMessage });
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this._runAgentPrompt(appMessage);
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this.emit({ type: "message_start", message: appMessage });
			this.emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		this.agent.abort();
		await this.agent.waitForIdle();
	}

	/**
	 * True when the agent or any orchestration loop is actively working. Used by
	 * the Esc handler to decide whether a keypress should interrupt the task vs.
	 * fall through to editor/double-Esc behavior.
	 */
	get isBusy(): boolean {
		return (
			this.isStreaming ||
			this.isBashRunning ||
			this._inGoalContinuation ||
			this._inVerification ||
			this._inPendingChecksDrain ||
			this.isFusing
		);
	}

	/**
	 * True while a Fusion turn (panel fan-out + judge + writer) is in flight. Folded into
	 * isBusy so the Esc handler routes a keypress to interrupt() (which calls abortFusion())
	 * instead of falling through to editor/double-Esc behavior — the Fusion turn returns
	 * before agent.run(), so without this it would not count as "busy".
	 */
	get isFusing(): boolean {
		return this._fusionAbort !== undefined;
	}

	/**
	 * User-initiated interrupt (Esc): cancel the ENTIRE active task, not just the
	 * current turn. Aborts the running agent turn, retry backoff, in-flight bash,
	 * compaction/branch-summary, and the verification gate, then raises a one-shot
	 * flag so the goal auto-continuation loop and the verification gate stop
	 * re-dispatching the agent. Synchronous (no waitForIdle) so the keypress feels
	 * instant. The flag is cleared when the next user prompt starts.
	 */
	interrupt(): void {
		this._userInterrupted = true;
		this.abortRetry();
		this._pendingChecksAbort?.abort();
		this._verificationAbort?.abort();
		this.abortBash();
		this.abortCompaction();
		this.abortBranchSummary();
		this.abortFusion();
		this.agent.abort();
	}

	/**
	 * Cancel a single in-flight tool by its tool-call id WITHOUT interrupting the
	 * whole task (unlike interrupt()). The tool sees an aborted signal — combined
	 * with the run signal in the loop — and the run continues with the remaining
	 * tools. Returns true if a live per-tool controller matched.
	 */
	cancelTool(toolCallId: string): boolean {
		return this.agent.cancelTool(toolCallId);
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		// Warm the new provider module off the hot path (P06). Covers set/cycle/fallback.
		prewarmProviderModule(nextModel.api);
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>): Promise<void> {
		if (!this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const scopedModels = this._scopedModels.filter((scoped) => this._modelRegistry.hasConfiguredAuth(scoped.model));
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		const currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		const len = scopedModels.length;
		let nextIndex: number;
		if (currentIndex === -1) {
			nextIndex = direction === "forward" ? 0 : len - 1;
		} else {
			nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		}
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		// Apply model
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply thinking level.
		// - Explicit scoped model thinking level overrides current session level
		// - Undefined scoped model thinking level inherits the current session preference
		// setThinkingLevel clamps to model capabilities.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		const currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		const len = availableModels.length;
		let nextIndex: number;
		if (currentIndex === -1) {
			nextIndex = direction === "forward" ? 0 : len - 1;
		} else {
			nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		}
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this.emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	get orchestration(): Orchestration {
		return this._orchestration;
	}

	setOrchestration(orchestration: Orchestration): void {
		if (orchestration === this._orchestration) return;
		this._orchestration = orchestration;
		this._persistOrchestration();
		this.emit({ type: "orchestration_changed", orchestration });
	}

	private _persistOrchestration(): void {
		try {
			this.sessionManager.appendCustomEntry("orchestration", { orchestration: this._orchestration });
		} catch {
			// Persistence is best-effort; a write failure must not break the session.
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		return compactSession(this.compaction, customInstructions);
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this.compaction.compactionAbortController?.abort();
		this.compaction.autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Cancel an in-flight Fusion turn (panel subprocesses + judge/writer LLM calls).
	 * The signal is wired into runPanelMember (taskkill on win32) and the judge/writer
	 * completeSimple calls, so this reaps the whole fan-out.
	 */
	abortFusion(): void {
		this._fusionAbort?.abort();
	}

	/**
	 * Emit an actionable, display-only note when the goal auto-continuation safety
	 * cap is hit. The goal is paused (not failed); this tells the user how to
	 * continue and how to raise the cap. Display-only: it renders in the
	 * transcript but is never fed into the model's context (same pattern as
	 * `_emitFusionNote`), and a render failure must not break the paused goal.
	 */
	private _emitGoalCapNote(maxIterations: number): void {
		const line = {
			role: "custom" as const,
			customType: "pit.goal-cap",
			content:
				`Goal paused after ${maxIterations} auto-continuations — ` +
				"/goal resume to continue, or raise goal.maxAutoIterations.",
			display: true,
			timestamp: Date.now(),
		};
		try {
			this.emit({ type: "message_start", message: line });
			this.emit({ type: "message_end", message: line });
		} catch {
			// note render failure is non-fatal
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		// Extensions (notably MCP deferral) may have just registered hidden tools
		// into the discovery index — AFTER the constructor's initial snapshot. Re-
		// snapshot so the search_tool_bm25 nudge reflects them from the first
		// request, even when the deferred MCP tools are the ONLY hidden ones.
		this._resyncHiddenToolSnapshot();
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames(), "extensions-reload");
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRegistry.find(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					this.sessionManager.appendCustomEntry(customType, data);
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this.modelRegistry.hasConfiguredAuth(model)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
				getOrchestration: () => this.orchestration,
				setOrchestration: (o) => this.setOrchestration(o),
			},
			{
				getModel: () => this.model,
				isIdle: () => !this.isStreaming,
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
			},
			{
				registerProvider: (name, config) => {
					this._modelRegistry.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRegistry.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const isAllowedTool = (name: string): boolean => !allowedToolNames || allowedToolNames.has(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const builtinEntries = Array.from(this._baseToolDefinitions.entries())
			.filter(([name]) => isAllowedTool(name))
			.map(([name, definition]) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
			}));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			builtinEntries.map((entry) => [entry.definition.name, entry]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		const nextSnippets = new Map<string, string>();
		const nextGuidelines = new Map<string, string[]>();
		for (const { definition } of definitionRegistry.values()) {
			const snippet = this._normalizePromptSnippet(definition.promptSnippet);
			if (snippet) nextSnippets.set(definition.name, snippet);
			const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
			if (guidelines.length > 0) nextGuidelines.set(definition.name, guidelines);
		}
		this._toolPromptSnippets = nextSnippets;
		this._toolPromptGuidelines = nextGuidelines;
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(builtinEntries, runner);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	/**
	 * Build the harness-routed dispatcher for code-mode. Each `tools.x()` call from
	 * a code-mode program runs through the SAME pipeline as a normal model tool call
	 * (rewrite → permission/extension hooks → execute → error-hints → afterToolCall),
	 * reconstructed from the agent's harness primitives because the per-tool executor
	 * is private to the agent loop. The before/after hooks are read dynamically (the
	 * session reassigns them after construction). Loop detectors (doom-loop /
	 * repeating-pattern) are intentionally NOT applied here: a deterministic program
	 * iterating over N files is not model flailing, and tripping the loop guard would
	 * defeat code-mode's purpose. Gate-arming IS preserved so a code-mode write still
	 * arms the verification gate, exactly like a normal mutating tool call.
	 */
	private _buildCodeModeDispatcher(): CodeModeDispatcher {
		const base = buildHarnessDispatcher({
			getTool: (name) => this._toolRegistry.get(name),
			toolRewriteRegistry: this.agent.toolRewriteRegistry,
			toolErrorHintRegistry: this.agent.toolErrorHintRegistry,
			beforeToolCall: (ctx, signal) =>
				this.agent.beforeToolCall ? this.agent.beforeToolCall(ctx, signal) : Promise.resolve(undefined),
			afterToolCall: (ctx, signal) =>
				this.agent.afterToolCall ? this.agent.afterToolCall(ctx, signal) : Promise.resolve(undefined),
			getContext: () => this.agent.state,
			// The agent message that requested the `code` call. Handlers only read
			// toolCall/args, so this is informational; it is always set when a tool runs.
			getAssistantMessage: () => this._lastAssistantMessage as AssistantMessage,
			emitEvent: (e) => this._emitCodeModeEvent(e),
		});
		return async (name, args, signal) => {
			const result = await base(name, args, signal);
			if (!result.isError) {
				armVerificationGate(this._verificationGate, name, args, { trackPaths: false });
			}
			return result;
		};
	}

	/**
	 * Observability-only sink for code-mode inner tool calls (the `tools.x()` a
	 * code program runs): surfaces each in extension events + the TUI like a normal
	 * tool call, so they are no longer invisible. Deliberately does NOT re-run the
	 * per-turn handlers (doom-loop / failure-budget / fix-site tracking): those
	 * would double-count or spuriously abort a multi-call code-mode program, and
	 * permission/rewrite/learned-error already run inline in the dispatcher.
	 * Never throws into code-mode execution.
	 */
	private _emitCodeModeEvent = async (
		event: Extract<AgentEvent, { type: "tool_execution_start" | "tool_execution_end" }>,
	): Promise<void> => {
		try {
			await this._emitExtensionEvent(event);
			this.emit(event);
		} catch {
			// Observability must never break code-mode execution.
		}
	};

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: {
						autoResizeImages,
						embedHashlineAnchors: () =>
							!this._disableHashlineAnchors && this.getActiveToolNames().includes("edit_v2"),
						readDedupeStore: this._readDedupeStore,
						mtimeStore: this._fileMtimeStore,
					},
					edit: { mtimeStore: this._fileMtimeStore },
					edit_v2: { mtimeStore: this._fileMtimeStore },
					write: { mtimeStore: this._fileMtimeStore },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
					grep: { engine: this.settingsManager.getGrepSettings().engine },
					find: {
						engine: this.settingsManager.getGrepSettings().engine === "fff" ? "fff" : "fd",
					},
					ast_grep: { engine: this.settingsManager.getAstGrepSettings().engine },
					// Code-mode: inject the harness-routed dispatcher so a code-mode
					// program's `tools.x()` calls pass through the same pipeline as a
					// normal model tool call (anti-bypass). See _buildCodeModeDispatcher.
					code: {
						dispatcher: this._buildCodeModeDispatcher(),
						getActiveToolNames: () => this.getActiveToolNames(),
					},
					search_skills: {
						getSkills: () => this._resourceLoader.getSkills().skills,
					},
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			this._modelRegistry,
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		// Default active surface comes from the single source of truth,
		// `_defaultActiveToolNames()` (shared with the discovery seed so the two
		// never drift). The SDK no longer passes its own list: with no explicit
		// allowlist/noTools it sends `undefined`, so this default decides.
		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: this._defaultActiveToolNames();
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(): Promise<void> {
		const previousFlagValues = this._extensionRunner.getFlagValues();
		await emitSessionShutdownEvent(this._extensionRunner, { type: "session_shutdown", reason: "reload" });
		await this.settingsManager.reload();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		// Context overflow is handled by compaction, not retry
		const contextWindow = this.model?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;

		const err = message.errorMessage;
		// Match: overloaded_error, provider returned error, rate limit, 429, 500, 502, 503, 504, service unavailable, network/connection errors (including connection lost), WebSocket transport closes/errors, fetch failed, premature stream endings, HTTP/2 closed before response, terminated, retry delay exceeded
		return RETRYABLE_ERROR_RE.test(err);
	}

	/**
	 * Resolve the active fallback chain for the current turn. Returns
	 * `undefined` if no chain is configured. The chain is computed from
	 * `resolveRole({role: "default"})` lazily so that path-scoped overrides
	 * stay live (a cwd change between turns updates the chain).
	 */
	private _resolveFallbackChain(): RoleResolution | undefined {
		try {
			const roleSettings = this.settingsManager.getModelRoleSettings();
			if (!roleSettings.modelRoles?.default && !roleSettings.retry?.fallbackChains) {
				return undefined;
			}
			const availableModels = this._modelRegistry.getAll();
			return resolveRole({
				role: "default",
				availableModels,
				settings: roleSettings,
				cwd: this._cwd,
			});
		} catch {
			return undefined;
		}
	}

	/**
	 * Pick the next untried entry in the fallback chain. Skips the current
	 * model (it just failed) and entries already tried this turn.
	 */
	private _pickNextFallbackEntry(
		resolution: RoleResolution,
	): { model: Model<any>; thinkingLevel: ThinkingLevel } | undefined {
		const current = this.model;
		const currentKey = current ? `${current.provider}/${current.id}` : "";
		// Mark the current entry as tried so we never re-pick it.
		if (currentKey) this._triedFallbackEntries.add(currentKey);
		for (const entry of resolution.chain) {
			const key = `${entry.model.provider}/${entry.model.id}`;
			if (this._triedFallbackEntries.has(key)) continue;
			// Skip entries lacking configured auth — they would error immediately.
			if (!this._modelRegistry.hasConfiguredAuth(entry.model)) {
				this._triedFallbackEntries.add(key);
				continue;
			}
			// Cross-turn cooldown: if this entry recently ate a retryable failure
			// (typically a 429), keep skipping it until its cooldown expires.
			if (isEntryCooledDown(entry.model.provider, entry.model.id)) continue;
			return entry;
		}
		return undefined;
	}

	/**
	 * Swap the active model to a fallback chain entry. Mirrors `setModel`
	 * minus the validation / persistence side-effects (no settings write,
	 * no model_select event source="set"). The original model is captured
	 * so a future caller could revert; for now the chain is one-way per
	 * turn — restoration happens automatically on the next successful turn
	 * when the user/runtime re-resolves the role.
	 */
	private async _activateFallbackEntry(
		entry: { model: Model<any>; thinkingLevel: ThinkingLevel },
		reason?: string,
	): Promise<void> {
		const previousModel = this.model;
		if (!this._fallbackOriginal && previousModel) {
			this._fallbackOriginal = { model: previousModel, thinkingLevel: this.thinkingLevel };
		}
		if (previousModel) {
			this.emit({
				type: "fallback_warning",
				from: `${previousModel.provider}/${previousModel.id}`,
				to: `${entry.model.provider}/${entry.model.id}`,
				reason: reason ?? "retryable error",
			});
		}
		this.agent.state.model = entry.model;
		// Clamp thinking level to the new model's capabilities — same logic as
		// `setModel`. We avoid `setThinkingLevel` because that calls into the
		// settings manager; a transient fallback should not rewrite defaults.
		const supported = getSupportedThinkingLevels(entry.model);
		const desired = entry.thinkingLevel;
		const clamped = supported.includes(desired) ? desired : clampThinkingLevel(entry.model, desired);
		this.agent.state.thinkingLevel = clamped as ThinkingLevel;
		this.sessionManager.appendModelChange(entry.model.provider, entry.model.id);
		await this._emitModelSelect(entry.model, previousModel, "set");
	}

	/**
	 * Restore the primary model captured before a transient fallback. A fallback
	 * (e.g. after a 429) is meant to be temporary; once the turn settles we revert
	 * to the original model + thinking level instead of leaving the session
	 * degraded for every subsequent turn. No-op when no fallback is active or when
	 * the current model already matches the captured primary.
	 */
	private async _restoreFallbackModelIfActive(): Promise<void> {
		// Run boundary: forget which chain entries were tried so the next prompt
		// restarts the walk from the primary. Done unconditionally (even when no
		// fallback was active) so a run that EXHAUSTED the chain and ended in error
		// does not leave every entry permanently marked tried — which would make
		// _pickNextFallbackEntry return undefined next turn and strand the agent on
		// the dead model. Per-entry cooldown (isEntryCooledDown) remains the only
		// cross-run memory for "do not immediately re-pick this hot entry".
		this._triedFallbackEntries.clear();
		const original = this._fallbackOriginal;
		this._fallbackOriginal = undefined;
		if (!original) return;
		const current = this.model;
		if (current && current.provider === original.model.provider && current.id === original.model.id) {
			return;
		}
		this.agent.state.model = original.model;
		const supported = getSupportedThinkingLevels(original.model);
		const desired = original.thinkingLevel;
		const clamped = supported.includes(desired) ? desired : clampThinkingLevel(original.model, desired);
		this.agent.state.thinkingLevel = clamped as ThinkingLevel;
		this.sessionManager.appendModelChange(original.model.provider, original.model.id);
		await this._emitModelSelect(original.model, current, "set");
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 *
	 * When a fallback chain is configured for the active role, the chain is
	 * walked first: each retryable error swaps the active model to the next
	 * untried chain entry with NO backoff sleep (rate-limit cooldowns belong
	 * to the failed entry, not the chain switch). Once the chain is
	 * exhausted, falls through to legacy exponential-backoff retry on the
	 * (now last-tried) model.
	 *
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	/**
	 * Adaptive idle-timeout backoff for the NEXT stream attempt. An idle-timeout
	 * failure means the body stalled for the entire idle window; a consistently
	 * slow provider would otherwise re-fire the same window on every retry. Scale
	 * the forwarded idle window ×1.5 per consecutive idle-timeout retry (capped at
	 * IDLE_BACKOFF_MAX_MS) so the retried stream inherits more room each time. Any
	 * non-idle retryable error breaks the streak and restores the default window.
	 * Called only once a retry is committed.
	 */
	private _applyIdleTimeoutBackoff(message: AssistantMessage): void {
		if (!IDLE_TIMEOUT_ERROR_RE.test(message.errorMessage ?? "")) {
			this._idleTimeoutRetryCount = 0;
			this.agent.idleTimeoutMs = undefined;
			return;
		}
		this._idleTimeoutRetryCount++;
		const configured = this.settingsManager.getProviderRetrySettings().idleTimeoutMs;
		const base = typeof configured === "number" && configured > 0 ? configured : DEFAULT_IDLE_TIMEOUT_MS;
		const scaled = base * IDLE_BACKOFF_FACTOR ** this._idleTimeoutRetryCount;
		this.agent.idleTimeoutMs = Math.round(Math.min(scaled, IDLE_BACKOFF_MAX_MS));
	}

	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		// Attempt fallback-chain transition first. Successful transitions
		// still count as a retry attempt so a misconfigured chain cannot
		// loop forever.
		const resolution = this._resolveFallbackChain();
		const nextEntry = resolution ? this._pickNextFallbackEntry(resolution) : undefined;
		if (nextEntry) {
			this._retryAttempt++;
			if (this._retryAttempt > settings.maxRetries) {
				this._retryAttempt--;
				return false;
			}
			const previous = this.model;
			const reason = sliceSafe(message.errorMessage ?? "", 0, 80);
			this.emit({
				type: "auto_retry_start",
				attempt: this._retryAttempt,
				maxAttempts: settings.maxRetries,
				delayMs: 0,
				errorMessage: message.errorMessage || "Unknown error",
			});
			// Mark the failing entry on the cross-turn cooldown so a future turn
			// won't immediately re-pick it. Tuned to the role's configured
			// cooldown (defaults to 5 min in withFallbackChain).
			if (previous) {
				const retryCfg = (this.settingsManager.getModelRoleSettings().retry ?? {}) as {
					cooldownMs?: number;
				};
				const cooldownMs = typeof retryCfg.cooldownMs === "number" ? retryCfg.cooldownMs : 300_000;
				markEntryCooldown(previous.provider, previous.id, cooldownMs);
			}
			// Drop the error message before swap so the next turn isn't poisoned.
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			await this._activateFallbackEntry(nextEntry, reason);
			this._applyIdleTimeoutBackoff(message);
			return true;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		// Jitter the exponential backoff to avoid a thundering-herd retry storm
		// against the provider when many sessions fail at once.
		const cappedBackoff = Math.min(settings.baseDelayMs * 2 ** (this._retryAttempt - 1), RETRY_MAX_DELAY_MS);
		const delayMs = cappedBackoff * (0.5 + Math.random());

		this.emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this.emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		this._applyIdleTimeoutBackoff(message);
		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations },
	): Promise<BashResult> {
		this._bashAbortController = new AbortController();

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk,
					signal: this._bashAbortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortController = undefined;
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this._bashAbortController?.abort();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortController !== undefined;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		this.emit({ type: "session_info_changed", name: this.sessionManager.getSessionName() });
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed (skip tiny abandoned paths — C6).
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			if (options.summarize && entriesToSummarize.length >= BRANCH_SUMMARY_MIN_ENTRIES && !extensionSummary) {
				const sessionModel = this.model!;
				const sessionAuth = await this._getRequiredRequestAuth(sessionModel);
				const compact = await resolveCompactModel(
					this.compaction,
					sessionModel,
					{ apiKey: sessionAuth.apiKey, headers: sessionAuth.headers },
					this.thinkingLevel,
				);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const compactionSettings = this.settingsManager.getCompactionSettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model: compact.model,
					apiKey: compact.apiKey ?? sessionAuth.apiKey,
					headers: compact.headers ?? sessionAuth.headers,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					cwd: this.sessionManager.getCwd(),
					selfCorrection: compactionSettings.selfCorrection,
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				const branchDetails: {
					readFiles: string[];
					modifiedFiles: string[];
					searches?: string[];
					shellCmds?: string[];
					mcpCalls?: string[];
				} = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
				if (result.searches && result.searches.length > 0) branchDetails.searches = result.searches;
				if (result.shellCmds && result.shellCmds.length > 0) branchDetails.shellCmds = result.shellCmds;
				if (result.mcpCalls && result.mcpCalls.length > 0) branchDetails.mcpCalls = result.mcpCalls;
				summaryDetails = branchDetails;
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = this._extractUserMessageText(targetEntry.message.content);
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this._extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * Get session statistics.
	 */
	getSessionStats(): SessionStats {
		const state = this.state;
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of state.messages) {
			switch (message.role) {
				case "user":
					userMessages++;
					break;
				case "assistant": {
					assistantMessages++;
					const assistantMsg = message as AssistantMessage;
					for (const c of assistantMsg.content) {
						if (c.type === "toolCall") toolCalls++;
					}
					totalInput += assistantMsg.usage.input;
					totalOutput += assistantMsg.usage.output;
					totalCacheRead += assistantMsg.usage.cacheRead;
					totalCacheWrite += assistantMsg.usage.cacheWrite;
					totalCost += assistantMsg.usage.cost.total;
					break;
				}
				case "toolResult":
					toolResults++;
					break;
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			contextUsage: this.getContextUsage(),
		};
	}

	/**
	 * Prompt-cache statistics derived from per-message usage (hit-rate per turn plus
	 * a prefix-stability diagnosis). Provider-agnostic; see {@link computeCacheStats}.
	 */
	getCacheStats(): CacheStats {
		return computeCacheStats(this.state.messages);
	}

	/**
	 * Fixed-cost surface for the most recent request: system prompt size broken into
	 * cache-stable (static) and per-turn (dynamic) portions, plus tool schema tokens
	 * on the wire. Values are structural estimates (chars/4 for prose, JSON chars/3.3
	 * for schemas) — they do NOT come from provider-reported usage, but they stay
	 * consistent regardless of which usage anchor is active.
	 * Returns null before the first LLM request (system prompt / tools may be
	 * partially initialised; estimates would not be meaningful to display).
	 */
	getFixedCostSurface(): {
		staticSystemTokens: number;
		dynamicSystemTokens: number;
		systemTokens: number;
		toolTokens: number;
	} | null {
		// Only meaningful once the session has received at least one LLM response.
		const hasRequest = this.messages.some((m) => m.role === "assistant");
		if (!hasRequest) return null;
		const prompt = this.agent.state.systemPrompt;
		const { staticPart, dynamicPart } = splitSystemPromptOnDynamic(prompt);
		const PROSE = 4; // chars-per-token for prose — mirrors compaction.ts CHARS_PER_TOKEN_PROSE
		const staticSystemTokens = Math.ceil(staticPart.length / PROSE);
		const dynamicSystemTokens = Math.ceil(dynamicPart.length / PROSE);
		const wire = estimateWireTokens(this.messages, {
			systemPromptChars: prompt.length,
			tools: this._wireToolsForEstimate(),
		});
		return { staticSystemTokens, dynamicSystemTokens, systemTokens: wire.systemTokens, toolTokens: wire.toolTokens };
	}

	private _ctxUsageCache?: { key: string; value: ContextUsage | undefined };
	private _ctxPruneCache?: { key: string; value: AgentMessage[] };

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// Footer.render() calls this every TUI frame; getBranch()/estimateContextTokens below
		// are O(n) walks. Memoize on a key that changes exactly when context can change: leaf
		// id (append/compaction/branch switch), message count, and the active context window.
		const key = `${this.sessionManager.getLeafId()}:${this.messages.length}:${contextWindow}:${this.agent.state.systemPrompt.length}:${this.agent.state.tools.length}`;
		const cached = this._ctxUsageCache;
		if (cached && cached.key === key) return cached.value;
		const value = this.applyBudgetFields(this.computeContextUsage(contextWindow));
		this._ctxUsageCache = { key, value };
		return value;
	}

	private applyBudgetFields(usage: ContextUsage | undefined): ContextUsage | undefined {
		if (!usage) return undefined;
		const snap = this._tokenGovernor.snapshot();
		if (snap.budgetLimit === undefined && snap.subagentTokens === 0 && snap.fusionTokens === 0) {
			return usage;
		}
		return {
			...usage,
			budgetSpent: snap.totalSpent,
			budgetLimit: snap.budgetLimit,
			subagentSpent: snap.subagentTokens,
			fusionSpent: snap.fusionTokens,
		};
	}

	private computeContextUsage(contextWindow: number): ContextUsage | undefined {
		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
						}
						break;
					}
				}
			}

			if (!hasPostCompactionUsage) {
				// No provider-confirmed size yet for the freshly reduced context. Rather than
				// showing "?", give an immediate STRUCTURAL estimate over the (already compacted)
				// messages so the drop is visible at once — and bypass estimateContextTokens here,
				// which would otherwise latch onto a kept message's stale pre-compaction usage and
				// report the OLD (large) size. The next assistant response replaces this estimate
				// with the exact provider figure (estimated:false).
				let estimated = 0;
				for (const message of this.messages) estimated += estimateTokens(message);
				const wire = estimateWireTokens(this.messages, {
					systemPromptChars: this.agent.state.systemPrompt.length,
					tools: this._wireToolsForEstimate(),
				});
				return {
					tokens: estimated,
					wireTokens: wire.tokens,
					contextWindow,
					percent: (wire.tokens / contextWindow) * 100,
					estimated: true,
				};
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const wire = estimateWireTokens(this.messages, {
			systemPromptChars: this.agent.state.systemPrompt.length,
			tools: this._wireToolsForEstimate(),
		});
		const headline = wire.tokens;

		return {
			tokens: estimate.tokens,
			wireTokens: wire.tokens,
			contextWindow,
			percent: (headline / contextWindow) * 100,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const themeName = this.settingsManager.getTheme();

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolve(outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		let lastAssistant: AgentMessage | undefined;
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const m = this.messages[i];
			if (m.role !== "assistant") continue;
			const msg = m as AssistantMessage;
			// Skip aborted messages with no content
			if (msg.stopReason === "aborted" && msg.content.length === 0) continue;
			lastAssistant = m;
			break;
		}

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
