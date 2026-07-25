/**
 * Fusion turn pipeline extracted from AgentSession (move-only).
 */

import type { Agent, AgentMessage, AgentTool } from "@pit/agent-core";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	TextContent,
	Usage,
} from "@pit/ai";
import { completeSimple, recordDiagnostic, streamSimple } from "@pit/ai";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import { sliceSafe } from "../utils/surrogate.ts";
import { type CompactionController, checkCompaction } from "./agent-session-compaction.ts";
import type { AgentSessionEvent } from "./agent-session-events.ts";
import { estimateCharsAsTokens } from "./compaction/utils.ts";
import { getSubagentErrorUsage, SubagentRegistry, spawnSubagent } from "./coordinator/index.ts";
import type { ContextUsage } from "./extensions/index.js";
import { providerForCli, runPanelMember } from "./fusion/cli-runner.ts";
import {
	buildAdvisorBriefContext,
	buildJudgeContext,
	buildVerifierPrompt,
	buildWriterContext,
	buildWriterPrefixReuseContext,
	parseJudgeOutput,
	VERIFICATION_SCHEMA,
	VERIFIER_SYSTEM_PROMPT,
} from "./fusion/judge.ts";
import { runFusionTurn } from "./fusion/orchestrator.ts";
import type { FusionSummaryData, JudgeAnalysis, PanelResult, VerificationReport } from "./fusion/types.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { PermissionChecker } from "./permissions/index.ts";
import type { SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import type { SpawnBudgetDecision } from "./token-governor.ts";
import { consumedTokens } from "./token-usage.ts";
import { buildWireContext } from "./wire-context.ts";

/** Stable session surface fusion reads; implemented by AgentSession. */
export interface FusionHost {
	readonly model: Model<any> | undefined;
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly modelRegistry: ModelRegistry;
	readonly cwd: string;
	readonly compaction: CompactionController;
	readonly fusionAbort: AbortController | undefined;
	setFusionAbort(value: AbortController | undefined): void;
	readonly userInterrupted: boolean;
	emit(event: AgentSessionEvent): void;
	getRequiredRequestAuth(model: Model<any>): Promise<{ apiKey?: string; headers?: Record<string, string> }>;
	setLastAssistantMessage(message: AssistantMessage): void;
	/** F3: record Fusion-stage token spend into the unified budget ledger. */
	recordFusionSpend?(tokens: number): void;
	/**
	 * Solo-equivalent context-economy preflight before Fusion stages: join any
	 * background compact, hard-threshold compact, then presend overflow with the
	 * pending user text in the wire estimate. Does not `agent.continue()` — that
	 * would start a solo turn before the panel.
	 */
	prepareFusionContextEconomy(pendingUserText: string): Promise<void>;
	/** Gate expensive Fusion stages when a goal token budget is exhausted. */
	evaluateFusionBudget(): SpawnBudgetDecision;
	/** Session permission checker for the verify subagent (optional in tests). */
	readonly permissionChecker?: PermissionChecker;
	/** Live wire-prefix estimate — gates the writer prefix-reuse path (same source the cache-keepalive uses). */
	getContextUsage(): ContextUsage | undefined;
	/**
	 * RAW per-session cache-retention option (undefined = provider default).
	 * Fusion's own provider calls resolve it themselves rather than inheriting the
	 * session's `streamFn`, so without this they would silently buy whatever tier
	 * the provider defaults to instead of the one the session chose. Optional: a
	 * host that omits it keeps exactly that provider default.
	 */
	getSessionCacheRetention?(): CacheRetention | undefined;
}

/** The retention Fusion's own provider calls should buy — the session's choice, or the provider default. */
function fusionCacheRetention(host: FusionHost): CacheRetention | undefined {
	return host.getSessionCacheRetention?.();
}

function recordFusionSpendTokens(host: FusionHost, tokens: number): void {
	if (tokens > 0) host.recordFusionSpend?.(tokens);
}

function recordFusionUsage(host: FusionHost, usage: Usage | undefined): void {
	recordFusionSpendTokens(host, consumedTokens(usage));
}

function recordFusionChars(host: FusionHost, promptChars: number, responseChars: number): void {
	recordFusionSpendTokens(host, estimateCharsAsTokens(promptChars + responseChars));
}

export function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

export function emitSyntheticAssistant(host: FusionHost, text: string): void {
	const model = host.model;
	const zeroUsage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const appMessage: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model?.api ?? "anthropic-messages",
		provider: model?.provider ?? "anthropic",
		model: model?.id ?? "fusion",
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
	host.agent.state.messages.push(appMessage);
	host.sessionManager.appendMessage(appMessage);
	host.setLastAssistantMessage(appMessage);
	host.emit({ type: "message_start", message: appMessage });
	host.emit({ type: "message_end", message: appMessage });
}

export function emitFusionUserMessage(host: FusionHost, text: string, images?: ImageContent[]): void {
	const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
	if (images && images.length > 0) content.push(...images);
	const userMessage: AgentMessage = { role: "user", content, timestamp: Date.now() };
	host.agent.state.messages.push(userMessage);
	host.sessionManager.appendMessage(userMessage);
	host.emit({ type: "message_start", message: userMessage });
	host.emit({ type: "message_end", message: userMessage });
}

export function emitFusionSummary(host: FusionHost, data: FusionSummaryData): void {
	const line = {
		role: "custom" as const,
		customType: "pit.fusion-summary",
		content: JSON.stringify(data),
		display: true,
		timestamp: Date.now(),
	};
	try {
		host.emit({ type: "message_start", message: line });
		host.emit({ type: "message_end", message: line });
	} catch {
		// summary render failure is non-fatal
	}
}

export function emitFusionNote(host: FusionHost, text: string): void {
	const line = {
		role: "custom" as const,
		customType: "pit.fusion-flow",
		content: text,
		display: true,
		timestamp: Date.now(),
	};
	try {
		host.emit({ type: "message_start", message: line });
		host.emit({ type: "message_end", message: line });
	} catch {
		// note render failure is non-fatal
	}
}

export async function streamFusionWriter(
	host: FusionHost,
	context: Context,
	opts: {
		apiKey?: string;
		headers?: Record<string, string>;
		signal?: AbortSignal;
		/** "none" ships the full tools block (prefix identity) while forbidding tool calls — prefix-reuse path. */
		toolChoice?: "auto" | "any" | "none";
		/** Session-chosen cache tier; undefined falls back to the provider default. */
		cacheRetention?: CacheRetention;
		/**
		 * Provider-side cache routing identity. Set ONLY on the prefix-reuse path,
		 * where the request really does ride the session's cached prefix — the
		 * legacy path ships its own system prompt and filtered history, so claiming
		 * the session's shard for it would route a different prefix there.
		 */
		promptCacheKey?: string;
		sessionId?: string;
	},
): Promise<string> {
	const model = host.model;
	if (!model) return "";
	const stream = streamSimple(model, context, opts);
	let started = false;
	const ensureStart = (partial: AssistantMessage): void => {
		if (started) return;
		started = true;
		host.emit({ type: "message_start", message: partial });
	};
	try {
		for await (const ev of stream) {
			if (ev.type === "start") {
				ensureStart(ev.partial);
			} else if (ev.type === "text_start" || ev.type === "text_delta" || ev.type === "text_end") {
				ensureStart(ev.partial);
				host.emit({ type: "message_update", message: ev.partial, assistantMessageEvent: ev });
			}
		}
	} catch {
		// Whatever the stream produced (or the error message it encoded) is finalized below.
	}
	const final = await stream.result();
	recordFusionUsage(host, final.usage);
	ensureStart(final);
	host.agent.state.messages.push(final);
	host.sessionManager.appendMessage(final);
	host.setLastAssistantMessage(final);
	host.emit({ type: "message_end", message: final });
	try {
		await checkCompaction(host.compaction, final, true, true);
	} catch {
		// non-fatal — the hard threshold check on the next turn is the fallback.
	}
	return assistantText(final);
}

/**
 * Wire-prefix floor below which reusing the session cache isn't worth it. Mirrors
 * the cache-keepalive floor (CACHE_KEEPALIVE_MIN_WIRE_TOKENS): both gate the same
 * "is the cacheable prefix large enough to bother" question.
 */
const FUSION_PREFIX_REUSE_MIN_WIRE_TOKENS = 15_000;

/**
 * Whether the writer should reuse the session's cached prefix (see
 * {@link buildWriterPrefixReuseContext}) instead of the legacy WRITER_SYSTEM +
 * filtered-history context. Any gate false → the byte-identical legacy path.
 * Kill-switch: PIT_NO_FUSION_PREFIX_REUSE.
 */
function shouldReuseWriterPrefix(host: FusionHost, writerModel: Model<any>): boolean {
	if (isTruthyEnvFlag(process.env.PIT_NO_FUSION_PREFIX_REUSE)) return false;
	const sessionModel = host.model;
	if (!sessionModel) return false;
	// The writer synthesizes with the session model, so its prefix is the session's
	// cached prefix only while provider+id match — a divergence would mean a
	// different cache key and no hit. Defensive: today they are always the same ref.
	if (writerModel.provider !== sessionModel.provider || writerModel.id !== sessionModel.id) return false;
	// toolChoice:"none" (full tools block for prefix identity, tool calls forbidden)
	// is only honored on the Anthropic route here.
	if (sessionModel.provider !== "anthropic") return false;
	// Trade arithmetic: the reused wire history (with tool results) is BIGGER than
	// the filtered user/assistant history the legacy path sends, but cached it
	// re-reads at ~0.1x while the smaller filtered history is UNCACHED at 1x. Reuse
	// only wins once the prefix is large — gate on the same wire floor as keepalive.
	const wireTokens = host.getContextUsage()?.wireTokens;
	return typeof wireTokens === "number" && wireTokens >= FUSION_PREFIX_REUSE_MIN_WIRE_TOKENS;
}

/**
 * Assemble the prefix-reuse writer context: the session's wire prefix (system
 * prompt + tools + full converted history, from core/wire-context.ts — the same
 * assembly the cache-keepalive ping and cache-aware compaction ride) shaped by one
 * trailing user block carrying the panel/judge/verify material. The shaping runs
 * BEFORE the lazy-tool-schema step so the tools block stays byte-identical (by
 * reference) to the session's cached prefix and cache-hits.
 */
function buildWriterContextForSession(
	host: FusionHost,
	results: PanelResult[],
	analysis: JudgeAnalysis,
	verification: VerificationReport | undefined,
): Promise<Context> {
	return buildWireContext(host.agent, (prefix) =>
		buildWriterPrefixReuseContext(results, analysis, verification, {
			systemPrompt: prefix.systemPrompt,
			messages: prefix.messages,
			// By reference: compactToolsForProviderContext memoizes on this array, so the
			// writer ships the very tools object a real turn does (cache identity).
			tools: prefix.tools,
		}),
	);
}

export async function fusionVerify(
	host: FusionHost,
	userPrompt: string,
	results: PanelResult[],
	analysis: JudgeAnalysis,
	model: Model<any>,
): Promise<VerificationReport | undefined> {
	host.emit({ type: "fusion_stage", stage: "verify", synthId: model.id });
	try {
		const result = await spawnSubagent(
			{
				registry: new SubagentRegistry(),
				model,
				modelRegistry: host.modelRegistry,
				availableTools: host.agent.state.tools as AgentTool[],
				convertToLlm: (m) => m as never,
				permissionChecker: host.permissionChecker,
			},
			{
				prompt: buildVerifierPrompt(userPrompt, results, analysis),
				systemPrompt: VERIFIER_SYSTEM_PROMPT,
				allowedTools: ["read", "grep", "find", "ls", "symbol", "find_symbol"],
				resultSchema: VERIFICATION_SCHEMA,
				cwd: host.cwd,
				timeoutMs: host.settingsManager.getFusionSettings().verifyTimeoutMs,
				maxTurns: 6,
				thinkingLevel: "medium",
				signal: host.fusionAbort?.signal,
				onSubagentEvent: (info) =>
					host.emit({ type: "fusion_verify_activity", turn: info.turn, tool: info.lastTool }),
			},
		);
		if (result.usage) recordFusionSpendTokens(host, result.usage.totalTokens);
		return result.value as VerificationReport | undefined;
	} catch (error) {
		const usage = getSubagentErrorUsage(error);
		if (usage) recordFusionSpendTokens(host, usage.totalTokens);
		return undefined;
	}
}

export async function runFusionSessionTurn(host: FusionHost, text: string, images?: ImageContent[]): Promise<boolean> {
	if (isTruthyEnvFlag(process.env.PIT_NO_FUSION)) return false;
	// Defensive backstop against a concurrent second Fusion turn: `host.fusionAbort`
	// is the live turn's controller. Starting another turn would overwrite it (Esc
	// then only aborts the newer one; the older panel runs to timeout) and interleave
	// transcript writes. With the synchronous reservation below, isFusing is already
	// true when a re-entrant prompt arrives, so the interactive submit guard routes it
	// to the follow-up queue and this backstop rarely fires. When it does (a direct
	// caller during the reserving turn's awaits — Bug 3b), enqueue the prompt as a
	// follow-up (with images) so it runs after the live turn instead of being silently
	// dropped; the live controller is left untouched and the turn is reported handled so
	// no concurrent solo turn starts.
	if (host.fusionAbort !== undefined) {
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images && images.length > 0) content.push(...images);
		host.agent.followUp({ role: "user", content, timestamp: Date.now() });
		return true;
	}
	const model = host.model;
	if (!model) return false;
	const settings = host.settingsManager.getFusionSettings();
	if (settings.panel.length < 2) {
		// No user message here on purpose: this branch returns false, so the caller
		// falls through to a normal solo turn which emits the user message itself.
		// Emitting it here too would duplicate it in the transcript.
		emitSyntheticAssistant(
			host,
			"Fusion is selected but the panel isn't configured (need 2 advisor models). " +
				"Run /fusion to pick them — this turn ran as a normal single-model turn.",
		);
		return false;
	}
	// Bug 3a — reserve the turn SYNCHRONOUSLY: create and register the abort controller
	// before the first await (prepareFusionContextEconomy / getRequiredRequestAuth /
	// getApiKeyForProvider) so `isFusing` (host.fusionAbort !== undefined) is true the
	// instant this function suspends. Otherwise a second prompt arriving mid-await would
	// see isFusing === false, route to Fusion again, and start a concurrent turn (or be
	// dropped by the backstop above). The synchronous early-returns above run BEFORE this,
	// so they never leave a stray controller; every path after it lives inside the try
	// whose finally clears it.
	const fusionAbort = new AbortController();
	// Local copy so the `catch` can read the abort state without touching
	// `host.fusionAbort` (a getter the double-start guard also tests).
	const fusionSignal = fusionAbort.signal;
	host.setFusionAbort(fusionAbort);
	let userMessageEmitted = false;
	const persistInterruptedTranscript = (): void => {
		if (userMessageEmitted) return;
		emitFusionUserMessage(host, text, images);
		userMessageEmitted = true;
		emitFusionNote(host, "Fusion interrupted.");
	};
	try {
		await host.prepareFusionContextEconomy(text);
		const budget = host.evaluateFusionBudget();
		if (!budget.allowed) {
			// This branch owns the turn (returns true, no solo fallthrough), so the user
			// message is Fusion's responsibility — emit it before the synthetic answer so
			// the transcript keeps user→assistant ordering (and the prompt isn't lost).
			emitFusionUserMessage(host, text, images);
			emitSyntheticAssistant(host, budget.reason ?? "Goal token budget exhausted — Fusion panel skipped.");
			return true;
		}
		const { apiKey, headers } = await host.getRequiredRequestAuth(model);
		const cliTokens = new Map<string, string | undefined>();
		for (const cli of new Set(settings.panel.map((m) => m.cli))) {
			const provider = providerForCli(cli);
			if (!provider) continue;
			try {
				cliTokens.set(cli, await host.modelRegistry.getApiKeyForProvider(provider));
			} catch {
				cliTokens.set(cli, undefined);
			}
		}
		const memberMetrics = new Map<number, { elapsedMs: number; chars: number; ok: boolean; error?: string }>();
		const buildSummaryMembers = (): FusionSummaryData["members"] =>
			settings.panel.map((m, i) => {
				const metric = memberMetrics.get(i);
				return {
					cli: m.cli,
					model: m.model,
					ok: metric?.ok ?? false,
					elapsedMs: metric?.elapsedMs ?? 0,
					chars: metric?.chars ?? 0,
					error: metric?.error,
				};
			});
		const synthesisItems: NonNullable<FusionSummaryData["synthesis"]> = [];

		let advisorPrompt = text;
		if (settings.brief !== false) {
			host.emit({ type: "fusion_stage", stage: "brief", synthId: model.id });
			try {
				const briefOut = await completeSimple(model, buildAdvisorBriefContext(text), {
					apiKey,
					headers,
					signal: fusionAbort.signal,
					cacheRetention: fusionCacheRetention(host),
				});
				recordFusionUsage(host, briefOut.usage);
				const brief = assistantText(briefOut).trim();
				if (brief) advisorPrompt = brief;
			} catch {
				// keep advisorPrompt = text
			}
			if (fusionAbort.signal.aborted) {
				persistInterruptedTranscript();
				return true;
			}
		}
		host.emit({ type: "fusion_stage", stage: "panel", synthId: model.id });
		const outcome = await runFusionTurn({
			userPrompt: text,
			panel: settings.panel,
			staggerSameCliMs: settings.staggerSameCliMs,
			signal: fusionAbort.signal,
			runMember: async (member) => {
				const index = settings.panel.indexOf(member);
				const started = Date.now();
				host.emit({
					type: "fusion_member",
					index,
					cli: member.cli,
					model: member.model,
					status: "running",
					elapsedMs: 0,
					timeoutMs: settings.timeoutMs,
					idleTimeoutMs: settings.idleTimeoutMs,
				});
				const r = await runPanelMember(member, {
					prompt: advisorPrompt,
					cwd: host.cwd,
					timeoutMs: settings.timeoutMs,
					idleTimeoutMs: settings.idleTimeoutMs,
					lean: settings.lean,
					signal: fusionAbort.signal,
					authToken: cliTokens.get(member.cli),
					onProgress: (p) => {
						host.emit({ type: "fusion_member_activity", index, kind: p.kind, tool: p.tool, text: p.text });
					},
				});
				const elapsedMs = Date.now() - started;
				const err = r.ok ? undefined : sliceSafe(r.error ?? "failed", 0, 160);
				memberMetrics.set(index, {
					elapsedMs,
					chars: r.ok ? r.text.length : 0,
					ok: r.ok,
					error: err,
				});
				if (r.ok) {
					if (r.tokens && r.tokens > 0) {
						recordFusionSpendTokens(host, r.tokens);
					} else {
						recordDiagnostic({
							category: "fusion.panel-char-estimate",
							level: "info",
							source: "fusion.session",
							context: { note: `${member.cli}:${member.model} chars=${r.text.length}` },
						});
						recordFusionChars(host, advisorPrompt.length, r.text.length);
					}
				}
				host.emit({
					type: "fusion_member",
					index,
					cli: member.cli,
					model: member.model,
					status: r.ok ? "done" : "failed",
					timeoutMs: settings.timeoutMs,
					idleTimeoutMs: settings.idleTimeoutMs,
					elapsedMs,
					chars: r.ok ? r.text.length : undefined,
					error: err,
				});
				return r;
			},
			runJudge: async (userPrompt, results) => {
				host.emit({ type: "fusion_stage", stage: "judge", synthId: model.id });
				const judgeOnce = async () => {
					const out = await completeSimple(model, buildJudgeContext(userPrompt, results), {
						apiKey,
						headers,
						signal: fusionAbort.signal,
						cacheRetention: fusionCacheRetention(host),
					});
					recordFusionUsage(host, out.usage);
					return parseJudgeOutput(assistantText(out));
				};
				let parsed = await judgeOnce();
				if (!parsed.ok) {
					recordDiagnostic({
						category: "fusion.judge-retry",
						level: "warn",
						source: "fusion.judge",
						context: { note: `${model.id}:parse-fail` },
					});
					parsed = await judgeOnce();
				}
				if (!parsed.ok) {
					emitFusionNote(
						host,
						"Fusion judge could not parse structured output — synthesizing without judge analysis.",
					);
					// undefined (not an empty analysis): the orchestrator must know the
					// judge FAILED so the verify stage still runs — an empty analysis
					// with judged=true would trip shouldSkipFusionVerify and drop the
					// fact-check exactly when the judge signal is absent.
					return undefined;
				}
				const analysis = parsed.value;
				if (settings.showSynthesis) {
					const collect = (
						kind: NonNullable<FusionSummaryData["synthesis"]>[number]["kind"],
						items: string[],
					): void => {
						for (const it of items) synthesisItems.push({ kind, text: sliceSafe(it, 0, 200) });
					};
					collect("consensus", analysis.consensus);
					collect("contradiction", analysis.contradictions);
					collect("partial", analysis.partialCoverage);
					collect("unique", analysis.uniqueInsights);
					collect("blind-spot", analysis.blindSpots);
				}
				return analysis;
			},
			verify: settings.verify
				? (userPrompt, results, analysis) => fusionVerify(host, userPrompt, results, analysis, model)
				: undefined,
			writer: async (userPrompt, results, analysis, verification) => {
				emitFusionUserMessage(host, userPrompt, images);
				userMessageEmitted = true;
				host.emit({ type: "fusion_stage", stage: "writer", synthId: model.id });
				const hasJudge =
					analysis.consensus.length > 0 ||
					analysis.contradictions.length > 0 ||
					analysis.partialCoverage.length > 0 ||
					analysis.uniqueInsights.length > 0 ||
					analysis.blindSpots.length > 0;
				const members = buildSummaryMembers();
				const okCount = members.filter((m) => m.ok).length;
				const summary: FusionSummaryData = {
					members,
					degraded: okCount < members.length ? "solo-synth" : "none",
					synthId: model.id,
				};
				if (hasJudge) {
					summary.judge = {
						consensus: analysis.consensus.length,
						contradictions: analysis.contradictions.length,
						partial: analysis.partialCoverage.length,
						unique: analysis.uniqueInsights.length,
						blindSpots: analysis.blindSpots.length,
					};
				}
				if (verification && verification.findings.length > 0) {
					summary.verification = {
						confirmed: verification.findings.filter((f) => f.verdict === "confirmed").length,
						refuted: verification.findings.filter((f) => f.verdict === "refuted").length,
						unverified: verification.findings.filter((f) => f.verdict === "unverified").length,
					};
				}
				if (settings.showSynthesis) summary.synthesis = synthesisItems;
				emitFusionSummary(host, summary);
				// Prefix-reuse path: reuse the session's cached prefix (system + tools +
				// history) so the synthesizer re-reads Anthropic's cache instead of
				// re-paying the filtered history uncached. Any gate false falls through
				// to the byte-identical legacy path below.
				if (shouldReuseWriterPrefix(host, model)) {
					const reuseContext = await buildWriterContextForSession(host, results, analysis, verification);
					return streamFusionWriter(host, reuseContext, {
						apiKey,
						headers,
						signal: fusionAbort.signal,
						toolChoice: "none",
						cacheRetention: fusionCacheRetention(host),
						// This request IS the session's prefix — route it to the same shard.
						promptCacheKey: host.agent.promptCacheKey,
						sessionId: host.agent.sessionId,
					});
				}
				const priorHistory = host.agent.state.messages
					.filter((m): m is Message => m.role === "user" || m.role === "assistant")
					.slice(0, -1);
				return streamFusionWriter(
					host,
					buildWriterContext(userPrompt, results, analysis, verification, priorHistory),
					{
						apiKey,
						headers,
						signal: fusionAbort.signal,
						// Retention follows the session policy on both paths; the routing
						// key does not — this context is a different prefix.
						cacheRetention: fusionCacheRetention(host),
					},
				);
			},
		});
		if (!outcome.handled) {
			if (fusionAbort.signal.aborted || host.userInterrupted) {
				persistInterruptedTranscript();
				return true;
			}
			const bothThrottled = outcome.degraded === "both-throttled";
			recordDiagnostic({
				category: "fusion.degraded",
				level: "warn",
				source: "fusion.session",
				context: { note: `${bothThrottled ? "both-throttled" : "both-failed"}:solo ${model.id}` },
			});
			const summaryMembers = buildSummaryMembers();
			emitFusionSummary(host, {
				members: summaryMembers,
				degraded: bothThrottled ? "both-throttled" : "both-failed",
				synthId: model.id,
			});
			if (bothThrottled) {
				emitFusionNote(
					host,
					`Both Fusion advisors were rate-limited — answering directly with ${model.id} (the synthesizer).`,
				);
			} else {
				const reasons = [...new Set(summaryMembers.map((m) => m.error).filter((e): e is string => Boolean(e)))];
				const why = reasons.length === 1 ? ` (${reasons[0]})` : "";
				emitFusionNote(
					host,
					`Both Fusion advisors failed${why} — answering directly with ${model.id} (the synthesizer).`,
				);
			}
			return false;
		}
		if (fusionAbort.signal.aborted || host.userInterrupted) {
			persistInterruptedTranscript();
		}
		return true;
	} catch {
		if (fusionSignal.aborted || host.userInterrupted) {
			persistInterruptedTranscript();
			return true;
		}
		return false;
	} finally {
		host.setFusionAbort(undefined);
	}
}
