/**
 * Compaction pipeline extracted from AgentSession (move-only).
 */

import type { Agent, AgentMessage, ThinkingLevel } from "@pit/agent-core";
import type { AssistantMessage, Model } from "@pit/ai";
import { isContextOverflow, recordDiagnostic, streamSimple } from "@pit/ai";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import type { AgentSessionEvent } from "./agent-session-events.ts";
import { formatNoModelSelectedMessage } from "./auth-guidance.ts";
import {
	adaptivePruneThreshold,
	cloneToolResultMessagesForPrune,
	estimateWireTokens,
	planContextPrune,
	pressurePruneProtectTurns,
	pruneOldToolOutputs,
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
	shouldCompactSoft,
	sumMessageTokens,
} from "./compaction/index.ts";
import type { ExtensionRunner, SessionBeforeCompactResult } from "./extensions/index.js";
import type { HindsightBank } from "./hindsight/index.js";
import type { ModelRegistry } from "./model-registry.ts";
import { resolveRole } from "./model-resolver.ts";
import type { CompactionEntry, SessionEntry, SessionManager } from "./session-manager.js";
import { getLatestCompactionEntry } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import type { ReadDedupeStore } from "./tools/read.js";

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
	readonly cwd: string;
	readonly isCompacting: boolean;
	readonly isStreaming: boolean;
	emit(event: AgentSessionEvent): void;
	getCompactionRequestAuth(model: Model<any>): Promise<{ apiKey?: string; headers?: Record<string, string> }>;
	disconnectFromAgent(): void;
	reconnectToAgent(): void;
	abort(): Promise<void>;
}

/** Mutable compaction state owned per session. */
export class CompactionController {
	readonly host: CompactionHost;
	overflowRecoveryAttempted = false;
	lastCompactionDeficit = 0;
	backgroundCompactionPromise?: Promise<unknown>;
	compactionAbortController?: AbortController;
	autoCompactionAbortController?: AbortController;

	constructor(host: CompactionHost) {
		this.host = host;
	}
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
	// One plan shared by the would-check and the apply: indices stay valid on the
	// clone because cloneToolResultMessagesForPrune preserves order and length
	// (same pattern as _pruneContextForProvider).
	const prunePlan = planContextPrune(messages, protectTurns);
	if (!wouldPruneOldToolOutputs(messages, threshold, protectTurns, prunePlan)) return;
	const copy = cloneToolResultMessagesForPrune(messages);
	const reclaimed = pruneOldToolOutputs(copy, threshold, protectTurns, true, prunePlan);
	recordDiagnostic({
		category: "prune.proactive",
		level: "info",
		source: "agent-session.maybePruneStaleToolOutputs",
		context: {
			bytes: reclaimed,
			note: `ctx=${contextTokens}tok reclaimed=${reclaimed}tok protectTurns=${protectTurns}`,
		},
	});
	if (reclaimed > 0) ctx.host.agent.state.messages = copy;
}

