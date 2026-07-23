/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	iterateWithWallClock,
	RoundWallClockTimeoutError,
	recordDiagnostic,
	streamSimple,
	suggestClosest,
	type ToolResultMessage,
	validateToolArguments,
} from "@pit/ai";
import {
	buildOverthinkReminderMessage,
	type OverthinkGuardConfig,
	type OverthinkInterruptInfo,
	OverthinkTracker,
} from "./overthink-guard.ts";
import { repairToolArguments } from "./tool-arg-repair.ts";
import { appendHintsToContent } from "./tool-error-hint-registry.ts";
import { appendRepairNoteToContent, buildRepairNote } from "./tool-repair-note.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
	TTSRMatchInfo,
} from "./types.ts";

/** Max TTSR injections allowed within a single turn before bailing out. */
const MAX_TTSR_RETRIES_PER_TURN = 3;

/**
 * TTSR coalesced feed (on by default): instead of re-testing every rule against
 * the rolling buffer on each raw SSE delta (~4 chars), pending delta text is
 * accumulated per scope and fed to the matcher at the same 16ms boundary where
 * coalesced `message_update` events flush (~50–100× fewer regex passes). The
 * matcher's rolling buffer sees the identical character stream — feeds are
 * concatenative — so detection is unchanged, just delayed ≤16ms.
 * `PIT_NO_TTSR_COALESCED_FEED=1` restores the per-delta feed.
 */
function isTtsrCoalescedFeedDisabled(): boolean {
	const raw = typeof process !== "undefined" ? process.env.PIT_NO_TTSR_COALESCED_FEED : undefined;
	if (!raw) return false;
	const v = raw.toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

/**
 * Force-feed threshold for the pending per-scope TTSR text. The matcher keeps a
 * bounded rolling buffer (default 2048 chars, min 512 via PIT_TTSR_BUFFER_CHARS);
 * if a single coalesced feed were allowed to grow past it, a match completed
 * early in the window could be evicted before the flush ever tested it. Capping
 * each feed at 512 chars guarantees any match the per-delta feed would have
 * caught (up to buffer−512 chars long) is still tested while fully in-buffer.
 */
const TTSR_PENDING_FEED_CHARS = 512;

/**
 * Idle cap on the `transformContext` hook — the only otherwise-unbounded await
 * in the turn path. A hung hook wedges the whole turn (and the run) forever.
 * Default 60s; override via PIT_TRANSFORM_CONTEXT_TIMEOUT_MS; 0 disables the cap.
 * On timeout we THROW (never skip): a transform can be load-bearing, so silently
 * dropping it could send an unsafe context to the model. The throw takes the same
 * terminal-failure path as any transformContext rejection (see agentLoop's guard).
 */
const DEFAULT_TRANSFORM_CONTEXT_TIMEOUT_MS = 60_000;

function resolveTransformContextTimeoutMs(): number {
	const raw = typeof process !== "undefined" ? process.env.PIT_TRANSFORM_CONTEXT_TIMEOUT_MS : undefined;
	if (raw === undefined || raw === "") return DEFAULT_TRANSFORM_CONTEXT_TIMEOUT_MS;
	const parsed = Number(raw);
	// Non-numeric or negative falls back to the default; 0 disables (call site).
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TRANSFORM_CONTEXT_TIMEOUT_MS;
	return parsed;
}

/** Race a transformContext hook against its idle cap; reject (not skip) on timeout. */
async function withTransformContextTimeout(
	pending: Promise<AgentMessage[]>,
	timeoutMs: number,
): Promise<AgentMessage[]> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Swallow a late rejection from the hook after we've already timed out, so it
	// never surfaces as an unhandled rejection.
	pending.catch(() => {});
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(
				new Error(
					`transformContext hook timed out after ${timeoutMs}ms (set PIT_TRANSFORM_CONTEXT_TIMEOUT_MS to adjust, 0 to disable). The transform is load-bearing and was not skipped; failing the turn.`,
				),
			);
		}, timeoutMs);
		// Don't keep the event loop alive solely for this watchdog.
		(timer as { unref?: () => void }).unref?.();
	});
	try {
		return await Promise.race([pending, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Shared wall-clock race for load-bearing async boundaries that must not hang
 * the turn forever (convertToLlm, getApiKey). Same semantics as transformContext:
 * timeout fails the turn; late rejections are swallowed.
 */
async function withBoundaryTimeout<T>(pending: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	if (timeoutMs <= 0) return pending;
	pending.catch(() => {});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			pending,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					reject(
						new Error(
							`${label} timed out after ${timeoutMs}ms (set PIT_AGENT_BOUNDARY_TIMEOUT_MS to adjust, 0 to disable).`,
						),
					);
				}, timeoutMs);
				(timer as { unref?: () => void }).unref?.();
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

const DEFAULT_AGENT_BOUNDARY_TIMEOUT_MS = 60_000;

function resolveAgentBoundaryTimeoutMs(): number {
	const raw = typeof process !== "undefined" ? process.env.PIT_AGENT_BOUNDARY_TIMEOUT_MS : undefined;
	if (raw === undefined || raw === "") return DEFAULT_AGENT_BOUNDARY_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_AGENT_BOUNDARY_TIMEOUT_MS;
	return parsed;
}

/**
 * Non-rearming wall-clock cap on a single model round (one stream attempt).
 * The idle-timeout rearms on every chunk, so a stream kept alive by keepalives
 * or sparse deltas can pend for many minutes with no guard reacting — and in
 * headless runs (-p / benchmarks / orchestration) nobody is watching to hit Esc.
 * When the cap fires the stream is cancelled and the round fails with a
 * retryable error, taking the same retry/fallback path as an idle timeout.
 * Default is deliberately high (600s) so legitimate long reasoning never trips
 * it. Override with PIT_ROUND_WALL_CLOCK_MS (0 disables); kill-switch
 * PIT_NO_ROUND_WATCHDOG=1.
 */
const DEFAULT_ROUND_WALL_CLOCK_MS = 600_000;

function resolveRoundWallClockMs(configValue?: number): number {
	const disable = typeof process !== "undefined" ? process.env.PIT_NO_ROUND_WATCHDOG : undefined;
	if (disable) {
		const v = disable.toLowerCase();
		if (v === "1" || v === "true" || v === "yes") return 0;
	}
	if (typeof configValue === "number" && Number.isFinite(configValue) && configValue >= 0) {
		return configValue;
	}
	const raw = typeof process !== "undefined" ? process.env.PIT_ROUND_WALL_CLOCK_MS : undefined;
	if (raw === undefined || raw === "") return DEFAULT_ROUND_WALL_CLOCK_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_ROUND_WALL_CLOCK_MS;
	return parsed;
}

/**
 * Default hard backstop on model turns per `runAgentLoop` invocation when a
 * caller does not set `config.maxTurns`. High enough to never bite a legitimate
 * task, finite enough to bound cost on a runaway loop the doom-loop detector
 * misses (it only catches identical consecutive calls, not A,B,A,B churn).
 */
const DEFAULT_MAX_TURNS = 250;

/** Sentinel returned by `streamAssistantResponse` when a TTSR rule fires. */
type TTSRInterrupt = { ttsr: TTSRMatchInfo };

/** Sentinel returned when live thinking exceeds the overthink guard threshold. */
type OverthinkInterrupt = { overthink: OverthinkInterruptInfo };

type StreamInterrupt = TTSRInterrupt | OverthinkInterrupt;

function isStreamInterrupt(response: AssistantMessage | StreamInterrupt): response is StreamInterrupt {
	return "ttsr" in response || "overthink" in response;
}

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then(
		(messages) => {
			stream.end(messages);
		},
		// A rejection on the path to the first await (convertToLlm/transformContext
		// throwing, a custom streamFn throwing at construction, getSteeringMessages,
		// a faulty listener) would otherwise be an unhandled rejection — fatal under
		// Node's default — and leave the for-await consumer hung. Convert it into a
		// terminal failure turn so the consumer always sees an `agent_end`.
		(err) => {
			endStreamWithFailure(stream, config, err);
		},
	);

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
function assertContinuableContext(context: AgentContext): void {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}
	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}
}

