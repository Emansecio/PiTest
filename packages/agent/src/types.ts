import type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	streamSimple,
	TextContent,
	Tool,
	ToolResultMessage,
} from "@pit/ai";
import type { Static, TSchema } from "typebox";
import type { ToolErrorHintRegistry } from "./tool-error-hint-registry.ts";
import type { ToolRewriteRegistry } from "./tool-rewrite-registry.ts";

/**
 * Stream function used by the agent loop.
 *
 * Contract:
 * - Must not throw or return a rejected promise for request/model/runtime failures.
 * - Must return an AssistantMessageEventStream.
 * - Failures must be encoded in the returned stream via protocol events and a
 *   final AssistantMessage with stopReason "error" or "aborted" and errorMessage.
 */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

/**
 * Configuration for how tool calls from a single assistant message are executed.
 *
 * - "sequential": each tool call is prepared, executed, and finalized before the next one starts.
 * - "parallel": tool calls are prepared sequentially, then allowed tools execute concurrently.
 *   `tool_execution_end` is emitted in tool completion order after each tool is finalized,
 *   while tool-result message artifacts are emitted later in assistant source order.
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * Controls how many queued user messages are injected when the agent loop reaches a queue drain point.
 *
 * - "all": drain and inject every queued message at that point.
 * - "one-at-a-time": drain and inject only the oldest queued message, leaving the rest queued for later drain points.
 */
export type QueueMode = "all" | "one-at-a-time";

/** A single tool call content block emitted by an assistant message. */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * Result returned from `beforeToolCall`.
 *
 * Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead.
 * `reason` becomes the text shown in that error result. If omitted, a default blocked message is used.
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/**
 * Partial override returned from `afterToolCall`.
 *
 * Merge semantics are field-by-field:
 * - `content`: if provided, replaces the tool result content array in full
 * - `details`: if provided, replaces the tool result details value in full
 * - `isError`: if provided, replaces the tool result error flag
 * - `terminate`: if provided, replaces the early-termination hint
 *
 * Omitted fields keep the original executed tool result values.
 * There is no deep merge for `content` or `details`.
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	/** Current agent context at the time the tool call is prepared. */
	context: AgentContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	/** The executed tool result before any `afterToolCall` overrides are applied. */
	result: AgentToolResult<any>;
	/** Whether the executed tool result is currently treated as an error. */
	isError: boolean;
	/** Current agent context at the time the tool call is finalized. */
	context: AgentContext;
}

/** Context passed to `shouldStopAfterTurn`. */
export interface ShouldStopAfterTurnContext {
	/** The assistant message that completed the turn. */
	message: AssistantMessage;
	/** Tool result messages passed to the preceding `turn_end` event. */
	toolResults: ToolResultMessage[];
	/** Current agent context after the turn's assistant message and tool results have been appended. */
	context: AgentContext;
	/** Messages that this loop invocation will return if it exits at this point. Prompt runs include the initial prompt messages; continuation runs do not include pre-existing context messages. */
	newMessages: AgentMessage[];
}

/** Replacement runtime state used by the agent loop before starting another provider request. */
export interface AgentLoopTurnUpdate {
	/** Context for the next provider request. */
	context?: AgentContext;
	/** Model for the next provider request. */
	model?: Model<any>;
	/** Thinking level for the next provider request. */
	thinkingLevel?: ThinkingLevel;
}

