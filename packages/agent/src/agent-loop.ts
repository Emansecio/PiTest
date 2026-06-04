/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	suggestClosest,
	type ToolResultMessage,
	validateToolArguments,
} from "@pit/ai";
import { appendHintsToContent } from "./tool-error-hint-registry.ts";
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
 * Default hard backstop on model turns per `runAgentLoop` invocation when a
 * caller does not set `config.maxTurns`. High enough to never bite a legitimate
 * task, finite enough to bound cost on a runaway loop the doom-loop detector
 * misses (it only catches identical consecutive calls, not A,B,A,B churn).
 */
const DEFAULT_MAX_TURNS = 250;

/** Sentinel returned by `streamAssistantResponse` when a TTSR rule fires. */
type TTSRInterrupt = { ttsr: TTSRMatchInfo };

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
	).then((messages) => {
		stream.end(messages);
	});

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
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

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
		messages: context.messages.concat(prompts),
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
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

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
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

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

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response. May return a TTSR interrupt; in that case
			// we inject a system-reminder and replay the same turn (capped by
			// MAX_TTSR_RETRIES_PER_TURN).
			let message: AssistantMessage;
			let ttsrRetries = 0;
			config.ttsrMatcher?.reset();
			while (true) {
				const response = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
				if (!("ttsr" in response)) {
					message = response;
					break;
				}
				if (ttsrRetries >= MAX_TTSR_RETRIES_PER_TURN) {
					// Bail: surface an aborted assistant message so the caller stops the turn.
					message = {
						role: "assistant",
						content: [{ type: "text", text: "" }],
						api: config.model.api,
						provider: config.model.provider,
						model: config.model.id,
						stopReason: "error",
						errorMessage: `TTSR: exceeded ${MAX_TTSR_RETRIES_PER_TURN} retries (rule "${response.ttsr.name}")`,
						timestamp: Date.now(),
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					} as AssistantMessage;
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
			}
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
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
				const executedToolBatch = await executeToolCalls(currentContext, message, toolCalls, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			const nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
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

			pendingMessages = (await config.getSteeringMessages?.()) || [];
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
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		stopReason: "error",
		errorMessage: `Reached the turn budget of ${maxTurns} turns in a single run; stopping to avoid an unbounded tool-call loop.`,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AssistantMessage;
}

/**
 * Build a synthetic user message carrying a TTSR reminder. The
 * `_ttsr_injected` flag is read by the compaction pipeline to preserve the
 * reminder verbatim instead of summarizing it.
 */
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
		enumerable: true,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(message, "_ttsr_rule", {
		value: info.name,
		enumerable: true,
		writable: false,
		configurable: false,
	});
	return message as unknown as AgentMessage;
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
): Promise<AssistantMessage | TTSRInterrupt> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	// Child abort controller so TTSR can cancel just this stream without
	// poisoning the outer agent signal. We forward outer abort into it but
	// never the reverse.
	const ttsrAbort = new AbortController();
	const forwardAbort = () => ttsrAbort.abort();
	if (signal) {
		if (signal.aborted) ttsrAbort.abort();
		else signal.addEventListener("abort", forwardAbort, { once: true });
	}
	let ttsrInterrupt: TTSRInterrupt | undefined;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal: ttsrAbort.signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

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

	const flushPendingDelta = async () => {
		if (!pendingDelta || !partialMessage) return;
		const e = pendingDelta;
		pendingDelta = undefined;
		await emit({
			type: "message_update",
			assistantMessageEvent: e as any,
			message: { ...partialMessage },
		});
		lastEmitTime = performance.now();
	};

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				lastEmitTime = performance.now();
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
					if (config.ttsrMatcher && !ttsrInterrupt) {
						const delta = (event as { delta?: string }).delta ?? "";
						let scope: "assistant_text" | "tool_args" | undefined;
						if (event.type === "text_delta") scope = "assistant_text";
						else if (event.type === "toolcall_delta") scope = "tool_args";
						if (scope) {
							const hit = config.ttsrMatcher.feed(delta, scope);
							if (hit) {
								ttsrInterrupt = { ttsr: { name: hit.name, message: hit.message } };
								ttsrAbort.abort();
							}
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
						await flushPendingDelta();
						pendingDelta = { ...event } as DeltaEvent;
					}
					if (performance.now() - lastEmitTime >= DELTA_THROTTLE_MS) {
						await flushPendingDelta();
					}
					if (ttsrInterrupt) {
						// Drop partial assistant message we pushed at "start".
						if (addedPartial) {
							context.messages.pop();
							addedPartial = false;
						}
						if (signal) signal.removeEventListener("abort", forwardAbort);
						return ttsrInterrupt;
					}
				}
				break;

			case "text_start":
			case "text_end":
			case "thinking_start":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_end":
				await flushPendingDelta();
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				await flushPendingDelta();
				if (ttsrInterrupt) {
					if (addedPartial) {
						context.messages.pop();
					}
					if (signal) signal.removeEventListener("abort", forwardAbort);
					return ttsrInterrupt;
				}
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				if (signal) signal.removeEventListener("abort", forwardAbort);
				return finalMessage;
			}
		}
	}
	await flushPendingDelta();

	if (ttsrInterrupt) {
		if (addedPartial) {
			context.messages.pop();
		}
		if (signal) signal.removeEventListener("abort", forwardAbort);
		return ttsrInterrupt;
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	if (signal) signal.removeEventListener("abort", forwardAbort);
	return finalMessage;
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

async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolMap = buildToolMap(currentContext.tools);
	// Short-circuit when execution mode is already forced sequential — avoids
	// the per-call toolMap.get() probe on every tool in the batch.
	const forceSequential = config.toolExecution === "sequential";
	const hasSequentialToolCall =
		forceSequential || toolCalls.some((tc) => toolMap.get(tc.name)?.executionMode === "sequential");
	if (hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, toolMap, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, toolMap, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

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
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit, config);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
				emit,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	toolMap: Map<string, AgentTool<any>>,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	// Run preparation in parallel: emit start + prepare per tool concurrently.
	// beforeToolCall hook (potentially IO) no longer serializes the batch.
	const preparations = await Promise.all(
		toolCalls.map(async (toolCall) => {
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
			return { toolCall, preparation };
		}),
	);

	const orderedFinalizedCalls = await Promise.all(
		preparations.map(async ({ toolCall, preparation }) => {
			if (preparation.kind === "immediate") {
				const finalized = {
					toolCall,
					result: preparation.result,
					isError: preparation.isError,
				} satisfies FinalizedToolCallOutcome;
				await emitToolExecutionEnd(finalized, emit);
				return finalized;
			}
			const executed = await executePreparedToolCall(preparation, signal, emit, config);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
				emit,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		}),
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

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
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

export function formatUnknownToolError(name: string, toolMap: Map<string, AgentTool<any>>): string {
	const available = Array.from(toolMap.keys()).sort();
	const suggestion = suggestToolName(name, available);
	const listed = available.slice(0, UNKNOWN_TOOL_MAX_LISTED).join(", ");
	const more =
		available.length > UNKNOWN_TOOL_MAX_LISTED ? `, … (${available.length - UNKNOWN_TOOL_MAX_LISTED} more)` : "";
	const availableSection = available.length > 0 ? `\nAvailable tools: ${listed}${more}.` : "";
	const suggestionSection = suggestion ? `\nDid you mean "${suggestion}"?` : "";
	return `Tool "${name}" not found.${availableSection}${suggestionSection}`;
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

		const validatedArgs = validateToolArguments(tool, activeToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall: activeToolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall: activeToolCall,
			tool,
			args: validatedArgs,
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
	const updateEvents: Promise<void>[] = [];

	let executeCtx: import("./types.ts").AgentToolExecuteContext | undefined;
	if (config.getToolExecuteContext) {
		try {
			executeCtx = config.getToolExecuteContext(prepared.toolCall);
		} catch {
			executeCtx = undefined;
		}
	}

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
			executeCtx,
		);
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		await Promise.all(updateEvents);
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

	// Tier 4: post-hoc error hint enrichment. Runs BEFORE `afterToolCall` so a
	// host that overrides the result via afterToolCall sees (and can mutate)
	// the hint-enriched content if desired. Skipped when the call succeeded;
	// the registry has nothing to add to a non-error result.
	if (isError && config.toolErrorHintRegistry) {
		const outcome = config.toolErrorHintRegistry.apply(prepared.toolCall, result);
		if (outcome.hints.length > 0) {
			result = { ...result, content: appendHintsToContent(result.content, outcome.hints) };
			await emit({
				type: "tool_error_hint_applied",
				toolCallId: prepared.toolCall.id,
				toolName: prepared.toolCall.name,
				hints: outcome.hints,
			});
		}
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