export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	assertContinuableContext(context);

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then(
		(messages) => {
			stream.end(messages);
		},
		// Same rejection guard as agentLoop: surface a terminal failure turn instead
		// of letting the rejection go unhandled and hanging the consumer.
		(err) => {
			endStreamWithFailure(stream, config, err);
		},
	);

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = prompts.slice();
	const currentContext: AgentContext = {
		...context,
		messages: context.messages.slice().concat(prompts),
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	assertContinuableContext(context);

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context, messages: context.messages.slice() };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Build the terminal assistant message for a synchronous-path rejection (before
 * any event was emitted). Mirrors the TTSR-bail / turn-budget shape: a zero-usage
 * error turn carrying the failure reason, so the consumer learns *why* it failed
 * rather than the error being swallowed.
 */
// Zero-valued usage for synthetic error-turn messages (no tokens were spent).
// Factory (not a shared const) so each message gets its own object — no aliasing.
function makeZeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// Assemble the canonical zero-usage error turn shared by every synthetic
// failure path (sync-path rejection, TTSR-bail, turn-budget). Only the
// `errorMessage` differs between call-sites; the rest of the shape is fixed.
export function buildErrorTurn(model: AgentLoopConfig["model"], errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
		usage: makeZeroUsage(),
	} as AssistantMessage;
}

function buildFailureMessage(config: AgentLoopConfig, err: unknown): AssistantMessage {
	const errorMessage = err instanceof Error ? err.message : String(err);
	return buildErrorTurn(config.model, errorMessage);
}

/**
 * Terminate the stream after a rejection from the loop's promise. Pushes a
 * failure assistant turn and an `agent_end` (the stream's completion event, which
 * also resolves `result()`), then `end()` to release any waiting consumer.
 */