export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * Optional registry of per-tool abort controllers, keyed by tool-call id. The
	 * loop registers a controller for each executing tool — combined with the run
	 * signal via `AbortSignal.any`, so a run abort still cancels every tool — and
	 * removes it on completion. A holder of this map can abort ONE in-flight tool
	 * without aborting the whole run (per-tool interruption).
	 */
	toolAbortControllers?: Map<string, AbortController>;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * Contract: must not throw or reject. Return a safe fallback value instead.
	 * Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to the context before `convertToLlm`.
	 *
	 * Use this for operations that work at the AgentMessage level:
	 * - Context window management (pruning old messages)
	 * - Injecting context from external sources
	 *
	 * Contract: must not throw or reject. Return the original messages or another
	 * safe fallback value instead.
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Resolves an API key dynamically for each LLM call.
	 *
	 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
	 * during long-running tool execution phases.
	 *
	 * Contract: must not throw or reject. Return undefined when no key is available.
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * Called after each turn fully completes and `turn_end` has been emitted.
	 *
	 * If it returns true, the loop emits `agent_end` and exits before polling steering or follow-up queues,
	 * without starting another LLM call. The current assistant response and any tool executions finish normally.
	 *
	 * Use this to request a graceful stop after the current turn, e.g. before context gets too full.
	 *
	 * Contract: must not throw or reject. Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;

	/**
	 * Hard backstop on the number of model turns (assistant response + its tool
	 * batch) within a single `runAgentLoop` invocation. When reached, the loop
	 * stops and surfaces a terminal notice instead of continuing — a safety net
	 * against unbounded tool-call loops the doom-loop detector misses (it only
	 * catches *identical* consecutive calls, not alternating A,B,A,B churn).
	 *
	 * Defaults to `DEFAULT_MAX_TURNS` when unset. Callers that enforce their own
	 * per-turn cap (e.g. subagents via `shouldStopAfterTurn`) still get this as a
	 * second line of defense.
	 */
	maxTurns?: number;

	/**
	 * Called after `turn_end` and before the loop decides whether another provider request should start.
	 * Return replacement context/model/thinking state to affect the next turn in this run.
	 * Return undefined to keep using the current context/config.
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * Returns the current active tool surface, re-read at the start of every turn.
	 * Lets a tool activated mid-run (e.g. `search_tool_bm25` pulling a hidden tool
	 * onto the surface) become callable on the very next turn of the same run, not
	 * only the next run. Identity-stable: return the same array reference when
	 * nothing changed and the loop skips the swap.
	 */
	getActiveTools?: () => AgentTool<any>[];

	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called after the current assistant turn finishes executing its tool calls, unless `shouldStopAfterTurn` exits first.
	 * If messages are returned, they are added to the context before the next LLM call.
	 * Tool calls from the current assistant message are not skipped.
	 *
	 * Use this for "steering" the agent while it's working.
	 *
	 * Contract: must not throw or reject. Return [] when no steering messages are available.
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Returns follow-up messages to process after the agent would otherwise stop.
	 *
	 * Called when the agent has no more tool calls and no steering messages.
	 * If messages are returned, they're added to the context and the agent
	 * continues with another turn.
	 *
	 * Use this for follow-up messages that should wait until the agent finishes.
	 *
	 * Contract: must not throw or reject. Return [] when no follow-up messages are available.
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Returns passive messages to splice into the transcript at the next turn
	 * boundary WITHOUT forcing a turn.
	 *
	 * Unlike steering/follow-up messages, passive messages never keep the loop
	 * alive on their own: they are injected only when a turn is already going to
	 * run (the assistant still has tool calls), so the agent sees them as context
	 * but is never made to produce an extra turn for them. If the agent is about
	 * to stop, pending passive messages are simply left undrained. This makes it
	 * safe to deliver out-of-band notices (e.g. an inter-agent message) into a
	 * busy agent without corrupting the final assistant message it returns.
	 *
	 * Contract: must not throw or reject. Return [] when none are available.
	 */
	getPassiveMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Tool execution mode.
	 * - "sequential": execute tool calls one by one
	 * - "parallel": preflight tool calls sequentially, then execute allowed tools concurrently;
	 *   emit `tool_execution_end` in tool completion order after each tool is finalized,
	 *   then emit tool-result message artifacts later in assistant source order
	 *
	 * Default: "parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * Called before a tool is executed, after arguments have been validated.
	 *
	 * Return `{ block: true }` to prevent execution. The loop emits an error tool result instead.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * Called after a tool finishes executing, before `tool_execution_end` and tool-result message events are emitted.
	 *
	 * Return an `AfterToolCallResult` to override parts of the executed tool result:
	 * - `content` replaces the full content array
	 * - `details` replaces the full details payload
	 * - `isError` replaces the error flag
	 * - `terminate` replaces the early-termination hint
	 *
	 * Any omitted fields keep their original values. No deep merge is performed.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;

	/**
	 * Optional factory that builds the per-call execute context passed to
	 * `AgentTool.execute` as its 5th argument.
	 *
	 * Use this to plumb host-provided runtime services (e.g. a user-input bus)
	 * to tool implementations without changing tool signatures. Returning
	 * undefined skips passing a context.
	 *
	 * Contract: must not throw or reject. Return undefined on error.
	 */
	getToolExecuteContext?: (toolCall: AgentToolCall) => AgentToolExecuteContext | undefined;

	/**
	 * Optional Time-Traveling Stream Rules matcher.
	 *
	 * Fed with assistant text and tool-call argument deltas during streaming.
	 * On the first match the current stream is aborted and a synthetic
	 * `<system-reminder>` message is injected before the next request, so the
	 * model retries the same turn with a hindsight signal.
	 *
	 * Matcher state survives across retries within a turn; the agent loop caps
	 * the number of retries per turn to avoid pathological loops.
	 */
	ttsrMatcher?: TTSRMatcher;

	/**
	 * Optional registry of programmatic tool-call corrections applied between
	 * argument preparation and schema validation.
	 *
	 * See {@link ToolRewriteRegistry} for the rule shape. Auto-tier rules
	 * silently rewrite args; suggest/block-tier rules short-circuit the call
	 * with an actionable error result instead of executing the tool.
	 */
	toolRewriteRegistry?: ToolRewriteRegistry;

	/**
	 * Optional Tier 4 registry: post-hoc error hints appended to failing tool
	 * results before the LLM sees them. Never changes `isError`; only adds
	 * `[hint]` lines to the trailing text content so recovery is one
	 * round-trip away.
	 *
	 * See {@link ToolErrorHintRegistry}.
	 */
	toolErrorHintRegistry?: ToolErrorHintRegistry;

	/**
	 * "Repair Node" gate (already resolved for this run). When true, a SUCCESSFUL
	 * tool call whose arguments were silently auto-repaired (key alias, type
	 * coercion, array-from-string) gets a one-line `[repair]` note appended to its
	 * result describing the fix, so a weaker model emits the canonical shape next
	 * turn instead of repeating the malformed one. The host decides the value
	 * per-model (strong frontier models don't need the nudge; the note costs
	 * context) — see `AgentOptions.emitRepairNotes`. See {@link buildRepairNote}.
	 */
	emitRepairNotes?: boolean;
}

