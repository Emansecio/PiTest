/**
 * Compaction pipeline extracted from AgentSession (move-only).
 */

import { statSync } from "node:fs";
import type { Agent, AgentMessage, ThinkingLevel } from "@pit/agent-core";
import type { AssistantMessage, Model } from "@pit/ai";
import { isContextOverflow, recordDiagnostic, streamSimple } from "@pit/ai";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import type { AgentSessionEvent } from "./agent-session-events.ts";
import { formatNoModelSelectedMessage } from "./auth-guidance.ts";
import {
	adaptivePruneThreshold,
	type CompactionSettings,
	cloneToolResultMessagesForPrune,
	effectiveKeepRecentTokens,
	estimateCompactionFrameTokens,
	estimateTextTokens,
	estimateToolSurfaceTokens,
	estimateWireTokens,
	planContextPrune,
	pressurePruneProtectTurns,
	pruneOldToolOutputs,
	resolveThinkingHeadroom,
	type WireToolSurface,
	wouldPruneOldToolOutputs,
} from "./compaction/compaction.ts";
import {
	adaptiveKeepRecentTokens,
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	compact,
	computeDynamicReserve,
	estimateContextTokens,
	prepareCompaction,
	proactivePruneFloor,
	shouldCompact,
	sumMessageTokens,
} from "./compaction/index.ts";
import type { ExtensionRunner, SessionBeforeCompactResult } from "./extensions/index.js";
import type { HindsightBank } from "./hindsight/index.js";
import type { ModelRegistry } from "./model-registry.ts";
import { resolveCompactSibling, resolveRole } from "./model-resolver.ts";
import type { PinManager } from "./pins.ts";
import type { CompactionEntry, SessionEntry, SessionManager } from "./session-manager.js";
import { getLatestCompactionEntry } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import type { FileMtimeStore } from "./tools/file-mtime-store.ts";
import { canonicalPathKey, resolveReadPath } from "./tools/path-utils.ts";
import type { ReadDedupeStore } from "./tools/read.js";

/**
 * Whether `runAutoCompaction` should pay a second LLM summarization pass after
 * a successful threshold compaction (T08 / C5). Soft threshold alone must NOT
 * re-fire — that was a systematic false positive after adaptive keep.
 */
export function shouldRunCompactionSecondPass(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings,
): boolean {
	return shouldCompact(contextTokens, contextWindow, settings, 0);
}

/**
 * Fraction of the context window at which the presend overflow guard trips.
 * Override via PIT_PRESEND_OVERFLOW_RATIO; a numeric value is clamped into
 * [0.5, 0.99] (below 0.5 compacts far too eagerly; above 0.99 lets a real
 * overflow slip past the guard); a non-numeric value falls back to the default.
 * Parsed once at load.
 */
const DEFAULT_PRESEND_OVERFLOW_RATIO = 0.95;

export function parsePresendOverflowRatio(raw: string | undefined): number {
	if (raw === undefined || raw === "") return DEFAULT_PRESEND_OVERFLOW_RATIO;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_PRESEND_OVERFLOW_RATIO;
	return Math.min(0.99, Math.max(0.5, parsed));
}

const PRESEND_OVERFLOW_RATIO = parsePresendOverflowRatio(
	typeof process !== "undefined" ? process.env.PIT_PRESEND_OVERFLOW_RATIO : undefined,
);

/** Floor for dynamic tightening (T10); env baseRatio is the ceiling. */
const PRESEND_RATIO_FLOOR = 0.88;
const PRESEND_RATIO_OCC_START = 0.5;
const PRESEND_RATIO_OCC_FULL = 0.9;
const PRESEND_TRAILING_START = 0.1;
const PRESEND_TRAILING_FULL = 0.4;
const PRESEND_DENSITY_MAX_TIGHTEN = 0.03;

/**
 * Dynamic presend overflow ratio (T10). `baseRatio` (from env / default 0.95) is
 * the ceiling; occupancy 50%→90% and trailing tool-share tighten toward 0.88.
 * Opt-out: `PIT_NO_DYNAMIC_PRESEND_RATIO=1`.
 */
export function resolveDynamicPresendOverflowRatio(input: {
	baseRatio: number;
	pressure: number;
	contextWindow: number;
	trailingTokens: number;
	assembled: number;
}): number {
	const { baseRatio, pressure, contextWindow, trailingTokens, assembled } = input;
	if (isTruthyEnvFlag(process.env.PIT_NO_DYNAMIC_PRESEND_RATIO)) return baseRatio;
	const floor = Math.min(baseRatio, PRESEND_RATIO_FLOOR);
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return baseRatio;

	const occupancy = pressure / contextWindow;
	let occTighten = 0;
	if (occupancy > PRESEND_RATIO_OCC_START) {
		const t = Math.min(1, (occupancy - PRESEND_RATIO_OCC_START) / (PRESEND_RATIO_OCC_FULL - PRESEND_RATIO_OCC_START));
		occTighten = t * (baseRatio - floor);
	}

	const trailingShare = trailingTokens / Math.max(1, assembled);
	let densityTighten = 0;
	if (trailingShare > PRESEND_TRAILING_START) {
		const t = Math.min(
			1,
			(trailingShare - PRESEND_TRAILING_START) / (PRESEND_TRAILING_FULL - PRESEND_TRAILING_START),
		);
		densityTighten = t * PRESEND_DENSITY_MAX_TIGHTEN;
	}

	return Math.max(floor, baseRatio - occTighten - densityTighten);
}

/**
 * Fraction of the context window at which mid-turn (between tool rounds) wire
 * pressure triggers prune-only relief. Lower than PRESEND_OVERFLOW_RATIO so we
 * act earlier without running LLM compaction mid-stream.
 * Override via PIT_MID_TURN_PRESSURE_RATIO (clamped [0.5, 0.99]).
 */
const DEFAULT_MID_TURN_PRESSURE_RATIO = 0.92;

export function parseMidTurnPressureRatio(raw: string | undefined): number {
	if (raw === undefined || raw === "") return DEFAULT_MID_TURN_PRESSURE_RATIO;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_MID_TURN_PRESSURE_RATIO;
	return Math.min(0.99, Math.max(0.5, parsed));
}

const MID_TURN_PRESSURE_RATIO = parseMidTurnPressureRatio(
	typeof process !== "undefined" ? process.env.PIT_MID_TURN_PRESSURE_RATIO : undefined,
);

/**
 * Multiplier on the predictive soft band that gates BACKGROUND compaction.
 * `shouldCompactSoft` fires one `keepRecentTokens` window below the hard
 * threshold; this widens that band so the predictive path starts earlier — while
 * the user is still reading the just-finished turn — and the cheap sibling-model
 * summary is far more likely to be ready before the next send (avoiding a visible
 * synchronous compaction wait at the hard wall). 1.0 = identical to the legacy
 * soft band; >1.0 fires earlier. Override via PIT_COMPACT_SOFT_RATIO
 * (clamped [1.0, 4.0]); a non-numeric value falls back to the default. Parsed
 * once at load. The synchronous hard-threshold path is untouched (safety net).
 */