function endStreamWithFailure(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
	err: unknown,
): void {
	const message = buildFailureMessage(config, err);
	// Observe-only: the run rejected and we emit a failure turn; record the contained fault.
	const failNote = err instanceof Error ? err.message : String(err);
	recordDiagnostic({
		category: "error.isolated",
		level: "error",
		source: "agent-loop.endStreamWithFailure",
		context: { note: failNote.slice(0, 200) },
	});
	stream.push({ type: "message_start", message });
	stream.push({ type: "message_end", message });
	stream.push({ type: "turn_end", message, toolResults: [] });
	stream.push({ type: "agent_end", messages: [message] });
	stream.end([]);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// Hard backstop against unbounded tool-call loops (see DEFAULT_MAX_TURNS).
	const maxTurns = initialConfig.maxTurns ?? DEFAULT_MAX_TURNS;
	let turnCount = 0;
	// Check for steering messages at start (user may have typed while waiting)
	const drainSteering = async (): Promise<AgentMessage[]> => {
		const getSteering = config.getSteeringMessages ?? config.getQueuedMessages;
		return (await getSteering?.()) || [];
	};
	let pendingMessages: AgentMessage[] = await drainSteering();

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			// Turn budget exhausted: surface a terminal notice (never stop silently)
			// and end the run before issuing another model request.
			if (turnCount >= maxTurns) {
				const notice = buildTurnBudgetMessage(config, maxTurns);
				newMessages.push(notice);
				// Emit a turn_start for this notice turn so the terminal
				// turn_start/turn_end pair stays balanced (this block runs
				// before the normal turnCount++/turn_start below).
				await emit({ type: "turn_start" });
				await emit({ type: "message_start", message: notice });
				await emit({ type: "message_end", message: notice });
				await emit({ type: "turn_end", message: notice, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}
			turnCount++;
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response).
			// Passive messages ride along here too, but unlike steering they are
			// drained OUTSIDE the `while` condition, so they never keep the loop
			// alive on their own — they only land on a turn that is already going
			// to run (the assistant still had tool calls). That makes it safe to
			// deliver out-of-band notices into a busy agent without forcing an
			// extra turn or corrupting the final assistant message it returns.
			const passiveMessages = (await config.getPassiveMessages?.()) || [];
			const injectedMessages =
				passiveMessages.length > 0 ? pendingMessages.concat(passiveMessages) : pendingMessages;
			if (injectedMessages.length > 0) {
				for (const message of injectedMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Re-read the active tool surface: a prior turn may have pulled a hidden
			// tool onto it (e.g. search_tool_bm25 activation). state.tools is a fresh
			// array on change, so the identity check is a no-op when nothing moved;
			// when it differs we swap only tools and keep the live messages array.
			const liveTools = config.getActiveTools?.();
			if (liveTools && liveTools !== currentContext.tools) {
				currentContext = { ...currentContext, tools: liveTools };
			}

			// Stream assistant response. May return a TTSR or overthink interrupt; in
			// that case we inject a system-reminder and replay the same turn (each
			// guard has its own per-turn retry cap).
			let message: AssistantMessage;
			let ttsrRetries = 0;
			let overthinkRetries = 0;
			const overthinkGuard = config.overthinkGuard;
			const overthinkMaxRetries = overthinkGuard?.enabled ? overthinkGuard.maxRetriesPerTurn : 0;
			config.ttsrMatcher?.reset();
			// P1: one speculation scope per stream attempt. A retried attempt
			// (TTSR/overthink) discards the previous attempt's un-consumed
			// speculations at the top of the next iteration; the discards after the
			// tool batch / on the error-stop path reap whatever the executor did not
			// take (call absent from the final message, no tool calls, abort).
			let speculation: SpeculationController | undefined;
			while (true) {
				speculation?.discardLeftovers();
				speculation = new SpeculationController(currentContext, config, signal);
				let response: AssistantMessage | StreamInterrupt;
				try {
					response = await streamAssistantResponse(currentContext, config, signal, emit, streamFn, speculation);
				} catch (err) {
					speculation.discardLeftovers();
					throw err;
				}
				if (!isStreamInterrupt(response)) {
					message = response;
					break;
				}
				if ("ttsr" in response) {
					if (ttsrRetries >= MAX_TTSR_RETRIES_PER_TURN) {
						message = buildErrorTurn(
							config.model,
							`[stop: ttsr] TTSR: exceeded ${MAX_TTSR_RETRIES_PER_TURN} retries (rule "${response.ttsr.name}")`,
						);
						await emit({ type: "message_start", message });
						await emit({ type: "message_end", message });
						break;
					}
					ttsrRetries++;
					const reminder = buildTTSRReminderMessage(response.ttsr);
					currentContext.messages.push(reminder);
					newMessages.push(reminder);
					await emit({ type: "message_start", message: reminder });
					await emit({ type: "message_end", message: reminder });
					config.ttsrMatcher?.reset();
					continue;
				}
				if (overthinkRetries >= overthinkMaxRetries) {
					message = buildErrorTurn(
						config.model,
						`[stop: overthink] Exceeded ${overthinkMaxRetries} overthink guard retries (~${response.overthink.estimatedTokens} tokens, limit ~${response.overthink.threshold}).`,
					);
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					break;
				}
				overthinkRetries++;
				recordDiagnostic({
					category: "stream.overthink-guard",
					level: "info",
					source: "agent-loop.streamAssistantResponse",
					context: {
						attempt: overthinkRetries,
						note: `tokens~${response.overthink.estimatedTokens} threshold~${response.overthink.threshold}`,
					},
				});
				const reminder = buildOverthinkReminderMessage(response.overthink);
				currentContext.messages.push(reminder);
				newMessages.push(reminder);
				await emit({ type: "message_start", message: reminder });
				await emit({ type: "message_end", message: reminder });
			}
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				speculation?.discardLeftovers();
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls (single filter pass; passed into executeToolCalls
			// to avoid re-filtering the same content array there).
			const toolCalls = message.content.filter((c): c is AgentToolCall => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				const executedToolBatch = await executeToolCalls(
					currentContext,
					message,
					toolCalls,
					config,
					signal,
					emit,
					speculation,
				);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate && !signal?.aborted;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}
			// P1: reap speculations the executor did not consume (absent from the
			// final message, no tool calls at all, or a sequential-forced route).
			speculation?.discardLeftovers();

			await emit({ type: "turn_end", message, toolResults });

			if (signal?.aborted) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			const nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			// prepareNextTurn is bookkeeping (context economy). A throw must not
			// convert a successful assistant turn into a synthetic error turn.
			let nextTurnSnapshot: Awaited<ReturnType<NonNullable<AgentLoopConfig["prepareNextTurn"]>>> | undefined;
			try {
				nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
			} catch (err) {
				recordDiagnostic({
					category: "error.isolated",
					level: "warn",
					source: "agent-loop.prepareNextTurn",
					context: { note: err instanceof Error ? err.message : String(err) },
				});
				nextTurnSnapshot = undefined;
			}
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				let nextReasoning = config.reasoning;
				if (nextTurnSnapshot.thinkingLevel !== undefined) {
					nextReasoning = nextTurnSnapshot.thinkingLevel === "off" ? undefined : nextTurnSnapshot.thinkingLevel;
				}
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					reasoning: nextReasoning,
				};
			}

			if (
				await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				})
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages = await drainSteering();
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Build the terminal assistant message emitted when the per-run turn budget is
 * exhausted. Mirrors the TTSR-bail shape: a zero-usage error turn that stops the
 * loop with a clear, model- and user-visible reason instead of failing silently.
 */
function buildTurnBudgetMessage(config: AgentLoopConfig, maxTurns: number): AssistantMessage {
	return buildErrorTurn(
		config.model,
		`[stop: turn-budget] Reached the turn budget of ${maxTurns} turns in a single run; stopping to avoid an unbounded tool-call loop.`,
	);
}

/**
 * Build a synthetic user message carrying a TTSR reminder. The
 * `_ttsr_injected` marker is non-enumerable so session JSONL persistence
 * does not carry internal steering metadata.
 */
function resolveOverthinkGuard(config?: OverthinkGuardConfig): OverthinkGuardConfig {
	if (!config) {
		return { enabled: false, tokenThreshold: 0, maxRetriesPerTurn: 0 };
	}
	return config;
}

function buildTTSRReminderMessage(info: TTSRMatchInfo): AgentMessage {
	const text = `<system-reminder>[TTSR:${info.name}] ${info.message}</system-reminder>`;
	const message = {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
	};
	// Attach a non-enumerable marker without breaking strict typing; downstream
	// consumers introspect this via a runtime cast.
	Object.defineProperty(message, "_ttsr_injected", {
		value: true,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(message, "_ttsr_rule", {
		value: info.name,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	return message as unknown as AgentMessage;
}

function rollbackPartialContext(context: AgentContext, addedPartial: boolean): void {
	if (addedPartial) {
		context.messages.pop();
	}
}

/** Non-enumerable marker: TUI/agent cleanup only — never persist or retain in context. */
function markStreamGuardAbort(partialMessage: AssistantMessage): AssistantMessage {
	const message = {
		...partialMessage,
		stopReason: "aborted" as const,
		errorMessage: "Stream interrupted by guard",
	};
	Object.defineProperty(message, "_stream_guard_abort", {
		value: true,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	return message as AssistantMessage;
}

export function isStreamGuardAbortMessage(message: AgentMessage): boolean {
	return (message as { _stream_guard_abort?: boolean })._stream_guard_abort === true;
}

async function publishFinalAssistantMessage(
	context: AgentContext,
	finalMessage: AssistantMessage,
	addedPartial: boolean,
	emit: AgentEventSink,
): Promise<void> {
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 *
 * When a TTSR matcher is configured and one of its rules matches mid-stream,
 * this returns a `{ ttsr }` interrupt sentinel and removes any partial
 * assistant message it had pushed onto the context. The caller is responsible
 * for injecting a reminder and replaying the turn.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
	speculation?: SpeculationController,
): Promise<AssistantMessage | StreamInterrupt> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[]).
	// Bounded by an idle cap so a hung hook fails the turn instead of wedging it.
	let messages = context.messages;
	if (config.transformContext) {
		const timeoutMs = resolveTransformContextTimeoutMs();
		const pending = config.transformContext(messages, signal);
		messages = timeoutMs === 0 ? await pending : await withTransformContextTimeout(pending, timeoutMs);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[]).
	// Bound async custom converters so a never-settling promise cannot wedge the turn.
	const boundaryTimeoutMs = resolveAgentBoundaryTimeoutMs();
	const convertPending = Promise.resolve(config.convertToLlm(messages));
	const llmMessages = await withBoundaryTimeout(convertPending, boundaryTimeoutMs, "convertToLlm");

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens). Race abort + wall-clock so
	// a hung OAuth refresh cannot leave Esc looking dead for more than the cap.
	let resolvedApiKey = config.apiKey;
	if (config.getApiKey) {
		const keyPending = Promise.resolve(config.getApiKey(config.model.provider));
		const racedKey = await withBoundaryTimeout(
			signal
				? raceToolExecute(keyPending, signal).catch((err) => {
						// Re-throw abort; only use boundary timeout for true hangs.
						throw err;
					})
				: keyPending,
			boundaryTimeoutMs,
			"getApiKey",
		);
		resolvedApiKey = racedKey || config.apiKey;
	}

	// Child abort controller so TTSR can cancel just this stream without
	// poisoning the outer agent signal. We forward outer abort into it but
	// never the reverse.
	const ttsrAbort = new AbortController();
	const forwardAbort = () => ttsrAbort.abort();
	if (signal) {
		if (signal.aborted) ttsrAbort.abort();
		else signal.addEventListener("abort", forwardAbort, { once: true });
	}
	let streamInterrupt: StreamInterrupt | undefined;
	const overthinkGuard = resolveOverthinkGuard(config.overthinkGuard);
	const overthinkTracker = overthinkGuard.enabled
		? new OverthinkTracker(overthinkGuard.watchTextDelta === true)
		: undefined;

	// Hoisted out of the try so the round-watchdog catch below can publish a
	// clean error turn (replacing any partial message) and drain pending
	// coalesced updates before message_end.
	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;
	let drainStreamUpdates: (() => Promise<void>) | undefined;

	// Single cleanup point: every exit path (normal returns, TTSR interrupt, and
	// — the case the per-return removals missed — an exception from streamFunction,
	// response.result(), or the `for await`) runs the finally, so the abort
	// listener is never left attached to the outer run signal.
	try {
		const response = await streamFunction(config.model, llmContext, {
			...config,
			apiKey: resolvedApiKey,
			signal: ttsrAbort.signal,
		});

		// Delta coalescing: accumulate consecutive *_delta events of the same kind
		// and contentIndex, emitting at most once per 16ms (60fps frame budget).
		// Listeners that reconstruct text via `deltas.map(e => e.delta).join('')`
		// still see every character — just batched.
		type DeltaEvent = Extract<
			Awaited<ReturnType<typeof response.result>> extends infer _ ? Parameters<typeof emit>[0] : never,
			{ type: "message_update" }
		>["assistantMessageEvent"] & { delta: string; contentIndex: number };
		let pendingDelta: DeltaEvent | undefined;
		let lastEmitTime = 0;
		const DELTA_THROTTLE_MS = 16;

		// P04: serialize message_update emits on an ordered promise chain so a slow
		// listener cannot stall the SSE iterator, while still draining before
		// message_end / lifecycle boundaries (ordering preserved for TUI).
		let messageUpdateTail: Promise<void> = Promise.resolve();
		const enqueueMessageUpdate = (work: () => Promise<void>) => {
			messageUpdateTail = messageUpdateTail.then(work).catch(() => {});
		};
		const drainMessageUpdates = async () => {
			await messageUpdateTail;
		};

		// TTSR coalesced feed state (see isTtsrCoalescedFeedDisabled). Per-scope
		// pending text accumulates raw deltas and is fed to the matcher on the same
		// cadence the coalesced message_update flushes: 16ms window, delta-kind
		// change, stream boundaries, and the final drain (end of message / abort) —
		// so the tail remainder is always fed before the interrupt check runs.
		const ttsrCoalescedFeed = config.ttsrMatcher !== undefined && !isTtsrCoalescedFeedDisabled();
		let pendingTtsrText = "";
		let pendingTtsrToolArgs = "";

		const feedTtsr = (chunk: string, scope: "assistant_text" | "tool_args") => {
			if (!config.ttsrMatcher || streamInterrupt || !chunk) return;
			const hit = config.ttsrMatcher.feed(chunk, scope);
			if (hit) {
				streamInterrupt = { ttsr: { name: hit.name, message: hit.message } };
				ttsrAbort.abort();
			}
		};

		const flushPendingTtsr = () => {
			if (pendingTtsrText) {
				const chunk = pendingTtsrText;
				pendingTtsrText = "";
				feedTtsr(chunk, "assistant_text");
			}
			if (pendingTtsrToolArgs) {
				const chunk = pendingTtsrToolArgs;
				pendingTtsrToolArgs = "";
				feedTtsr(chunk, "tool_args");
			}
		};

		const flushPendingDelta = () => {
			// Feed the matcher BEFORE the early return below: thinking-only flushes
			// and the final drain must still deliver any pending scope text.
			flushPendingTtsr();
			if (!pendingDelta || !partialMessage) return;
			const e = pendingDelta;
			const message = { ...partialMessage };
			pendingDelta = undefined;
			enqueueMessageUpdate(async () => {
				await emit({
					type: "message_update",
					assistantMessageEvent: e as any,
					message,
				});
			});
			lastEmitTime = performance.now();
		};

		const flushAndDrainMessageUpdates = async () => {
			flushPendingDelta();
			await drainMessageUpdates();
		};
		drainStreamUpdates = flushAndDrainMessageUpdates;

		const finalizeStreamInterrupt = async (): Promise<StreamInterrupt> => {
			await flushAndDrainMessageUpdates();
			if (partialMessage && addedPartial) {
				rollbackPartialContext(context, addedPartial);
				addedPartial = false;
				await emit({ type: "message_end", message: markStreamGuardAbort(partialMessage) });
			}
			return streamInterrupt as StreamInterrupt;
		};

		// Round watchdog: hard wall-clock ceiling over the whole stream attempt.
		// Provider-agnostic on purpose — wrapping here covers every provider with
		// one guard instead of threading a second timeout through each SSE loop.
		const roundWallClockMs = resolveRoundWallClockMs(config.roundWallClockMs);
		const eventSource =
			roundWallClockMs > 0
				? iterateWithWallClock(response, {
						wallClockMs: roundWallClockMs,
						// Cancel just this stream (frees the socket); the outer run signal
						// stays clean so the session-level retry can start a fresh attempt.
						onTimeout: () => ttsrAbort.abort(),
					})
				: response;

		for await (const event of eventSource) {
			switch (event.type) {
				case "start":
					partialMessage = event.partial;
					context.messages.push(partialMessage);
					addedPartial = true;
					// Do NOT arm lastEmitTime here: leaving it at 0 makes the very first
					// delta's `now - lastEmitTime >= DELTA_THROTTLE_MS` check true, so first
					// paint flushes immediately instead of paying the coalescing window.
					// flushPendingDelta re-arms it on every flush, so later deltas are still
					// coalesced normally.
					await emit({ type: "message_start", message: { ...partialMessage } });
					break;

				case "text_delta":
				case "thinking_delta":
				case "toolcall_delta":
					if (partialMessage) {
						partialMessage = event.partial;
						context.messages[context.messages.length - 1] = partialMessage;
						// TTSR: feed text_delta into "assistant_text" scope, toolcall_delta
						// into "tool_args". thinking_delta is intentionally skipped — model
						// internal reasoning is not user-visible and should not trigger
						// hindsight rules.
						const delta = (event as { delta?: string }).delta ?? "";
						if (config.ttsrMatcher && !streamInterrupt) {
							let scope: "assistant_text" | "tool_args" | undefined;
							if (event.type === "text_delta") scope = "assistant_text";
							else if (event.type === "toolcall_delta") scope = "tool_args";
							if (scope) {
								if (!ttsrCoalescedFeed) {
									feedTtsr(delta, scope);
								} else if (scope === "assistant_text") {
									pendingTtsrText += delta;
									if (pendingTtsrText.length >= TTSR_PENDING_FEED_CHARS) flushPendingTtsr();
								} else {
									pendingTtsrToolArgs += delta;
									if (pendingTtsrToolArgs.length >= TTSR_PENDING_FEED_CHARS) flushPendingTtsr();
								}
							}
						}
						if (overthinkTracker && !streamInterrupt) {
							if (event.type === "thinking_delta") {
								overthinkTracker.onThinkingDelta(event.contentIndex, delta);
							} else if (event.type === "text_delta" && overthinkGuard.watchTextDelta) {
								overthinkTracker.onTextDelta(event.contentIndex, delta);
							}
							const overthinkInfo = overthinkTracker.getInterruptInfo(
								event.contentIndex,
								overthinkGuard.tokenThreshold,
							);
							if (overthinkInfo) {
								streamInterrupt = { overthink: overthinkInfo };
								ttsrAbort.abort();
							}
						}
						// Accumulate into pending delta if same kind+index, else flush and start anew.
						if (
							pendingDelta &&
							pendingDelta.type === event.type &&
							pendingDelta.contentIndex === event.contentIndex
						) {
							// Mutate the existing copy instead of re-spreading event on
							// every coalesced chunk (type+contentIndex already match).
							pendingDelta.delta += event.delta;
						} else {
							flushPendingDelta();
							pendingDelta = { ...event } as DeltaEvent;
						}
						if (performance.now() - lastEmitTime >= DELTA_THROTTLE_MS) {
							flushPendingDelta();
						}
						if (streamInterrupt) {
							return await finalizeStreamInterrupt();
						}
					}
					break;

				case "text_start":
				case "text_end":
				case "thinking_start":
				case "thinking_end":
				case "toolcall_start":
				case "toolcall_end":
					if (overthinkTracker) {
						if (event.type === "thinking_start") {
							overthinkTracker.onThinkingStart(event.contentIndex);
						} else if (event.type === "text_start" && overthinkGuard.watchTextDelta) {
							overthinkTracker.onTextStart(event.contentIndex);
						} else if (event.type === "toolcall_start") {
							overthinkTracker.onToolCallStart();
						}
					}
					// Drain coalesced deltas before the boundary update so TUI sees
					// ordered message_update events, then await the boundary itself.
					await flushAndDrainMessageUpdates();
					// The drain above also feeds pending TTSR text: a rule completed by
					// the tail of the block must interrupt here, exactly as the per-delta
					// feed would have inside the delta case.
					if (streamInterrupt) {
						return await finalizeStreamInterrupt();
					}
					if (partialMessage) {
						partialMessage = event.partial;
						context.messages[context.messages.length - 1] = partialMessage;
						await emit({
							type: "message_update",
							assistantMessageEvent: event,
							message: { ...partialMessage },
						});
						if (event.type === "toolcall_end") {
							// P1: this call's args are complete mid-stream — start the
							// speculative prepare+execute now (fire-and-forget; all gates
							// live inside maybeStart). Consumed post-stream by the executor.
							speculation?.maybeStart(event.toolCall as AgentToolCall, partialMessage);
						}
					}
					break;

				case "done":
				case "error": {
					await flushAndDrainMessageUpdates();
					if (streamInterrupt) {
						return await finalizeStreamInterrupt();
					}
					const finalMessage = await response.result();
					await publishFinalAssistantMessage(context, finalMessage, addedPartial, emit);
					return finalMessage;
				}
			}
		}
		await flushAndDrainMessageUpdates();

		if (streamInterrupt) {
			return await finalizeStreamInterrupt();
		}

		// Reaching here means the async iterator drained without the in-loop
		// `done`/`error` case ever firing (that path returns directly). The
		// StreamFn contract requires failures be encoded as a terminal
		// done/error event, but a custom streamFn or the proxy can call end()
		// to terminate the iterator WITHOUT pushing a terminal event. In that
		// case `result()` (EventStream.finalResultPromise) never resolves and
		// this await would hang the turn — and the whole run, since there is no
		// idle-timeout around it. Defensively detect that: once the iterator has
		// drained the stream is already internally `done`, so a legitimate
		// result has resolved within microtasks; race the await against a
		// deferred sentinel that only fires after a macrotask. If the sentinel
		// wins, result() can no longer resolve, so synthesize a failure turn
		// instead of deadlocking — matching how every other untrusted callback
		// path is converted into a terminal failure turn.
		const RESULT_PENDING = Symbol("result-pending");
		let sentinelTimer: ReturnType<typeof setTimeout> | undefined;
		const sentinel = new Promise<typeof RESULT_PENDING>((resolve) => {
			sentinelTimer = setTimeout(() => resolve(RESULT_PENDING), 0);
			// Don't keep the event loop alive solely for this watchdog.
			(sentinelTimer as { unref?: () => void }).unref?.();
		});
		const settled = await Promise.race([response.result(), sentinel]);
		if (sentinelTimer) clearTimeout(sentinelTimer);

		if (settled === RESULT_PENDING) {
			// Observe-only: the stream ended without a terminal event; record the
			// fault so a misbehaving streamFn is detectable in production.
			recordDiagnostic({
				category: "stream.missing-terminal",
				level: "warn",
				source: "agent-loop.streamAssistantResponse",
				context: { note: "stream ended without a terminal event" },
			});
			const errorTurn = buildErrorTurn(config.model, "Stream ended without a terminal event");
			await publishFinalAssistantMessage(context, errorTurn, addedPartial, emit);
			return errorTurn;
		}

		const finalMessage = settled;
		await publishFinalAssistantMessage(context, finalMessage, addedPartial, emit);
		return finalMessage;
	} catch (err) {
		if (err instanceof RoundWallClockTimeoutError) {
			// The round exceeded its wall-clock budget; onTimeout already aborted the
			// child stream (socket freed). Convert to a normal error turn — the
			// message contains "timed out", so the session's retryable matcher picks
			// it up and the standard retry/fallback path takes over, instead of the
			// run pending until an external orchestrator kills the process.
			await drainStreamUpdates?.().catch(() => {});
			const errorTurn = buildErrorTurn(config.model, err.message);
			await publishFinalAssistantMessage(context, errorTurn, addedPartial, emit);
			return errorTurn;
		}
		throw err;
	} finally {
		if (signal) signal.removeEventListener("abort", forwardAbort);
	}
}

/**
 * Execute tool calls from an assistant message.
 */
const toolMapCache = new WeakMap<AgentTool<any>[], Map<string, AgentTool<any>>>();

function buildToolMap(tools: AgentTool<any>[] | undefined): Map<string, AgentTool<any>> {
	if (!tools) return new Map();
	const cached = toolMapCache.get(tools);
	if (cached) return cached;
	const map = new Map<string, AgentTool<any>>();
	for (const tool of tools) {
		map.set(tool.name, tool);
	}
	toolMapCache.set(tools, map);
	return map;
}

/**
 * Kill-switch for the mixed-batch partition (Change 2). When set, a batch that
 * contains ANY sequential tool runs entirely through executeToolCallsSequential —
 * the pre-partition behavior — serializing the parallel-safe calls alongside the
 * sequential ones. `PIT_NO_BATCH_PARTITION=1` restores that.
 */
function isBatchPartitionDisabled(): boolean {
	const raw = typeof process !== "undefined" ? process.env.PIT_NO_BATCH_PARTITION : undefined;
	if (!raw) return false;
	const v = raw.toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	speculation?: SpeculationController,
): Promise<ExecutedToolCallBatch> {
	const toolMap = buildToolMap(currentContext.tools);
	// `toolExecution: "sequential"` forces the whole run serial — no partition,
	// no per-call probe. (Speculation never starts under these routes — the
	// maybeStart gates mirror this routing — so the sequential executors never
	// see a speculative entry; leftovers are reaped by the runLoop discard.)
	if (config.toolExecution === "sequential") {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, toolMap, config, signal, emit);
	}
	// Count sequential-mode calls to decide the routing:
	//  - none      → fully parallel (fast path).
	//  - all       → fully sequential (nothing to overlap; keep old semantics).
	//  - mixed     → partition, unless the kill-switch pins the old all-sequential path.
	let sequentialCount = 0;
	for (const tc of toolCalls) {
		if (toolMap.get(tc.name)?.executionMode === "sequential") sequentialCount++;
	}
	if (sequentialCount === 0) {
		return executeToolCallsParallel(
			currentContext,
			assistantMessage,
			toolCalls,
			toolMap,
			config,
			signal,
			emit,
			speculation,
		);
	}
	if (sequentialCount === toolCalls.length || isBatchPartitionDisabled()) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, toolMap, config, signal, emit);
	}
	return executeToolCallsPartitioned(
		currentContext,
		assistantMessage,
		toolCalls,
		toolMap,
		config,
		signal,
		emit,
		speculation,
	);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

/**
 * Build the abort signal a single tool executes under. When the config carries a
 * per-tool controller registry, register a fresh controller — combined with the
 * run signal via `AbortSignal.any`, so a run abort still cancels the tool — and
 * return a `release` that unregisters it. Without the registry the tool runs
 * under the run signal unchanged (no behavior change unless a caller opts in).
 */
function makePerToolSignal(
	toolCallId: string,
	runSignal: AbortSignal | undefined,
	config: AgentLoopConfig,
): { signal: AbortSignal | undefined; release: () => void } {
	const registry = config.toolAbortControllers;
	if (!registry) return { signal: runSignal, release: () => {} };
	const controller = new AbortController();
	registry.set(toolCallId, controller);
	const signal = runSignal ? AbortSignal.any([runSignal, controller.signal]) : controller.signal;
	return { signal, release: () => registry.delete(toolCallId) };
}

/**
 * P1 — speculative tool execution (docs/proposals/2026-07-22-propostas-fronteira.md).
 *
 * While the assistant message is still streaming, `toolcall_end` already
 * carries a completed tool call. For tools that opt in (`speculationSafe`,
 * never "sequential"-mode), the FULL prepare funnel (rewrite registry → repair
 * → validation → beforeToolCall guards) and the execute itself run
 * immediately, with every event they would emit buffered instead of emitted.
 * The post-stream executor consumes the settled outcome in the call's normal
 * position and replays the buffered events there — transcript order, guard
 * semantics (hooks fire exactly once) and stats accounting stay byte-identical
 * to the non-speculative flow; only the wall-clock start of the I/O moves
 * earlier, overlapping the tail of the stream.
 *
 * A speculation that is never consumed (stream interrupt/retry, abort, args
 * fingerprint mismatch, or the call absent from the final message) is
 * DISCARDED: buffered events are dropped and the tool's
 * `onSpeculationDiscarded` cleanup runs (e.g. the read tool un-records its
 * dedupe entry so a later legitimate identical read is not suppressed).
 * Kill-switch: `PIT_NO_SPECULATIVE_TOOLS=1`.
 */
function isSpeculativeToolsDisabled(): boolean {
	const raw = typeof process !== "undefined" ? process.env.PIT_NO_SPECULATIVE_TOOLS : undefined;
	if (!raw) return false;
	const v = raw.toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

function safeArgsFingerprint(args: unknown): string {
	try {
		return JSON.stringify(args) ?? "undefined";
	} catch {
		return "unserializable";
	}
}

type SpeculativeOutcome = {
	preparation: PreparedToolCall | ImmediateToolCallOutcome;
	/** Absent when the preparation short-circuited (immediate). */
	executed: ExecutedToolCallOutcome | undefined;
	/** Events the speculative run would have emitted, in order, for replay at consumption. */
	events: AgentEvent[];
};

type SpeculativeEntry = {
	toolCall: AgentToolCall;
	argsJson: string;
	outcome: Promise<SpeculativeOutcome>;
	release: () => void;
};

class SpeculationController {
	private readonly entries = new Map<string, SpeculativeEntry>();
	private toolMapMemo: Map<string, AgentTool<any>> | undefined;
	private readonly context: AgentContext;
	private readonly config: AgentLoopConfig;
	private readonly signal: AbortSignal | undefined;

	constructor(context: AgentContext, config: AgentLoopConfig, signal: AbortSignal | undefined) {
		this.context = context;
		this.config = config;
		this.signal = signal;
	}

	private toolMap(): Map<string, AgentTool<any>> {
		this.toolMapMemo ??= buildToolMap(this.context.tools);
		return this.toolMapMemo;
	}

	/** Fire-and-forget: start a speculative prepare+execute for a just-completed streamed call. */
	maybeStart(toolCall: AgentToolCall, partialMessage: AssistantMessage): void {
		if (isSpeculativeToolsDisabled() || isBatchPartitionDisabled()) return;
		if (this.config.toolExecution === "sequential") return;
		if (this.signal?.aborted || this.entries.has(toolCall.id)) return;
		const tool = this.toolMap().get(toolCall.name);
		if (!tool || tool.speculationSafe !== true || tool.executionMode === "sequential") return;
		if (this.config.canSpeculateToolCall?.(toolCall) === false) return;

		const { signal: toolSignal, release } = makePerToolSignal(toolCall.id, this.signal, this.config);
		const events: AgentEvent[] = [];
		const bufferEmit: AgentEventSink = (event) => {
			events.push(event);
		};
		const outcome = (async (): Promise<SpeculativeOutcome> => {
			const preparation = await prepareToolCall(
				this.context,
				partialMessage,
				toolCall,
				this.toolMap(),
				this.config,
				toolSignal,
				bufferEmit,
			);
			if (preparation.kind === "immediate") return { preparation, executed: undefined, events };
			const executed = await executePreparedToolCall(preparation, toolSignal, bufferEmit, this.config);
			return { preparation, executed, events };
		})();
		this.entries.set(toolCall.id, {
			toolCall,
			argsJson: safeArgsFingerprint(toolCall.arguments),
			outcome,
			release,
		});
	}

	/**
	 * Hand a speculation to the consuming executor. A name/args fingerprint
	 * mismatch against the FINAL message's call (provider edge) discards the
	 * entry and returns undefined so the normal path re-prepares from scratch.
	 * The caller owns `release()` after awaiting `outcome`.
	 */
	take(toolCall: AgentToolCall): SpeculativeEntry | undefined {
		const entry = this.entries.get(toolCall.id);
		if (!entry) return undefined;
		this.entries.delete(toolCall.id);
		if (entry.toolCall.name !== toolCall.name || entry.argsJson !== safeArgsFingerprint(toolCall.arguments)) {
			this.discardEntry(entry);
			return undefined;
		}
		return entry;
	}

	/** Reap every un-consumed speculation: drop buffered events, run per-tool cleanup. */
	discardLeftovers(): void {
		for (const entry of this.entries.values()) {
			this.discardEntry(entry);
		}
		this.entries.clear();
	}

	private discardEntry(entry: SpeculativeEntry): void {
		// Trip the per-tool controller (when a registry is wired) so an in-flight
		// execute stops doing work nobody will read; cleanup runs on settle.
		this.config.toolAbortControllers?.get(entry.toolCall.id)?.abort();
		void entry.outcome
			.then((outcome) => {
				entry.release();
				const tool = this.toolMap().get(entry.toolCall.name);
				const args = outcome.preparation.kind === "prepared" ? outcome.preparation.args : entry.toolCall.arguments;
				try {
					tool?.onSpeculationDiscarded?.(entry.toolCall.id, args);
				} catch {
					// Cleanup is best-effort; a throwing hook must never surface.
				}
			})
			.catch(() => entry.release());
	}
}

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	toolMap: Map<string, AgentTool<any>>,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(
			currentContext,
			assistantMessage,
			toolCall,
			toolMap,
			config,
			signal,
			emit,
		);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = await finalizeImmediatePreparation(toolCall, preparation, config, emit);
		} else {
			const { signal: toolSignal, release } = makePerToolSignal(toolCall.id, signal, config);
			try {
				const executed = await executePreparedToolCall(preparation, toolSignal, emit, config);
				finalized = await finalizeExecutedToolCall(
					currentContext,
					assistantMessage,
					preparation,
					executed,
					config,
					toolSignal,
					emit,
				);
			} finally {
				release();
			}
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			// Provider APIs require a tool result per tool call. Synthesize aborted
			// results for any remaining calls so the transcript stays consistent.
			const remaining = toolCalls.slice(finalizedCalls.length);
			for (const skipped of remaining) {
				await emit({
					type: "tool_execution_start",
					toolCallId: skipped.id,
					toolName: skipped.name,
					args: skipped.arguments,
				});
				const aborted: FinalizedToolCallOutcome = {
					toolCall: skipped,
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
				await emitToolExecutionEnd(aborted, emit);
				const abortedMessage = createToolResultMessage(aborted);
				await emitToolResultMessage(abortedMessage, emit);
				finalizedCalls.push(aborted);
				messages.push(abortedMessage);
			}
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

/** Phase-1 output shared by the two parallel executors. */
type PhaseOnePreparation = {
	toolCall: AgentToolCall;
	preparation: PreparedToolCall | ImmediateToolCallOutcome;
	/** Present when a speculative run already executed this call during the stream (P1). */
	specExecuted?: ExecutedToolCallOutcome;
};

/**
 * Phase 1 of the parallel executors: emit start, then either consume a settled
 * speculative run (replaying its buffered events in this call's normal
 * transcript position — consumption NEVER re-runs the prepare funnel, so hooks
 * with side effects fire exactly once) or run the normal prepare.
 */
async function prepareParallelCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	toolMap: Map<string, AgentTool<any>>,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	speculation: SpeculationController | undefined,
): Promise<PhaseOnePreparation> {
	await emit({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
	});
	const spec = speculation?.take(toolCall);
	if (spec) {
		const outcome = await spec.outcome;
		spec.release();
		for (const event of outcome.events) {
			await emit(event);
		}
		return { toolCall, preparation: outcome.preparation, specExecuted: outcome.executed };
	}
	const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, toolMap, config, signal, emit);
	return { toolCall, preparation };
}

/**
 * Phase 2 of the parallel executors: execute (unless a speculative run already
 * did) and finalize. Identical flow/emissions to the pre-P1 inline bodies.
 */
async function finalizeParallelCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	phaseOne: PhaseOnePreparation,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<FinalizedToolCallOutcome> {
	const { toolCall, preparation, specExecuted } = phaseOne;
	if (preparation.kind === "immediate") {
		const finalized = await finalizeImmediatePreparation(toolCall, preparation, config, emit);
		await emitToolExecutionEnd(finalized, emit);
		return finalized;
	}
	if (specExecuted) {
		// P1: executed during the stream; finalize in the normal position. The
		// speculative per-tool signal was already released at consumption.
		const finalized = await finalizeExecutedToolCall(
			currentContext,
			assistantMessage,
			preparation,
			specExecuted,
			config,
			signal,
			emit,
		);
		await emitToolExecutionEnd(finalized, emit);
		return finalized;
	}
	// Per-tool abort: run this tool under a signal that a single
	// cancelTool(id) can trip, while a run abort still cancels it
	// (AbortSignal.any inside makePerToolSignal).
	const { signal: toolSignal, release } = makePerToolSignal(toolCall.id, signal, config);
	try {
		const executed = await executePreparedToolCall(preparation, toolSignal, emit, config);
		const finalized = await finalizeExecutedToolCall(
			currentContext,
			assistantMessage,
			preparation,
			executed,
			config,
			toolSignal,
			emit,
		);
		await emitToolExecutionEnd(finalized, emit);
		return finalized;
	} finally {
		release();
	}
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	toolMap: Map<string, AgentTool<any>>,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	speculation?: SpeculationController,
): Promise<ExecutedToolCallBatch> {
	// Run preparation in parallel: emit start + prepare per tool concurrently.
	// beforeToolCall hook (potentially IO) no longer serializes the batch.
	const preparations = await Promise.all(
		toolCalls.map((toolCall) =>
			prepareParallelCall(currentContext, assistantMessage, toolCall, toolMap, config, signal, emit, speculation),
		),
	);

	const orderedFinalizedCalls = await Promise.all(
		preparations.map((phaseOne) =>
			finalizeParallelCall(currentContext, assistantMessage, phaseOne, config, signal, emit),
		),
	);
	const messages = orderedFinalizedCalls.map(createToolResultMessage);
	// Serial emit (not Promise.all): listeners persist messages by mutating the
	// session leaf pointer, so concurrent emits can interleave message_end events
	// and reorder tool results in the JSONL tree. Tool execution itself stays
	// parallel via the Promise.all above — only the result fan-out is ordered.
	for (const msg of messages) {
		await emitToolResultMessage(msg, emit);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

/**
 * Mixed-batch executor (Change 2): the batch contains both parallel-safe and
 * sequential-mode tools. Rather than serialize the whole batch because one tool
 * is sequential, split it:
 *   - parallel-safe subset → the parallel machinery (concurrent), and
 *   - sequential subset → serial, in its original relative order,
 * running the parallel subset to completion FIRST (design (a) — the safe default:
 * sequential mode exists for tools that must not interleave, so we never start a
 * sequential tool until the concurrent siblings have settled).
 *
 * Invariants preserved from the two single-mode paths:
 *   - Tool-RESULT message emission (message_start/message_end) is deferred and
 *     replayed in the ORIGINAL toolCall order, across both subsets, so the JSONL
 *     leaf-pointer ordering stays deterministic regardless of completion order.
 *   - Abort mid-sequential-subset synthesizes "Operation aborted" results for the
 *     still-unrun sequential tools, mirroring executeToolCallsSequential. (The
 *     parallel subset has already fully settled by then, so only trailing
 *     sequential slots can be unfilled.)
 */
async function executeToolCallsPartitioned(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	toolMap: Map<string, AgentTool<any>>,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	speculation?: SpeculationController,
): Promise<ExecutedToolCallBatch> {
	// Partition by original index so results can be re-interleaved afterward.
	const parallelIndices: number[] = [];
	const sequentialIndices: number[] = [];
	toolCalls.forEach((tc, i) => {
		if (toolMap.get(tc.name)?.executionMode === "sequential") sequentialIndices.push(i);
		else parallelIndices.push(i);
	});

	const finalizedByIndex = new Array<FinalizedToolCallOutcome | undefined>(toolCalls.length).fill(undefined);

	// --- Parallel-safe subset: same two-phase concurrency as executeToolCallsParallel,
	// minus the result-message emit (deferred to the merged replay below). ---
	const parallelCalls = parallelIndices.map((i) => toolCalls[i]);
	const preparations = await Promise.all(
		parallelCalls.map((toolCall) =>
			prepareParallelCall(currentContext, assistantMessage, toolCall, toolMap, config, signal, emit, speculation),
		),
	);
	const parallelFinalized = await Promise.all(
		preparations.map((phaseOne) =>
			finalizeParallelCall(currentContext, assistantMessage, phaseOne, config, signal, emit),
		),
	);
	parallelIndices.forEach((origIdx, k) => {
		finalizedByIndex[origIdx] = parallelFinalized[k];
	});

	// --- Sequential subset: serial, in original relative order, with early-abort. ---
	let aborted = false;
	for (const origIdx of sequentialIndices) {
		const toolCall = toolCalls[origIdx];
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const preparation = await prepareToolCall(
			currentContext,
			assistantMessage,
			toolCall,
			toolMap,
			config,
			signal,
			emit,
		);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = await finalizeImmediatePreparation(toolCall, preparation, config, emit);
		} else {
			const { signal: toolSignal, release } = makePerToolSignal(toolCall.id, signal, config);
			try {
				const executed = await executePreparedToolCall(preparation, toolSignal, emit, config);
				finalized = await finalizeExecutedToolCall(
					currentContext,
					assistantMessage,
					preparation,
					executed,
					config,
					toolSignal,
					emit,
				);
			} finally {
				release();
			}
		}
		await emitToolExecutionEnd(finalized, emit);
		finalizedByIndex[origIdx] = finalized;
		if (signal?.aborted) {
			aborted = true;
			break;
		}
	}

	// Abort synthesis: fill any still-unrun slots (only trailing sequential ones
	// can be empty — the parallel subset settled above) with aborted results, in
	// original order, mirroring executeToolCallsSequential.
	if (aborted) {
		for (let i = 0; i < toolCalls.length; i++) {
			if (finalizedByIndex[i]) continue;
			const skipped = toolCalls[i];
			await emit({
				type: "tool_execution_start",
				toolCallId: skipped.id,
				toolName: skipped.name,
				args: skipped.arguments,
			});
			const abortedOutcome: FinalizedToolCallOutcome = {
				toolCall: skipped,
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
			await emitToolExecutionEnd(abortedOutcome, emit);
			finalizedByIndex[i] = abortedOutcome;
		}
	}

	// Every slot is now filled. Replay result messages in ORIGINAL toolCall order.
	const orderedFinalized = finalizedByIndex as FinalizedToolCallOutcome[];
	const messages = orderedFinalized.map(createToolResultMessage);
	for (const msg of messages) {
		await emitToolResultMessage(msg, emit);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalized),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
	// Opt-in "Repair Node": a one-line note describing how the model's arguments
	// were auto-repaired, appended to the SUCCESSFUL result so a weaker model
	// learns the canonical shape. Only set when `config.emitRepairNotes` is on.
	repairNote?: string;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
	// Opt-out for Tier-4 hint enrichment: rewrite-registry rejections and abort
	// results are deliberate, self-contained messages — hints would be noise.
	skipHints?: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

async function finalizeImmediatePreparation(
	toolCall: AgentToolCall,
	preparation: ImmediateToolCallOutcome,
	config: AgentLoopConfig,
	emit: AgentEventSink,
): Promise<FinalizedToolCallOutcome> {
	let result = preparation.result;
	if (preparation.isError && !preparation.skipHints) {
		result = await applyToolErrorHints(toolCall, result, config, emit);
	}
	return {
		toolCall,
		result,
		isError: preparation.isError,
	};
}

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

// --- Unknown-tool error formatting --------------------------------------------
//
// When the LLM emits a tool name we don't recognize, returning the bare
// "Tool X not found" string leaves the model with no hint about what to do
// next, so it typically retries the same wrong name. Including the list of
// available tools and a Levenshtein-based "did you mean" suggestion gives the
// model the recovery signal it needs in a single round-trip.

const UNKNOWN_TOOL_MAX_LISTED = 16;
const UNKNOWN_TOOL_SUGGEST_MAX_DISTANCE = 3;
// Reject suggestions where the candidate name is wildly shorter than the
// queried name. "edit_file" should still find "edit", but "x" should not
// silently suggest "longest_tool_name".
const UNKNOWN_TOOL_PREFIX_MIN_OVERLAP = 3;

function suggestToolName(name: string, available: string[]): string | undefined {
	// Shared matcher in pi-ai. Note the affix condition there is `!includes`,
	// which is equivalent to the old `!startsWith && !endsWith && !includes`
	// (includes subsumes prefix/suffix), so behavior is preserved.
	return suggestClosest(name, available, {
		maxDistance: UNKNOWN_TOOL_SUGGEST_MAX_DISTANCE,
		prefixMinOverlap: UNKNOWN_TOOL_PREFIX_MIN_OVERLAP,
	});
}

/**
 * Optional hook to augment an unknown-tool error with a hint pointing at a
 * specialized tool that exists but is NOT in the active surface (e.g. the hidden
 * tool-discovery index in pi-coding-agent). Kept as an injected provider so this
 * package stays free of any dependency on the discovery index. The provider may
 * activate the matched tool as a side effect and should return the line to append
 * (or undefined when there is nothing relevant). Fail-open: a throw is swallowed.
 */
export type UnknownToolHintProvider = (name: string) => string | undefined;

let unknownToolHintProvider: UnknownToolHintProvider | undefined;

export function setUnknownToolHintProvider(provider: UnknownToolHintProvider | undefined): void {
	unknownToolHintProvider = provider;
}

export function formatUnknownToolError(name: string, toolMap: Map<string, AgentTool<any>>): string {
	const available = Array.from(toolMap.keys()).sort();
	const suggestion = suggestToolName(name, available);
	const listed = available.slice(0, UNKNOWN_TOOL_MAX_LISTED).join(", ");
	const more =
		available.length > UNKNOWN_TOOL_MAX_LISTED ? `, … (${available.length - UNKNOWN_TOOL_MAX_LISTED} more)` : "";
	const availableSection = available.length > 0 ? `\nAvailable tools: ${listed}${more}.` : "";
	const suggestionSection = suggestion ? `\nDid you mean "${suggestion}"?` : "";
	// A near-miss against an ACTIVE tool wins (the model just typoed); only reach
	// for the hidden index when no active tool was close enough.
	let hiddenSection = "";
	if (!suggestion && unknownToolHintProvider) {
		try {
			const hint = unknownToolHintProvider(name);
			if (hint) hiddenSection = `\n${hint}`;
		} catch {
			// Fail-open: a broken provider must never turn a recoverable error fatal.
		}
	}
	return `Tool "${name}" not found.${availableSection}${suggestionSection}${hiddenSection}`;
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

function trackArgsMutation<T>(args: T, onMutate: () => void): T {
	if (args === null || typeof args !== "object") return args;
	return new Proxy(args as object, {
		set(target, prop, value, receiver) {
			onMutate();
			return Reflect.set(target, prop, value, receiver);
		},
		deleteProperty(target, prop) {
			onMutate();
			return Reflect.deleteProperty(target, prop);
		},
	}) as T;
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	toolMap: Map<string, AgentTool<any>>,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = toolMap.get(toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(formatUnknownToolError(toolCall.name, toolMap)),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);

		// Programmatic rewrite layer: apply the registry between
		// `prepareArguments` (per-tool alias absorption) and TypeBox validation.
		// Auto rules silently rewrite args; suggest/block rules short-circuit
		// the call with an actionable error result so the model recovers in
		// one round-trip without ever executing the wrong call.
		let activeToolCall = preparedToolCall;
		if (config.toolRewriteRegistry) {
			const outcome = config.toolRewriteRegistry.apply(activeToolCall);
			if (outcome.kind === "rejected") {
				await emit({
					type: "tool_call_rejected",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					ruleId: outcome.ruleId,
					error: outcome.error,
				});
				return {
					kind: "immediate",
					result: createErrorToolResult(outcome.error),
					isError: true,
					skipHints: true,
				};
			}
			if (outcome.kind === "rewritten") {
				activeToolCall = outcome.call;
				await emit({
					type: "tool_call_rewritten",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					ruleIds: outcome.ruleIds,
					args: activeToolCall.arguments,
				});
			}
		}

		// Tool-call JSON repair + schema coercion (native, default-on; kill-switch
		// PIT_NO_TOOLCALL_REPAIR=1). Runs AFTER the curated rewrite registry (which
		// wins) and BEFORE TypeBox validation: malformed/type-mismatched args are
		// silently fixed so the call doesn't fail and burn a model round-trip.
		// Returns the same `arguments` reference when nothing changed, so the
		// validate fast-path and the repair-note diff (`toolCall.arguments` vs
		// `finalArgs`) are unaffected on the common well-formed path.
		const repaired = repairToolArguments(activeToolCall.arguments, tool.parameters, tool.name);
		if (repaired.args !== activeToolCall.arguments) {
			activeToolCall = { ...activeToolCall, arguments: repaired.args as Record<string, any> };
		}

		let finalArgs = validateToolArguments(tool, activeToolCall);
		if (config.beforeToolCall) {
			const argsMutation = { mutated: false };
			const markArgsMutated = () => {
				argsMutation.mutated = true;
			};
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall: activeToolCall,
					args: trackArgsMutation(finalArgs, markArgsMutated),
					context: currentContext,
					argsMutation,
					markArgsMutated,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
					skipHints: true,
				};
			}
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
			// Revalidate only when a hook flagged a mutation (the Proxy set/delete
			// trap or an explicit markArgsMutated call — those ARE the mutation
			// detector). No args fingerprint is computed on either path: the
			// `validator.Check` fast path inside validateToolArguments makes the
			// "flagged but value unchanged" case ~µs and returns the same reference,
			// while the previous always-computed "before" fingerprint cost ~1ms/MB
			// of args on EVERY hooked tool call (i.e. all of them under AgentSession).
			if (argsMutation.mutated) {
				try {
					finalArgs = validateToolArguments(tool, { ...activeToolCall, arguments: finalArgs });
				} catch (revalidationError) {
					const detail =
						revalidationError instanceof Error ? revalidationError.message : String(revalidationError);
					return {
						kind: "immediate",
						result: createErrorToolResult(`Tool arguments became invalid after a guard mutation: ${detail}`),
						isError: true,
					};
				}
			}
		}
		// Repair Node (opt-in): compare what the model SENT against what actually
		// runs (post alias/rewrite/coercion). A reportable difference becomes a
		// note appended to the successful result below.
		const repairNote = config.emitRepairNotes ? buildRepairNote(toolCall.arguments, finalArgs) : undefined;
		return {
			kind: "prepared",
			toolCall: activeToolCall,
			tool,
			args: finalArgs,
			repairNote,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	config: AgentLoopConfig,
): Promise<ExecutedToolCallOutcome> {
	// Only retain in-flight update emits; each removes itself on settle so a
	// long-running tool streaming thousands of updates doesn't accumulate
	// settled promises for the life of the process.
	const pendingUpdates = new Set<Promise<void>>();

	let executeCtx: import("./types.ts").AgentToolExecuteContext | undefined;
	if (config.getToolExecuteContext) {
		try {
			executeCtx = config.getToolExecuteContext(prepared.toolCall);
		} catch {
			executeCtx = undefined;
		}
	}

	try {
		// Race execute against the run abort signal so a tool that ignores
		// `signal` cannot wedge the whole turn forever after Esc/interrupt.
		// The tool keeps running detached on abort (we cannot force-cancel
		// arbitrary extension code); we only unblock the loop.
		const executePromise = prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				const p = Promise.resolve(
					emit({
						type: "tool_execution_update",
						toolCallId: prepared.toolCall.id,
						toolName: prepared.toolCall.name,
						args: prepared.toolCall.arguments,
						partialResult,
					}),
				).finally(() => pendingUpdates.delete(p));
				pendingUpdates.add(p);
			},
			executeCtx,
		);
		const result = await raceToolExecute(executePromise, signal);
		await Promise.allSettled(pendingUpdates);
		// A tool can fail by RETURNING `isError: true` instead of throwing (todo,
		// plan, chrome_devtools, web_search, ...). Fold that into the loop-level
		// flag — otherwise returned failures read as successes to error hints,
		// doom-loop/failure budgets and the model-facing isError marker, while the
		// TUI (which reads result.isError directly) shows the same call as failed.
		return { result, isError: result.isError === true };
	} catch (error) {
		await Promise.allSettled(pendingUpdates);
		// Generic convention: an error may attach a structured `detail` field
		// (HashlineEditError does); carry it through to the result so hint rules
		// get the structured data, not just the flattened message string.
		const detail =
			error && typeof error === "object" && "detail" in error ? (error as { detail?: unknown }).detail : undefined;
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error), detail),
			isError: true,
		};
	}
}

/**
 * Unblock tool.execute when the run AbortSignal fires even if the tool never
 * observes it. Late rejections from the abandoned execute are swallowed.
 */
function raceToolExecute<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		promise.then(undefined, () => {});
		return Promise.reject(new Error("Request was aborted"));
	}
	let onAbort: (() => void) | undefined;
	const abortPromise = new Promise<never>((_resolve, reject) => {
		onAbort = () => {
			promise.then(undefined, () => {});
			reject(new Error("Request was aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
	return Promise.race([promise, abortPromise]).finally(() => {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	});
}

// Tier 4: post-hoc error hint enrichment, shared by the prepared-call
// finalizer and the immediate-error branches (validation failures, unknown
// tools, beforeToolCall blocks). Returns the result unchanged when no rule
// fires; emits `tool_error_hint_applied` when at least one does.
async function applyToolErrorHints(
	toolCall: AgentToolCall,
	result: AgentToolResult<any>,
	config: AgentLoopConfig,
	emit: AgentEventSink,
): Promise<AgentToolResult<any>> {
	if (!config.toolErrorHintRegistry) return result;
	const outcome = config.toolErrorHintRegistry.apply(toolCall, result);
	if (outcome.hints.length === 0) return result;
	// Telemetry (Band C / C3): record each fired hint rule on the diagnostics
	// channel with its stable rule id + tool name, so a per-session tally can
	// surface dead (never-firing) or noisy rules. recordDiagnostic is O(1) and
	// never throws — observe-only, never load-bearing on the enrichment path.
	for (const fired of outcome.hints) {
		recordDiagnostic({
			category: "hint.fired",
			level: "info",
			source: "agent-loop.applyToolErrorHints",
			context: { ruleId: fired.ruleId, toolName: toolCall.name, toolCallId: toolCall.id },
		});
	}
	const enriched = { ...result, content: appendHintsToContent(result.content, outcome.hints) };
	await emit({
		type: "tool_error_hint_applied",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		hints: outcome.hints,
	});
	return enriched;
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	// Tier 4: runs BEFORE `afterToolCall` so a host that overrides the result
	// via afterToolCall sees (and can mutate) the hint-enriched content if
	// desired. Skipped when the call succeeded; the registry has nothing to
	// add to a non-error result.
	if (isError) {
		result = await applyToolErrorHints(prepared.toolCall, result, config, emit);
	} else if (prepared.repairNote) {
		// Repair Node: surface the auto-repair on the successful result so a weaker
		// model self-corrects next turn. Success-only — a failing call gets the
		// richer Tier-4 hint instead. Runs before afterToolCall so a host override
		// sees the annotated content.
		result = { ...result, content: appendRepairNoteToContent(result.content, prepared.repairNote) };
	}

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string, detail?: unknown): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		// A thrown error may carry a structured `detail` (e.g. HashlineEditError);
		// preserve it under `details.detail` so Tier-4 hint rules can read the
		// structured payload instead of regex-scraping the rendered message.
		details: detail === undefined ? {} : { detail },
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		details: finalized.result.details,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