/**
 * Resolve the `compact` model role for the summarization LLM call. When
 * `modelRoles.compact` is configured AND its auth resolves, the summarization
 * routes to that (typically faster/cheaper) model with the role's thinking
 * level. Otherwise — no role configured, role resolves to nothing, or auth
 * fails — fail open to the session model + its already-fetched auth, so the
 * compaction never breaks because of the role. Thresholds stay on the session
 * model regardless (the caller computes them from `ctx.host.model`).
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
		if (!roleSettings.modelRoles?.compact) return fallback;
		const availableModels = ctx.host.modelRegistry.getAll();
		const resolved = resolveRole({
			role: "compact",
			availableModels,
			settings: roleSettings,
			cwd: ctx.host.cwd,
		});
		if (!resolved) return fallback;
		let compactApiKey: string | undefined;
		let compactHeaders: Record<string, string> | undefined;
		if (ctx.host.agent.streamFn === streamSimple) {
			const authResult = await ctx.host.modelRegistry.getApiKeyAndHeaders(resolved.model);
			if (!authResult.ok || !authResult.apiKey) return fallback;
			compactApiKey = authResult.apiKey;
			compactHeaders = authResult.headers;
		} else {
			const auth = await ctx.host.getCompactionRequestAuth(resolved.model);
			compactApiKey = auth.apiKey;
			compactHeaders = auth.headers;
		}
		return {
			model: resolved.model,
			apiKey: compactApiKey,
			headers: compactHeaders,
			thinkingLevel: resolved.thinkingLevel,
		};
	} catch {
		return fallback;
	}
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
	},
): Promise<CompactionResult> {
	const { preparation, pathEntries, model, apiKey, headers, abortSignal, customInstructions } = options;
	const thinkingLevel = options.thinkingLevel ?? ctx.host.thinkingLevel;
	ctx.host.readDedupeStore?.clear();
	let extensionCompaction: CompactionResult | undefined;
	let fromExtension = false;

	if (ctx.host.extensionRunner.hasHandlers("session_before_compact")) {
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

	const compactionId = ctx.host.sessionManager.appendCompaction(
		summary,
		firstKeptEntryId,
		tokensBefore,
		details,
		fromExtension,
	);
	const sessionContext = ctx.host.sessionManager.buildSessionContext();
	ctx.host.agent.state.messages = sessionContext.messages;

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

	return { summary, firstKeptEntryId, tokensBefore, details };
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
	if (typeof process !== "undefined" && process.env.PIT_NO_PRESEND_OVERFLOW_GUARD === "1") {
		return false;
	}

	const compactionEntry = getLatestCompactionEntry(ctx.host.sessionManager.getBranch());
	const assistantIsFromBeforeCompaction =
		compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
	if (assistantIsFromBeforeCompaction) return false;

	let contextTokens: number;
	if (assistantMessage.stopReason === "error") {
		contextTokens = estimateContextTokens(ctx.host.agent.state.messages).tokens;
	} else {
		contextTokens = calculateContextTokens(assistantMessage.usage);
	}

	let assembled = estimateWireTokens(ctx.host.agent.state.messages, {
		systemPromptChars: wireInput.systemPrompt.length,
		tools: wireInput.tools,
		pendingMessages: wireInput.pendingMessages,
	}).tokens;

	if (assembled > contextWindow * PRESEND_OVERFLOW_RATIO && assembled > contextTokens) {
		if (ctx.backgroundCompactionPromise) {
			await awaitBackgroundCompaction(ctx);
			assembled = estimateWireTokens(ctx.host.agent.state.messages, {
				systemPromptChars: wireInput.systemPrompt.length,
				tools: wireInput.tools,
				pendingMessages: wireInput.pendingMessages,
			}).tokens;
		}
		if (assembled > contextWindow * PRESEND_OVERFLOW_RATIO && !ctx.host.isCompacting) {
			const reserve = computeDynamicReserve(contextWindow, settings.reserveTokens);
			ctx.lastCompactionDeficit = assembled - (contextWindow - reserve);
			recordDiagnostic({
				category: "compaction.presend-overflow-guard",
				level: "warn",
				source: "agent-session.checkPresendOverflow",
				context: {
					bytes: assembled,
					note: `window=${contextWindow} wire pending=${wireInput.pendingMessages.length}`,
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
		!(typeof process !== "undefined" && process.env.PIT_NO_PRESEND_OVERFLOW_GUARD === "1")
	) {
		let assembled = estimateContextTokens(ctx.host.agent.state.messages).tokens;
		if (assembled > contextWindow * PRESEND_OVERFLOW_RATIO && assembled > contextTokens) {
			if (ctx.backgroundCompactionPromise) {
				await awaitBackgroundCompaction(ctx);
				assembled = estimateContextTokens(ctx.host.agent.state.messages).tokens;
			}
			if (assembled > contextWindow * PRESEND_OVERFLOW_RATIO && !ctx.host.isCompacting) {
				const reserve = computeDynamicReserve(contextWindow, settings.reserveTokens);
				ctx.lastCompactionDeficit = assembled - (contextWindow - reserve);
				recordDiagnostic({
					category: "compaction.presend-overflow-guard",
					level: "warn",
					source: "agent-session._checkCompaction",
					context: { bytes: assembled, note: `window=${contextWindow}` },
				});
				return await runAutoCompaction(ctx, "threshold", false);
			}
		}
	}
	if (shouldCompact(contextTokens, contextWindow, settings, ctx.lastCompactionDeficit)) {
		if (ctx.backgroundCompactionPromise) await awaitBackgroundCompaction(ctx);
		if (ctx.host.isCompacting) return false;
		const reserve = computeDynamicReserve(contextWindow, settings.reserveTokens);
		ctx.lastCompactionDeficit = contextTokens - (contextWindow - reserve);
		return await runAutoCompaction(ctx, "threshold", false);
	}

	maybePruneStaleToolOutputs(ctx, contextTokens);

	if (
		allowBackground &&
		!ctx.backgroundCompactionPromise &&
		!ctx.host.isCompacting &&
		!ctx.host.isStreaming &&
		shouldCompactSoft(contextTokens, contextWindow, settings)
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
		const keepOverride = adaptiveKeepRecentTokens(ctx.host.model?.contextWindow ?? 0, settings);
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
			if (
				shouldCompact(contextTokens, contextWindow, settings, 0) ||
				shouldCompactSoft(contextTokens, contextWindow, settings)
			) {
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
		return false;
	} finally {
		ctx.autoCompactionAbortController = undefined;
	}
}