const DEFAULT_COMPACT_SOFT_RATIO = 1.5;

export function parseCompactSoftRatio(raw: string | undefined): number {
	if (raw === undefined || raw === "") return DEFAULT_COMPACT_SOFT_RATIO;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_COMPACT_SOFT_RATIO;
	return Math.min(4, Math.max(1, parsed));
}

const COMPACT_SOFT_RATIO = parseCompactSoftRatio(
	typeof process !== "undefined" ? process.env.PIT_COMPACT_SOFT_RATIO : undefined,
);

/**
 * Widened predictive soft trigger for the background compaction path. A superset
 * of `shouldCompactSoft` (equal at ratio 1.0): fires the same way but starting a
 * wider band below the hard threshold, so summarization runs during idle read
 * time. Like `shouldCompactSoft`, it yields to the synchronous hard path at/over
 * the hard threshold (returns false there) so the two never race the same window.
 */
export function shouldStartBackgroundCompaction(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings,
	ratio: number = COMPACT_SOFT_RATIO,
): boolean {
	if (!settings.enabled) return false;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;
	const reserve = computeDynamicReserve(contextWindow, settings.reserveTokens);
	const hardThreshold = contextWindow - reserve;
	if (contextTokens > hardThreshold) return false; // hard (synchronous) path owns this
	const band = effectiveKeepRecentTokens(settings.keepRecentTokens, contextWindow) * ratio;
	const softThreshold = hardThreshold - band;
	return softThreshold > 0 && contextTokens > softThreshold;
}

/** Stable session surface compaction reads; implemented by AgentSession. */
export interface CompactionHost {
	readonly sessionId: string;
	readonly model: Model<any> | undefined;
	readonly thinkingLevel: ThinkingLevel;
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly extensionRunner: ExtensionRunner;
	readonly modelRegistry: ModelRegistry;
	readonly hindsightBank: HindsightBank | undefined;
	readonly readDedupeStore: ReadDedupeStore | undefined;
	readonly fileMtimeStore?: FileMtimeStore | undefined;
	/** P5 /pin state. Optional so partial test-host mocks stay valid; the real session always provides it. */
	readonly pins?: PinManager;
	readonly cwd: string;
	readonly isCompacting: boolean;
	readonly isStreaming: boolean;
	emit(event: AgentSessionEvent): void;
	getCompactionRequestAuth(model: Model<any>): Promise<{ apiKey?: string; headers?: Record<string, string> }>;
	disconnectFromAgent(): void;
	reconnectToAgent(): void;
	abort(): Promise<void>;
}

/** Wire prefix surface (system prompt + tool schemas) captured at presend time. */
export interface PresendWireSurface {
	systemPrompt: string;
	tools: WireToolSurface[];
}

/**
 * P2 — speculative compaction slot. Holds one in-flight (or ready) pre-computed
 * summary generated mid-turn (between tool rounds) while the context is still a
 * band below the hard threshold. When the real compaction later trips, the ready
 * `result` is applied apply-only (no LLM call on the critical path) provided the
 * lineage anchors still match. Independent of `backgroundCompactionPromise` and
 * of `isCompacting` — the precompute never mutates session state.
 */
export interface SpeculativeCompactionSlot {
	/** Resolves when the precompute settles (success or fail); never rejects. */
	promise: Promise<void>;
	/** Aborts the in-flight `compact()` call (dispose / abortCompaction / real compaction / stale). */
	abort: AbortController;
	/** Ready summary once the precompute succeeds; undefined while in flight. */
	result?: CompactionResult;
	/** `getLatestCompactionEntry(getBranch())?.id` at precompute time X. */
	anchorLatestCompactionId: string | undefined;
	/** Session leaf entry id at precompute time X (lineage anchor for branch/rewind detection). */
	anchorLeafEntryId: string | undefined;
	/** Wire pressure at precompute time X, for the growth-refresh (>25% band → discard). */
	tokensAtPrecompute: number;
	/** Custom instructions at precompute time X (invalidate if they differ at consumption). */
	customInstructionsAtX: string | undefined;
}

/**
 * Fraction of the HARD threshold at which the mid-turn speculative precompute
 * trips — deliberately earlier than the prune / presend bands so the cheap
 * sibling-model summary is usually ready before the real (hard/presend) wall is
 * reached. Reuses the same hard-threshold math (`computeDynamicReserve`) as
 * `shouldCompact`; this is only the multiplier on it. Not env-tunable (the sole
 * escape is the `PIT_NO_SPECULATIVE_COMPACTION` kill-switch); exported for tests.
 */
export const SPECULATIVE_COMPACT_RATIO = 0.8;

/** Mutable compaction state owned per session. */
export class CompactionController {
	readonly host: CompactionHost;
	overflowRecoveryAttempted = false;
	/**
	 * Deficit (tokens over the hard threshold) at the last compaction trigger.
	 * UNIT INVARIANT: always FULL-REQUEST tokens — the same space for every
	 * writer. The presend guards measure the assembled wire (messages + system
	 * prompt + tool schemas + pending); the threshold path uses provider usage,
	 * which also bills the whole request. Never store a messages-only figure
	 * here — mixing spaces made the hysteresis nonsensical at the boundary.
	 */
	lastCompactionDeficit = 0;
	/**
	 * Last wire prefix surface seen by checkPresendOverflow. Lets the internal
	 * presend guard in checkCompaction measure in the SAME space (full wire)
	 * instead of messages-only — before this the two guards compared different
	 * quantities against the same ratio and never agreed at the boundary.
	 */
	lastWireSurface?: PresendWireSurface;
	backgroundCompactionPromise?: Promise<unknown>;
	compactionAbortController?: AbortController;
	autoCompactionAbortController?: AbortController;
	/** P2 — at most one speculative precompute in flight or ready at a time. */
	speculative?: SpeculativeCompactionSlot;

	constructor(host: CompactionHost) {
		this.host = host;
	}
}

/**
 * Assembled full-wire estimate for the CURRENT session messages: wire space
 * (messages + system prompt + tool schemas) when a presend surface is known,
 * falling back to the messages-only estimate before the first presend (context
 * is far from any threshold there, so the missing prefix cannot flip a guard).
 * Shared by both presend guards so they agree at the boundary.
 */
function estimateAssembledTokens(ctx: CompactionController): { tokens: number; trailingTokens: number } {
	const surface = ctx.lastWireSurface;
	if (!surface) {
		const estimate = estimateContextTokens(ctx.host.agent.state.messages);
		return { tokens: estimate.tokens, trailingTokens: estimate.trailingTokens };
	}
	const estimate = estimateWireTokens(ctx.host.agent.state.messages, {
		systemPromptChars: surface.systemPrompt.length,
		systemPromptText: surface.systemPrompt,
		tools: surface.tools,
	});
	return { tokens: estimate.tokens, trailingTokens: estimate.trailingTokens };
}