/**
 * Minimal matcher contract expected by the agent loop. The concrete
 * implementation lives in the coding-agent package; this interface keeps the
 * harness side decoupled from rule storage.
 */
export interface TTSRMatcher {
	feed(chunk: string, scope: "assistant_text" | "tool_args"): TTSRMatchInfo | undefined;
	reset(): void;
}

export interface TTSRMatchInfo {
	name: string;
	message: string;
}

/**
 * Thinking/reasoning level for models that support it.
 * Note: "xhigh" is only supported by selected model families. Use model thinking-level metadata
 * from @pit/ai to detect support for a concrete model.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@pituned/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// Empty by default - apps extend via declaration merging
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * Public agent state.
 *
 * `tools` and `messages` use accessor properties so implementations can copy
 * assigned arrays before storing them.
 */
export interface AgentState {
	/** System prompt sent with each model request. */
	systemPrompt: string;
	/** Active model used for future turns. */
	model: Model<any>;
	/** Requested reasoning level for future turns. */
	thinkingLevel: ThinkingLevel;
	/**
	 * Hard per-run turn budget. Forwarded to the loop's `maxTurns` backstop;
	 * undefined falls back to the loop default (DEFAULT_MAX_TURNS). Set by callers
	 * (e.g. the coordinator) that need a tighter cap than the default 250.
	 */
	maxTurns?: number;
	/** Available tools. Assigning a new array copies the top-level array. */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/** Conversation transcript. Assigning a new array copies the top-level array. */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * True while the agent is processing a prompt or continuation.
	 *
	 * This remains true until awaited `agent_end` listeners settle.
	 */
	readonly isStreaming: boolean;
	/** Partial assistant message for the current streamed response, if any. */
	readonly streamingMessage?: AgentMessage;
	/** Tool call ids currently executing. */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** Error message from the most recent failed or aborted assistant turn, if any. */
	readonly errorMessage?: string;
}

/** Final or partial result produced by a tool. */
export interface AgentToolResult<T> {
	/** Text or image content returned to the model. */
	content: (TextContent | ImageContent)[];
	/** Arbitrary structured details for logs or UI rendering. */
	details: T;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/** Callback used by tools to stream partial execution updates. */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/**
 * Optional context passed to `AgentTool.execute`.
 *
 * Fields are intentionally open and optional so existing tools that ignore the
 * context continue to compile. The agent loop populates whatever is wired in
 * by the host (e.g. a user-input bus for tools that need to ask the user a
 * structured question mid-turn).
 */
export interface AgentToolExecuteContext {
	/**
	 * Bus for tools that need to request structured input from the user
	 * during execution (e.g. the `ask` tool).
	 *
	 * Typed as `unknown` here to avoid a circular dep on the coding-agent
	 * package; consumers can narrow it via declaration merging or a cast.
	 */
	userInputBus?: unknown;
}

/** Tool definition used by the agent runtime. */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	/** Human-readable label for UI display. */
	label: string;
	/**
	 * Optional compatibility shim for raw tool-call arguments before schema validation.
	 * Must return an object that matches `TParameters`.
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/** Execute the tool call. Throw on failure instead of encoding errors in `content`. */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
		ctx?: AgentToolExecuteContext,
	) => Promise<AgentToolResult<TDetails>>;
	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool must execute one at a time with other tool calls.
	 * - "parallel": this tool can execute concurrently with other tool calls.
	 *
	 * If omitted, the default execution mode applies.
	 */
	executionMode?: ToolExecutionMode;
}

/** Context snapshot passed into the low-level agent loop. */
export interface AgentContext {
	/** System prompt included with the request. */
	systemPrompt: string;
	/** Transcript visible to the model. */
	messages: AgentMessage[];
	/** Tools available for this run. */
	tools?: AgentTool<any>[];
}

/**
 * Events emitted by the Agent for UI updates.
 *
 * `agent_end` is the last event emitted for a run, but awaited `Agent.subscribe()`
 * listeners for that event are still part of run settlement. The agent becomes
 * idle only after those listeners finish.
 */
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage }
	// Only emitted for assistant messages during streaming
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean }
	// Tool rewrite registry lifecycle. Emitted only when the registry actually
	// fires on a call — `auto` rules produce `tool_call_rewritten` after the
	// args have been rewritten (the call still proceeds to execute); `suggest`
	// and `block` rules produce `tool_call_rejected` instead of executing.
	| { type: "tool_call_rewritten"; toolCallId: string; toolName: string; ruleIds: string[]; args: any }
	| { type: "tool_call_rejected"; toolCallId: string; toolName: string; ruleId: string; error: string }
	// Tier 4: a post-hoc error hint registry rule fired and attached actionable
	// recovery text to a failed tool result. Fires only when isError === true
	// AND at least one hint rule matched. The `hints` array carries each
	// (ruleId, hint) pair that contributed.
	| {
			type: "tool_error_hint_applied";
			toolCallId: string;
			toolName: string;
			hints: Array<{ ruleId: string; hint: string }>;
	  };