export function maybePruneStaleToolOutputs(ctx: CompactionController, contextTokens: number): void {
	if (isTruthyEnvFlag(process.env.PIT_NO_PROACTIVE_PRUNE)) return;
	const floorRaw = Number(process.env.PIT_PROACTIVE_PRUNE_FLOOR);
	const floor = proactivePruneFloor(
		ctx.host.model?.contextWindow ?? 0,
		Number.isFinite(floorRaw) ? floorRaw : undefined,
	);
	if (contextTokens <= floor) return;
	const contextWindow = ctx.host.model?.contextWindow ?? 0;
	const threshold = adaptivePruneThreshold(contextTokens, contextWindow);
	const protectTurns = pressurePruneProtectTurns(contextTokens, contextWindow);
	const messages = ctx.host.agent.state.messages;
	const prunePlan = planContextPrune(messages, protectTurns, ctx.host.pins?.pinnedCanonicalPaths());
	if (!wouldPruneOldToolOutputs(messages, threshold, protectTurns, prunePlan)) return;
	// Wire-only: do not mutate agent.state.messages. Presend transformContext applies
	// pruneOldToolOutputs on a clone; JSONL / canonical state stay intact.
	recordDiagnostic({
		category: "prune.proactive",
		level: "info",
		source: "agent-session.maybePruneStaleToolOutputs",
		context: {
			bytes: 0,
			note: `ctx=${contextTokens}tok protectTurns=${protectTurns} wireOnly=deferred`,
		},
	});
}

export interface MidTurnWirePressureInput {
	systemPrompt: string;
	tools: WireToolSurface[];
	thinkingLevel: ThinkingLevel;
	thinkingBudgets?: ReturnType<SettingsManager["getThinkingBudgets"]>;
	/** Override ratio for tests; defaults to PIT_MID_TURN_PRESSURE_RATIO / 0.92. */
	ratio?: number;
}

/**
 * Read-only full-wire pressure check for between-tool-round relief (B9).
 * Does NOT run LLM compaction — callers use {@link applyMidTurnPressureRelief}.
 *
 * Cheap early-exit: when a conservative upper bound is still under the ratio
 * threshold, skip {@link estimateWireTokens} (avoids calibration span walk).
 */
export function measureMidTurnWirePressure(
	messages: AgentMessage[],
	model: Model<any> | undefined,
	input: MidTurnWirePressureInput,
): { assembled: number; pressure: number; contextWindow: number; tripped: boolean } {
	const contextWindow = model?.contextWindow ?? 0;
	if (contextWindow <= 0 || isTruthyEnvFlag(process.env.PIT_NO_MID_TURN_PRESSURE_GUARD)) {
		return { assembled: 0, pressure: 0, contextWindow, tripped: false };
	}
	const ratio = input.ratio ?? MID_TURN_PRESSURE_RATIO;
	const threshold = contextWindow * ratio;
	const thinkingHeadroom = resolveThinkingHeadroom(model, input.thinkingLevel, input.thinkingBudgets);
	const ctxEstimate = estimateContextTokens(messages);
	const anchored = ctxEstimate.lastUsageIndex !== null;
	const upperAssembled = anchored
		? ctxEstimate.tokens
		: ctxEstimate.tokens + estimateTextTokens(input.systemPrompt) + estimateToolSurfaceTokens(input.tools);
	const upperPressure = upperAssembled + thinkingHeadroom;
	if (upperPressure <= threshold) {
		return {
			assembled: upperAssembled,
			pressure: upperPressure,
			contextWindow,
			tripped: false,
		};
	}
	const assembled = estimateWireTokens(messages, {
		systemPromptChars: input.systemPrompt.length,
		systemPromptText: input.systemPrompt,
		tools: input.tools,
	}).tokens;
	const pressure = assembled + thinkingHeadroom;
	return {
		assembled,
		pressure,
		contextWindow,
		tripped: pressure > threshold,
	};
}

/**
 * Prune-only mid-turn relief on a message array (no LLM compaction, no host mutation).
 * Same threshold logic as {@link maybePruneStaleToolOutputs}.
 */
export function applyMidTurnPressureRelief(
	messages: AgentMessage[],
	contextWindow: number,
	pinnedPaths?: ReadonlySet<string>,
): { messages: AgentMessage[]; reclaimed: number } {
	if (
		isTruthyEnvFlag(process.env.PIT_NO_PROACTIVE_PRUNE) ||
		isTruthyEnvFlag(process.env.PIT_NO_MID_TURN_PRESSURE_GUARD)
	) {
		return { messages, reclaimed: 0 };
	}
	const contextTokens = estimateContextTokens(messages).tokens;
	const floorRaw = Number(process.env.PIT_PROACTIVE_PRUNE_FLOOR);
	const floor = proactivePruneFloor(contextWindow, Number.isFinite(floorRaw) ? floorRaw : undefined);
	if (contextTokens <= floor) return { messages, reclaimed: 0 };
	const threshold = adaptivePruneThreshold(contextTokens, contextWindow);
	const protectTurns = pressurePruneProtectTurns(contextTokens, contextWindow);
	const prunePlan = planContextPrune(messages, protectTurns, pinnedPaths);
	if (!wouldPruneOldToolOutputs(messages, threshold, protectTurns, prunePlan)) {
		return { messages, reclaimed: 0 };
	}
	const copy = cloneToolResultMessagesForPrune(messages);
	const reclaimed = pruneOldToolOutputs(copy, threshold, protectTurns, true, prunePlan);
	if (reclaimed > 0) {
		recordDiagnostic({
			category: "prune.mid-turn-pressure",
			level: "info",
			source: "agent-session.applyMidTurnPressureRelief",
			context: {
				bytes: reclaimed,
				note: `ctx=${contextTokens}tok reclaimed=${reclaimed}tok protectTurns=${protectTurns}`,
			},
		});
		return { messages: copy, reclaimed };
	}
	return { messages, reclaimed: 0 };
}

/**
 * Resolve the `compact` model role for the summarization LLM call.
 *
 * Priority:
 * 1. Explicit `modelRoles.compact` when configured and auth resolves.
 * 2. Same-provider small-class sibling (haiku/mini/nano/flash/lite) when auth
 *    resolves — zero-config default so compaction does not burn the session model.
 * 3. Fail open to the session model + its already-fetched auth.
 *
 * Opt out of (2) with `PIT_NO_COMPACT_SIBLING_DEFAULT=1`. Thresholds stay on the
 * session model regardless (the caller computes them from `ctx.host.model`).
 */
export async function resolveCompactModel(
	ctx: CompactionController,
	sessionModel: Model<any>,
	sessionAuth: { apiKey: string | undefined; headers: Record<string, string> | undefined },
	sessionThinking: ThinkingLevel,
): Promise<{
	model: Model<any>;
	apiKey: string | undefined;
	headers: Record<string, string> | undefined;
	thinkingLevel: ThinkingLevel;
}> {
	const fallback = {
		model: sessionModel,
		apiKey: sessionAuth.apiKey,
		headers: sessionAuth.headers,
		thinkingLevel: sessionThinking,
	};
	try {
		const roleSettings = ctx.host.settingsManager.getModelRoleSettings();
		const availableModels = ctx.host.modelRegistry.getAll();
		let candidate: { model: Model<any>; thinkingLevel: ThinkingLevel } | undefined;

		if (roleSettings.modelRoles?.compact) {
			const resolved = resolveRole({
				role: "compact",
				availableModels,
				settings: roleSettings,
				cwd: ctx.host.cwd,
			});
			if (resolved) {
				candidate = { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
			}
		} else if (!isTruthyEnvFlag(process.env.PIT_NO_COMPACT_SIBLING_DEFAULT)) {
			const sibling = resolveCompactSibling(sessionModel, availableModels);
			if (sibling) {
				candidate = { model: sibling, thinkingLevel: "low" };
			}
		}

		if (!candidate) return fallback;

		let compactApiKey: string | undefined;
		let compactHeaders: Record<string, string> | undefined;
		if (ctx.host.agent.streamFn === streamSimple) {
			const authResult = await ctx.host.modelRegistry.getApiKeyAndHeaders(candidate.model);
			if (!authResult.ok || !authResult.apiKey) return fallback;
			compactApiKey = authResult.apiKey;
			compactHeaders = authResult.headers;
		} else {
			const auth = await ctx.host.getCompactionRequestAuth(candidate.model);
			compactApiKey = auth.apiKey;
			compactHeaders = auth.headers;
		}
		return {
			model: candidate.model,
			apiKey: compactApiKey,
			headers: compactHeaders,
			thinkingLevel: candidate.thinkingLevel,
		};
	} catch {
		return fallback;
	}
}

// ============================================================================
// P2 — speculative compaction (mid-turn precompute + apply-only consumption)
// ============================================================================

/**
 * Pure predicate: does the current mid-turn wire pressure warrant STARTING a
 * speculative precompute? Trips a band below the hard threshold (see
 * {@link SPECULATIVE_COMPACT_RATIO}), reusing the exact reserve math of
 * `shouldCompact` — this is only the multiplier on the hard threshold, never a
 * parallel threshold. Exported for tests.
 */
export function shouldPrecomputeSpeculativeCompaction(
	pressure: number,
	contextWindow: number,
	settings: CompactionSettings,
	ratio: number = SPECULATIVE_COMPACT_RATIO,
): boolean {
	if (!settings.enabled) return false;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;
	const reserve = computeDynamicReserve(contextWindow, settings.reserveTokens);
	const hardThreshold = contextWindow - reserve;
	return hardThreshold > 0 && pressure > hardThreshold * ratio;
}

/** Abort any in-flight speculative precompute and drop the slot. Idempotent. */
export function clearSpeculativeCompaction(ctx: CompactionController): void {
	const slot = ctx.speculative;
	if (!slot) return;
	ctx.speculative = undefined;
	try {
		slot.abort.abort();
	} catch {
		// abort() never throws in practice; stay fail-open regardless.
	}
}

export interface SpeculativeTriggerInput {
	/** Current mid-turn wire pressure (assembled + thinking headroom). */
	pressure: number;
	contextWindow: number;
	settings: CompactionSettings;
	/** Override the trip ratio (tests). Defaults to SPECULATIVE_COMPACT_RATIO. */
	ratio?: number;
}

/**
 * Mid-turn gate for the speculative precompute — FIRE-AND-FORGET, never blocks
 * the tool round. Runs all trigger guards (kill-switch, band, no real/background
 * compaction in flight, no precompute already in flight), handles the
 * growth-refresh (a ready summary whose window grew >25% of the hard threshold is
 * discarded so the next trip re-precomputes), and kicks off
 * {@link startSpeculativeCompaction} when clear.
 */
export function maybeStartSpeculativeCompaction(ctx: CompactionController, input: SpeculativeTriggerInput): void {
	if (isTruthyEnvFlag(process.env.PIT_NO_SPECULATIVE_COMPACTION)) return;
	if (!shouldPrecomputeSpeculativeCompaction(input.pressure, input.contextWindow, input.settings, input.ratio)) return;
	// A real compaction (foreground or background) owns the window while it runs.
	if (ctx.host.isCompacting || ctx.backgroundCompactionPromise) return;

	const slot = ctx.speculative;
	if (slot) {
		// Still in flight → let it finish; never start a second.
		if (!slot.result) return;
		// Ready result: refresh only if the window grew > 25% of the hard threshold
		// since X (the summary would then omit too much). Otherwise keep it —
		// re-firing would just reproduce the same summary.
		const reserve = computeDynamicReserve(input.contextWindow, input.settings.reserveTokens);
		const hardThreshold = input.contextWindow - reserve;
		const growth = input.pressure - slot.tokensAtPrecompute;
		if (hardThreshold > 0 && growth > hardThreshold * 0.25) {
			clearSpeculativeCompaction(ctx);
			recordDiagnostic({
				category: "compaction.speculative",
				level: "info",
				source: "agent-session.maybeStartSpeculativeCompaction",
				context: { note: `discard=growth grew=${Math.round(growth)}tok` },
			});
		}
		// Whether discarded or kept, do not start a fresh precompute this trip; the
		// next trip sees an empty slot (if discarded) and starts one.
		return;
	}

	// Fire-and-forget: never awaited, never allowed to surface a rejection.
	void startSpeculativeCompaction(ctx, input.settings, input.pressure).catch(() => undefined);
}

/**
 * Generate the summary in the BACKGROUND without applying it. Mirrors the miolo
 * of `runAutoCompaction` (prepare → resolve compact model → `compact()`) but
 * stores the {@link CompactionResult} in `ctx.speculative` instead of appending
 * it. Never sets `isCompacting`, never emits session events, never touches
 * `agent.state`. The slot is set synchronously (before any await) so the
 * in-flight guard is correct on the very next tool round. Fail-open: any
 * error/abort clears the slot silently (at most a diagnostic).
 */
export async function startSpeculativeCompaction(
	ctx: CompactionController,
	settings: CompactionSettings,
	tokensAtPrecompute: number,
): Promise<void> {
	// Extensions that intercept compaction keep the current flow intact — the
	// precompute never emits session_before_compact speculatively (conservative).
	if (ctx.host.extensionRunner.hasHandlers("session_before_compact")) return;
	const model = ctx.host.model;
	if (!model) return;

	// Snapshot moment X synchronously (before any await) so the anchors and the
	// preparation describe the same instant.
	const pathEntries = ctx.host.sessionManager.getBranch();
	const knownTokens = estimateContextTokens(ctx.host.agent.state.messages).tokens;
	const frameTokens = estimateCompactionFrameTokens(getLatestCompactionEntry(pathEntries)?.details);
	const keepOverride = adaptiveKeepRecentTokens(model.contextWindow ?? 0, settings, frameTokens);
	const preparation = prepareCompaction(pathEntries, settings, model.contextWindow, true, knownTokens, keepOverride);
	if (!preparation) return;
	preparation.cwd = ctx.host.cwd;

	const abort = new AbortController();
	const slot: SpeculativeCompactionSlot = {
		promise: Promise.resolve(),
		abort,
		anchorLatestCompactionId: getLatestCompactionEntry(pathEntries)?.id,
		anchorLeafEntryId: ctx.host.sessionManager.getLeafId() ?? undefined,
		tokensAtPrecompute,
		customInstructionsAtX: undefined,
	};
	ctx.speculative = slot;

	recordDiagnostic({
		category: "compaction.speculative",
		level: "info",
		source: "agent-session.startSpeculativeCompaction",
		context: { note: "start" },
	});

	slot.promise = (async () => {
		try {
			let apiKey: string | undefined;
			let headers: Record<string, string> | undefined;
			if (ctx.host.agent.streamFn === streamSimple) {
				const authResult = await ctx.host.modelRegistry.getApiKeyAndHeaders(model);
				if (!authResult.ok || !authResult.apiKey) {
					if (ctx.speculative === slot) ctx.speculative = undefined;
					return;
				}
				apiKey = authResult.apiKey;
				headers = authResult.headers;
			} else {
				({ apiKey, headers } = await ctx.host.getCompactionRequestAuth(model));
			}

			const compactModel = await resolveCompactModel(ctx, model, { apiKey, headers }, ctx.host.thinkingLevel);
			const result = await compact(
				preparation,
				compactModel.model,
				compactModel.apiKey,
				compactModel.headers,
				undefined,
				abort.signal,
				compactModel.thinkingLevel,
				ctx.host.agent.streamFn,
			);
			if (abort.signal.aborted || ctx.speculative !== slot) return;
			slot.result = result;
			recordDiagnostic({
				category: "compaction.speculative",
				level: "info",
				source: "agent-session.startSpeculativeCompaction",
				context: { note: "ready" },
			});
		} catch (error) {
			if (ctx.speculative === slot) ctx.speculative = undefined;
			recordDiagnostic({
				category: "compaction.speculative",
				level: "info",
				source: "agent-session.startSpeculativeCompaction",
				context: { note: `error=${error instanceof Error ? error.message : String(error)}` },
			});
		}
	})();

	// Never surfaces a rejection (the inner catch self-clears); awaiting here just
	// lets tests await settle via the returned promise.
	await slot.promise;
}

/**
 * Validate the speculative slot for apply-only consumption at real-compaction
 * time. Returns the ready summary iff EVERY anchor still holds:
 *   (a) no compaction applied since X (latest compaction entry id unchanged);
 *   (b) the moment-X leaf still lies on the active path (no branch/rewind/fork);
 *   (c) custom instructions unchanged;
 *   (d) the precompute already settled (in flight → do NOT wait).
 * Any miss clears the slot (aborting an in-flight precompute) and returns
 * undefined so the caller pays the normal LLM compaction. On a hit the slot is
 * consumed (cleared) so it can never be applied twice.
 */
export function consumeSpeculativeCompaction(
	ctx: CompactionController,
	currentCustomInstructions: string | undefined,
): CompactionResult | undefined {
	const slot = ctx.speculative;
	if (!slot) return undefined;

	// In flight at consumption → do NOT wait; abort and fall through to normal flow.
	if (!slot.result) {
		clearSpeculativeCompaction(ctx);
		recordDiagnostic({
			category: "compaction.speculative",
			level: "info",
			source: "agent-session.consumeSpeculativeCompaction",
			context: { note: "invalid=in-flight" },
		});
		return undefined;
	}

	const branch = ctx.host.sessionManager.getBranch();
	const latestCompactionId = getLatestCompactionEntry(branch)?.id;
	let invalidReason: string | undefined;
	if (latestCompactionId !== slot.anchorLatestCompactionId) {
		invalidReason = "compaction-applied";
	} else if (slot.anchorLeafEntryId === undefined || !branch.some((e) => e.id === slot.anchorLeafEntryId)) {
		invalidReason = "lineage";
	} else if ((currentCustomInstructions ?? undefined) !== (slot.customInstructionsAtX ?? undefined)) {
		invalidReason = "custom-instructions";
	}

	if (invalidReason) {
		clearSpeculativeCompaction(ctx);
		recordDiagnostic({
			category: "compaction.speculative",
			level: "info",
			source: "agent-session.consumeSpeculativeCompaction",
			context: { note: `invalid=${invalidReason}` },
		});
		return undefined;
	}

	const result = slot.result;
	clearSpeculativeCompaction(ctx);
	recordDiagnostic({
		category: "compaction.speculative",
		level: "info",
		source: "agent-session.consumeSpeculativeCompaction",
		context: { note: "hit" },
	});
	return result;
}

export async function executeCompactionPipeline(
	ctx: CompactionController,
	options: {
		preparation: CompactionPreparation;
		pathEntries: SessionEntry[];
		model: Model<any>;
		apiKey: string | undefined;
		headers: Record<string, string> | undefined;
		abortSignal: AbortSignal;
		customInstructions?: string;
		/** Thinking level for the summarization call; defaults to the session's. */
		thinkingLevel?: ThinkingLevel;
		/**
		 * P2 — a pre-computed summary to apply APPLY-ONLY (skips both the
		 * `session_before_compact` emit and the `compact()` LLM call). Enters at the
		 * same seam as an extension-supplied compaction, but with `fromExtension=false`.
		 */
		precomputed?: CompactionResult;
	},
): Promise<CompactionResult> {
	const { preparation, pathEntries, model, apiKey, headers, abortSignal, customInstructions, precomputed } = options;
	const thinkingLevel = options.thinkingLevel ?? ctx.host.thinkingLevel;
	let extensionCompaction: CompactionResult | undefined = precomputed;
	let fromExtension = false;

	if (!precomputed && ctx.host.extensionRunner.hasHandlers("session_before_compact")) {
		const result = (await ctx.host.extensionRunner.emit({
			type: "session_before_compact",
			preparation,
			branchEntries: pathEntries,
			customInstructions,
			signal: abortSignal,
		})) as SessionBeforeCompactResult | undefined;

		if (result?.cancel) {
			throw new Error("Compaction cancelled");
		}

		if (result?.compaction) {
			extensionCompaction = result.compaction;
			fromExtension = true;
		}
	}

	let summary: string;
	let firstKeptEntryId: string;
	let tokensBefore: number;
	let details: unknown;

	if (extensionCompaction) {
		({ summary, firstKeptEntryId, tokensBefore, details } = extensionCompaction);
	} else {
		const result = await compact(
			preparation,
			model,
			apiKey,
			headers,
			customInstructions,
			abortSignal,
			thinkingLevel,
			ctx.host.agent.streamFn,
		);
		({ summary, firstKeptEntryId, tokensBefore, details } = result);
	}

	if (abortSignal.aborted) {
		throw new Error("Compaction cancelled");
	}

	// P5: carry pinned facts/files across the span the summary folds away. File
	// pins protect window evidence, not against a full compaction — this footer
	// (plus the per-turn <pinned> section) is their survival mechanism.
	const pinFooter = ctx.host.pins?.summaryFooter();
	const summaryWithPins = pinFooter ? `${summary}\n\n${pinFooter}` : summary;

	const compactionId = ctx.host.sessionManager.appendCompaction(
		summaryWithPins,
		firstKeptEntryId,
		tokensBefore,
		details,
		fromExtension,
	);
	const sessionContext = ctx.host.sessionManager.buildSessionContext();
	ctx.host.agent.state.messages = sessionContext.messages;

	// P2: a compaction was just applied (real or precomputed) — any speculative
	// slot is now stale (its anchor no longer matches). Abort/drop it.
	clearSpeculativeCompaction(ctx);

	const savedCompactionEntry = ctx.host.sessionManager.getEntry(compactionId) as CompactionEntry | undefined;
	if (ctx.host.extensionRunner && savedCompactionEntry) {
		await ctx.host.extensionRunner.emit({
			type: "session_compact",
			compactionEntry: savedCompactionEntry,
			fromExtension,
		});
	}

	if (ctx.host.hindsightBank && typeof summary === "string" && summary.length > 0) {
		try {
			ctx.host.hindsightBank.add({
				kind: "session-summary",
				body: summary,
				subject: ctx.host.sessionId,
				source: { sessionId: ctx.host.sessionId },
			});
		} catch {
			// Bank persistence failure should not abort the compaction.
		}
	}

	pruneReadDedupeAfterCompaction(ctx, details);

	return { summary, firstKeptEntryId, tokensBefore, details };
}

/**
 * After compaction, drop ReadDedupeStore entries for paths not anchored in the
 * summary frame (or whose mtime drifted). Empty keep-set → no-op (T09).
 */
export function pruneReadDedupeAfterCompaction(ctx: CompactionController, details: unknown): void {
	if (isTruthyEnvFlag(process.env.PIT_NO_READ_DEDUPE_PRUNE)) return;
	const store = ctx.host.readDedupeStore;
	if (!store) return;

	const d = details as
		| {
				readFiles?: string[];
				modifiedFiles?: string[];
				fileDigests?: Record<string, string>;
		  }
		| undefined
		| null;
	if (!d || typeof d !== "object") return;

	const relPaths = [
		...(Array.isArray(d.readFiles) ? d.readFiles : []),
		...(Array.isArray(d.modifiedFiles) ? d.modifiedFiles : []),
		...(d.fileDigests && typeof d.fileDigests === "object" ? Object.keys(d.fileDigests) : []),
	].filter((p): p is string => typeof p === "string" && p.length > 0);

	if (relPaths.length === 0) return;

	const keep = new Set(relPaths.map((p) => canonicalPathKey(resolveReadPath(p, ctx.host.cwd))));
	const mtimeStore = ctx.host.fileMtimeStore;
	store.pruneExcept(keep, (canonicalPath) => {
		if (!mtimeStore) return false;
		const recorded = mtimeStore.get(canonicalPath);
		if (recorded === undefined) return true;
		try {
			return statSync(canonicalPath).mtimeMs !== recorded;
		} catch {
			return true;
		}
	});
}

export async function compactSession(
	ctx: CompactionController,
	customInstructions?: string,
): Promise<CompactionResult> {
	ctx.host.disconnectFromAgent();
	await ctx.host.abort();
	ctx.compactionAbortController = new AbortController();
	ctx.host.emit({ type: "compaction_start", reason: "manual" });

	try {
		if (!ctx.host.model) {
			throw new Error(formatNoModelSelectedMessage());
		}

		const { apiKey, headers } = await ctx.host.getCompactionRequestAuth(ctx.host.model);

		const pathEntries = ctx.host.sessionManager.getBranch();
		const settings = ctx.host.settingsManager.getCompactionSettings();

		const preparation = prepareCompaction(
			pathEntries,
			settings,
			ctx.host.model?.contextWindow,
			false,
			estimateContextTokens(ctx.host.agent.state.messages).tokens,
		);
		if (!preparation) {
			const lastEntry = pathEntries[pathEntries.length - 1];
			throw new Error(
				lastEntry?.type === "compaction" ? "Already compacted" : "Nothing to compact (session too small)",
			);
		}
		preparation.cwd = ctx.host.cwd;

		const compactionAbort = ctx.compactionAbortController;
		if (!compactionAbort) {
			throw new Error("Compaction cancelled");
		}

		// Route the summarization call to the `compact` role when configured;
		// fail open to the session model otherwise. Thresholds stay on the session model.
		const compactModel = await resolveCompactModel(ctx, ctx.host.model, { apiKey, headers }, ctx.host.thinkingLevel);

		const compactionResult = await executeCompactionPipeline(ctx, {
			preparation,
			pathEntries,
			model: compactModel.model,
			apiKey: compactModel.apiKey,
			headers: compactModel.headers,
			abortSignal: compactionAbort.signal,
			customInstructions,
			thinkingLevel: compactModel.thinkingLevel,
		});

		ctx.host.emit({
			type: "compaction_end",
			reason: "manual",
			result: compactionResult,
			aborted: false,
			willRetry: false,
		});
		return compactionResult;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
		ctx.host.emit({
			type: "compaction_end",
			reason: "manual",
			result: undefined,
			aborted,
			willRetry: false,
			errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
		});
		throw error;
	} finally {
		ctx.compactionAbortController = undefined;
		ctx.host.reconnectToAgent();
	}
}

export interface PresendWireInput {
	systemPrompt: string;
	tools: WireToolSurface[];
	pendingMessages: AgentMessage[];
}

export async function checkPresendOverflow(
	ctx: CompactionController,
	assistantMessage: AssistantMessage,
	wireInput: PresendWireInput,
): Promise<boolean> {
	const settings = ctx.host.settingsManager.getCompactionSettings();
	if (!settings.enabled) return false;

	const contextWindow = ctx.host.model?.contextWindow ?? 0;
	if (contextWindow <= 0 || ctx.host.isCompacting) return false;
	if (isTruthyEnvFlag(process.env.PIT_NO_PRESEND_OVERFLOW_GUARD)) {
		return false;
	}

	const compactionEntry = getLatestCompactionEntry(ctx.host.sessionManager.getBranch());
	const assistantIsFromBeforeCompaction =
		compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
	if (assistantIsFromBeforeCompaction) return false;

	// Remember the wire prefix surface so checkCompaction's internal guard can
	// measure in the same (full-wire) space on the post-response path.
	ctx.lastWireSurface = { systemPrompt: wireInput.systemPrompt, tools: wireInput.tools };

	let contextTokens: number;
	if (assistantMessage.stopReason === "error") {
		contextTokens = estimateContextTokens(ctx.host.agent.state.messages).tokens;
	} else {
		contextTokens = calculateContextTokens(assistantMessage.usage);
	}

	const wireEstimate = estimateWireTokens(ctx.host.agent.state.messages, {
		systemPromptChars: wireInput.systemPrompt.length,
		systemPromptText: wireInput.systemPrompt,
		tools: wireInput.tools,
		pendingMessages: wireInput.pendingMessages,
	});
	let assembled = wireEstimate.tokens;

	const thinkingHeadroom = resolveThinkingHeadroom(
		ctx.host.model,
		ctx.host.thinkingLevel,
		ctx.host.settingsManager.getThinkingBudgets(),
	);
	const pressure = assembled + thinkingHeadroom;
	const effectiveRatio = resolveDynamicPresendOverflowRatio({
		baseRatio: PRESEND_OVERFLOW_RATIO,
		pressure,
		contextWindow,
		trailingTokens: wireEstimate.trailingTokens,
		assembled,
	});

	if (pressure > contextWindow * effectiveRatio && assembled > contextTokens) {
		let trailingTokensAfter = wireEstimate.trailingTokens;
		if (ctx.backgroundCompactionPromise) {
			await awaitBackgroundCompaction(ctx);
			const reEstimate = estimateWireTokens(ctx.host.agent.state.messages, {
				systemPromptChars: wireInput.systemPrompt.length,
				systemPromptText: wireInput.systemPrompt,
				tools: wireInput.tools,
				pendingMessages: wireInput.pendingMessages,
			});
			assembled = reEstimate.tokens;
			trailingTokensAfter = reEstimate.trailingTokens;
		}
		const pressureAfter = assembled + thinkingHeadroom;
		const ratioAfter = resolveDynamicPresendOverflowRatio({
			baseRatio: PRESEND_OVERFLOW_RATIO,
			pressure: pressureAfter,
			contextWindow,
			trailingTokens: trailingTokensAfter,
			assembled,
		});
		if (pressureAfter > contextWindow * ratioAfter && !ctx.host.isCompacting) {
			const reserve = computeDynamicReserve(contextWindow, settings.reserveTokens);
			ctx.lastCompactionDeficit = pressureAfter - (contextWindow - reserve);
			recordDiagnostic({
				category: "compaction.presend-overflow-guard",
				level: "warn",
				source: "agent-session.checkPresendOverflow",
				context: {
					bytes: assembled,
					note: `window=${contextWindow} wire pending=${wireInput.pendingMessages.length} thinkingHeadroom=${thinkingHeadroom} effectiveRatio=${ratioAfter.toFixed(3)}`,
				},
			});
			return await runAutoCompaction(ctx, "threshold", false);
		}
	}
	return false;
}

export async function checkCompaction(
	ctx: CompactionController,
	assistantMessage: AssistantMessage,
	skipAbortedCheck = true,
	allowBackground = false,
	options?: { skipPresendGuard?: boolean },
): Promise<boolean> {
	const settings = ctx.host.settingsManager.getCompactionSettings();
	if (!settings.enabled) return false;

	if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

	const contextWindow = ctx.host.model?.contextWindow ?? 0;

	const sameModel =
		ctx.host.model &&
		assistantMessage.provider === ctx.host.model.provider &&
		assistantMessage.model === ctx.host.model.id;

	const compactionEntry = getLatestCompactionEntry(ctx.host.sessionManager.getBranch());
	const assistantIsFromBeforeCompaction =
		compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
	if (assistantIsFromBeforeCompaction) {
		return false;
	}

	if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
		if (ctx.overflowRecoveryAttempted) {
			ctx.host.emit({
				type: "compaction_end",
				reason: "overflow",
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
			});
			return false;
		}

		ctx.overflowRecoveryAttempted = true;
		const messages = ctx.host.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			ctx.host.agent.state.messages = messages.slice(0, -1);
		}
		return await runAutoCompaction(ctx, "overflow", true);
	}

	let contextTokens: number;
	if (assistantMessage.stopReason === "error") {
		const messages = ctx.host.agent.state.messages;
		const estimate = estimateContextTokens(messages);
		if (estimate.lastUsageIndex === null) return false;
		const usageMsg = messages[estimate.lastUsageIndex];
		if (
			compactionEntry &&
			usageMsg.role === "assistant" &&
			(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
		) {
			return false;
		}
		contextTokens = estimate.tokens;
	} else {
		contextTokens = calculateContextTokens(assistantMessage.usage);
	}

	if (
		!options?.skipPresendGuard &&
		contextWindow > 0 &&
		!ctx.host.isCompacting &&
		!isTruthyEnvFlag(process.env.PIT_NO_PRESEND_OVERFLOW_GUARD)
	) {
		// Unified space: same full-wire estimate as checkPresendOverflow (via the
		// captured prefix surface), so the two guards agree at the boundary and
		// lastCompactionDeficit stays in one unit.
		let assembledEstimate = estimateAssembledTokens(ctx);
		let assembled = assembledEstimate.tokens;
		const trailingTokens = assembledEstimate.trailingTokens;
		const thinkingHeadroom = resolveThinkingHeadroom(
			ctx.host.model,
			ctx.host.thinkingLevel,
			ctx.host.settingsManager.getThinkingBudgets(),
		);
		const pressure = assembled + thinkingHeadroom;
		const effectiveRatio = resolveDynamicPresendOverflowRatio({
			baseRatio: PRESEND_OVERFLOW_RATIO,
			pressure,
			contextWindow,
			trailingTokens,
			assembled,
		});
		if (pressure > contextWindow * effectiveRatio && assembled > contextTokens) {
			let trailingTokensAfter = trailingTokens;
			if (ctx.backgroundCompactionPromise) {
				await awaitBackgroundCompaction(ctx);
				assembledEstimate = estimateAssembledTokens(ctx);
				assembled = assembledEstimate.tokens;
				trailingTokensAfter = assembledEstimate.trailingTokens;
			}
			const pressureAfter = assembled + thinkingHeadroom;
			const ratioAfter = resolveDynamicPresendOverflowRatio({
				baseRatio: PRESEND_OVERFLOW_RATIO,
				pressure: pressureAfter,
				contextWindow,
				trailingTokens: trailingTokensAfter,
				assembled,
			});
			if (pressureAfter > contextWindow * ratioAfter && !ctx.host.isCompacting) {
				const reserve = computeDynamicReserve(contextWindow, settings.reserveTokens);
				ctx.lastCompactionDeficit = pressureAfter - (contextWindow - reserve);
				recordDiagnostic({
					category: "compaction.presend-overflow-guard",
					level: "warn",
					source: "agent-session._checkCompaction",
					context: {
						bytes: assembled,
						note: `window=${contextWindow} thinkingHeadroom=${thinkingHeadroom} effectiveRatio=${ratioAfter.toFixed(3)}`,
					},
				});
				return await runAutoCompaction(ctx, "threshold", false);
			}
		}
	}
	if (shouldCompact(contextTokens, contextWindow, settings, ctx.lastCompactionDeficit)) {
		if (ctx.backgroundCompactionPromise) await awaitBackgroundCompaction(ctx);
		if (ctx.host.isCompacting) return false;
		// P01: lastAssistant.usage can be stale after predictive background compaction
		// finished during the user's read time (promise already cleared in finally).
		// Re-check with a live message estimate before paying for a sync LLM compact.
		const freshTokens = estimateContextTokens(ctx.host.agent.state.messages).tokens;
		if (!shouldCompact(freshTokens, contextWindow, settings, ctx.lastCompactionDeficit)) {
			return false;
		}
		const reserve = computeDynamicReserve(contextWindow, settings.reserveTokens);
		ctx.lastCompactionDeficit = freshTokens - (contextWindow - reserve);
		return await runAutoCompaction(ctx, "threshold", false);
	}

	maybePruneStaleToolOutputs(ctx, contextTokens);

	if (
		allowBackground &&
		!ctx.backgroundCompactionPromise &&
		!ctx.host.isCompacting &&
		!ctx.host.isStreaming &&
		shouldStartBackgroundCompaction(contextTokens, contextWindow, settings)
	) {
		ctx.backgroundCompactionPromise = runAutoCompaction(ctx, "threshold", false)
			.catch(() => false)
			.finally(() => {
				ctx.backgroundCompactionPromise = undefined;
			});
	}
	return false;
}

export async function awaitBackgroundCompaction(ctx: CompactionController): Promise<void> {
	const inFlight = ctx.backgroundCompactionPromise;
	if (!inFlight) return;
	try {
		await inFlight;
	} catch {
		// Failures are already surfaced via compaction_end; the hard threshold
		// check remains as the synchronous fallback on the next turn.
	}
}

export async function runAutoCompaction(
	ctx: CompactionController,
	reason: "overflow" | "threshold",
	willRetry: boolean,
): Promise<boolean> {
	const settings = ctx.host.settingsManager.getCompactionSettings();
	const emitSilentEnd = () =>
		ctx.host.emit({ type: "compaction_end", reason, result: undefined, aborted: false, willRetry: false });

	ctx.host.emit({ type: "compaction_start", reason });
	ctx.autoCompactionAbortController = new AbortController();

	try {
		if (!ctx.host.model) {
			emitSilentEnd();
			return false;
		}

		let apiKey: string | undefined;
		let headers: Record<string, string> | undefined;
		if (ctx.host.agent.streamFn === streamSimple) {
			const authResult = await ctx.host.modelRegistry.getApiKeyAndHeaders(ctx.host.model);
			if (!authResult.ok || !authResult.apiKey) {
				emitSilentEnd();
				return false;
			}
			apiKey = authResult.apiKey;
			headers = authResult.headers;
		} else {
			({ apiKey, headers } = await ctx.host.getCompactionRequestAuth(ctx.host.model));
		}

		const pathEntries = ctx.host.sessionManager.getBranch();
		// Adaptive cut: on windows where the default keep + summary would land back
		// above the re-check threshold, shrink the keep so ONE pass suffices
		// instead of paying a second full pipeline. undefined on normal windows.
		// M8: the summary budget derives from the real summarizer ceiling
		// (0.8×reserve) plus the structural frame the previous compaction persisted
		// (the frame merges forward, so it predicts the next one).
		const frameTokens = estimateCompactionFrameTokens(getLatestCompactionEntry(pathEntries)?.details);
		const keepOverride = adaptiveKeepRecentTokens(ctx.host.model?.contextWindow ?? 0, settings, frameTokens);
		const preparation = prepareCompaction(
			pathEntries,
			settings,
			ctx.host.model?.contextWindow,
			reason === "threshold",
			estimateContextTokens(ctx.host.agent.state.messages).tokens,
			keepOverride,
		);
		if (preparation) preparation.cwd = ctx.host.cwd;
		if (!preparation) {
			emitSilentEnd();
			return false;
		}

		const autoAbort = ctx.autoCompactionAbortController;
		if (!autoAbort) {
			emitSilentEnd();
			return false;
		}

		// P2: if a valid pre-computed summary is waiting, apply it apply-only and
		// skip the LLM summarization entirely. The auto path never carries custom
		// instructions, so the anchor's customInstructionsAtX must be undefined too.
		const precomputed = consumeSpeculativeCompaction(ctx, undefined);

		// Route the summarization call to the `compact` role when configured;
		// fail open to the session model otherwise. Thresholds above stay on the
		// session model (`ctx.host.model`).
		const compactModel = await resolveCompactModel(ctx, ctx.host.model, { apiKey, headers }, ctx.host.thinkingLevel);

		const result = await executeCompactionPipeline(ctx, {
			preparation,
			pathEntries,
			model: compactModel.model,
			apiKey: compactModel.apiKey,
			headers: compactModel.headers,
			abortSignal: autoAbort.signal,
			thinkingLevel: compactModel.thinkingLevel,
			precomputed,
		});

		ctx.host.emit({ type: "compaction_end", reason, result, aborted: false, willRetry });
		ctx.lastCompactionDeficit = 0;

		if (!willRetry && reason === "threshold") {
			const contextWindow = ctx.host.model?.contextWindow ?? 0;
			// Fallback second pass — rare after the adaptive cut above. The re-check
			// MUST use the pure per-message estimate: the kept assistant messages
			// still carry their PRE-compaction usage, so the usage-based
			// estimateContextTokens reads as if nothing was compacted and re-fired
			// this pass on nearly every threshold compaction (a systematic false
			// positive costing 1-2 extra LLM calls each time).
			const contextTokens = sumMessageTokens(ctx.host.agent.state.messages);
			if (shouldRunCompactionSecondPass(contextTokens, contextWindow, settings)) {
				const pathEntriesAfter = ctx.host.sessionManager.getBranch();
				const preparationAfter = prepareCompaction(
					pathEntriesAfter,
					settings,
					contextWindow,
					true,
					contextTokens,
					keepOverride,
				);
				// Progress guard: without a summarizable span the pass would be a
				// no-op that still pays the LLM calls (the previous compaction's kept
				// window is already inside the retention budget).
				const hasSummarizableSpan =
					preparationAfter !== undefined &&
					((preparationAfter.messagesToSummarize?.length ?? 0) > 0 ||
						(preparationAfter.turnPrefixMessages?.length ?? 0) > 0);
				if (preparationAfter && hasSummarizableSpan) {
					ctx.host.emit({ type: "compaction_start", reason });
					preparationAfter.cwd = ctx.host.cwd;
					const resultAfter = await executeCompactionPipeline(ctx, {
						preparation: preparationAfter,
						pathEntries: pathEntriesAfter,
						model: compactModel.model,
						apiKey: compactModel.apiKey,
						headers: compactModel.headers,
						abortSignal: autoAbort.signal,
						thinkingLevel: compactModel.thinkingLevel,
					});
					ctx.host.emit({ type: "compaction_end", reason, result: resultAfter, aborted: false, willRetry });
				}
			}
		}

		if (willRetry) {
			const messages = ctx.host.agent.state.messages;
			const lastMsg = messages[messages.length - 1];
			if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
				ctx.host.agent.state.messages = messages.slice(0, -1);
			}
			return true;
		}

		return ctx.host.agent.hasQueuedMessages();
	} catch (error) {
		const message = error instanceof Error ? error.message : "compaction failed";
		const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
		ctx.host.emit({
			type: "compaction_end",
			reason,
			result: undefined,
			aborted,
			willRetry: false,
			errorMessage: aborted
				? undefined
				: reason === "overflow"
					? `Context overflow recovery failed: ${message}`
					: `Auto-compaction failed: ${message}`,
		});
		// Transient failure (auth/network) must not leave a positive deficit that
		// raises the re-trigger threshold — the context is already above it and the
		// next turn should try again immediately.
		ctx.lastCompactionDeficit = 0;
		return false;
	} finally {
		ctx.autoCompactionAbortController = undefined;
	}
}
