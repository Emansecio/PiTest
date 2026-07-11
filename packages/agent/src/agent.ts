import {
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
	type TextContent,
	type ThinkingBudgets,
	type Transport,
} from "@pit/ai";
import { buildErrorTurn, isStreamGuardAbortMessage, runAgentLoop, runAgentLoopContinue } from "./agent-loop.ts";
import type { OverthinkGuardConfig } from "./overthink-guard.ts";
import type { ToolErrorHintRegistry } from "./tool-error-hint-registry.ts";
import type { ToolRewriteRegistry } from "./tool-rewrite-registry.ts";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	PrepareNextTurnContext,
	QueueMode,
	StreamFn,
	ToolExecutionMode,
	TTSRMatcher,
} from "./types.ts";

export type { QueueMode } from "./types.ts";

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
} satisfies Model<any>;

type MutableAgentState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
};

function createMutableAgentState(
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>,
): MutableAgentState {
	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];

	return {
		systemPrompt: initialState?.systemPrompt ?? "",
		model: initialState?.model ?? DEFAULT_MODEL,
		thinkingLevel: initialState?.thinkingLevel ?? "off",
		maxTurns: initialState?.maxTurns,
		get tools() {
			return tools;
		},
		set tools(nextTools: AgentTool<any>[]) {
			tools = nextTools.slice();
		},
		get messages() {
			return messages;
		},
		set messages(nextMessages: AgentMessage[]) {
			messages = nextMessages.slice();
		},
		isStreaming: false,
		streamingMessage: undefined,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	};
}

/** Options for constructing an {@link Agent}. */
export interface AgentOptions {
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>;
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	streamFn?: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	sessionId?: string;
	thinkingBudgets?: ThinkingBudgets;
	transport?: Transport;
	maxRetryDelayMs?: number;
	/**
	 * Body idle-timeout override forwarded to the stream function. Mutable so the
	 * host can raise it per retry (see AgentSession's idle-timeout adaptive backoff);
	 * undefined lets the stream function fall back to its configured default.
	 */
	idleTimeoutMs?: number;
	toolExecution?: ToolExecutionMode;
	/** Time-Traveling Stream Rules matcher. Passed through to the loop config. */
	ttsrMatcher?: TTSRMatcher;
	/**
	 * Live overthink guard policy, evaluated against the current model each run.
	 */
	getOverthinkGuard?: (
		model: { provider: string; reasoning?: boolean },
		thinkingLevel: import("./types.ts").ThinkingLevel | undefined,
	) => OverthinkGuardConfig;
	/**
	 * Optional tool rewrite registry. Forwarded into the loop config so every
	 * incoming tool call is run through it between argument preparation and
	 * schema validation.
	 */
	toolRewriteRegistry?: ToolRewriteRegistry;
	/** Optional Tier 4 error-hint registry — see {@link AgentLoopConfig.toolErrorHintRegistry}. */
	toolErrorHintRegistry?: ToolErrorHintRegistry;
	/**
	 * Opt-in Repair Node — see {@link AgentLoopConfig.emitRepairNotes}. Either a
	 * static boolean, or a policy evaluated against the current model each run so
	 * the gate auto-tracks a model change (fallback chain / `/model`).
	 */
	emitRepairNotes?: boolean | ((model: { provider: string; id?: string }) => boolean);
}

class PendingMessageQueue {
	private messages: AgentMessage[] = [];
	public mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(message: AgentMessage): void {
		this.messages.push(message);
	}

	/** Prepend so the message drains before older queued steers (critical recovery). */
	enqueueFront(message: AgentMessage): void {
		this.messages.unshift(message);
	}

	hasItems(): boolean {
		return this.messages.length > 0;
	}

	drain(): AgentMessage[] {
		if (this.mode === "all") {
			const drained = this.messages;
			this.messages = [];
			return drained;
		}

		const first = this.messages.shift();
		if (!first) {
			return [];
		}
		return [first];
	}

	clear(): void {
		this.messages = [];
	}
}

type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
};

/**
 * Stateful wrapper around the low-level agent loop.
 *
 * `Agent` owns the current transcript, emits lifecycle events, executes tools,
 * and exposes queueing APIs for steering and follow-up messages.
 */
export class Agent {
	private _state: MutableAgentState;
	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;
	private readonly passiveQueue: PendingMessageQueue;

	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	public streamFn: StreamFn;
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	public onPayload?: SimpleStreamOptions["onPayload"];
	public onResponse?: SimpleStreamOptions["onResponse"];
	public beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	public afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
	public prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	private activeRun?: ActiveRun;
	/** Session identifier forwarded to providers for cache-aware backends. */
	public sessionId?: string;
	/** Optional per-level thinking token budgets forwarded to the stream function. */
	public thinkingBudgets?: ThinkingBudgets;
	/** Preferred transport forwarded to the stream function. */
	public transport: Transport;
	/** Optional cap for provider-requested retry delays. */
	public maxRetryDelayMs?: number;
	/** Body idle-timeout override forwarded to the stream function; see AgentOptions. */
	public idleTimeoutMs?: number;
	/** Tool execution strategy for assistant messages that contain multiple tool calls. */
	public toolExecution: ToolExecutionMode;
	/** Optional Time-Traveling Stream Rules matcher. */
	public ttsrMatcher?: TTSRMatcher;
	/** Live overthink guard policy — see {@link AgentOptions.getOverthinkGuard}. */
	public getOverthinkGuard?: AgentOptions["getOverthinkGuard"];
	/** Optional tool rewrite registry — see {@link AgentOptions.toolRewriteRegistry}. */
	public toolRewriteRegistry?: ToolRewriteRegistry;
	/** Optional Tier 4 error-hint registry — see {@link AgentOptions.toolErrorHintRegistry}. */
	public toolErrorHintRegistry?: ToolErrorHintRegistry;
	/** Opt-in Repair Node policy — see {@link AgentOptions.emitRepairNotes}. */
	public emitRepairNotes?: boolean | ((model: { provider: string; id?: string }) => boolean);

	constructor(options: AgentOptions = {}) {
		this._state = createMutableAgentState(options.initialState);
		this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
		this.transformContext = options.transformContext;
		this.streamFn = options.streamFn ?? streamSimple;
		this.getApiKey = options.getApiKey;
		this.onPayload = options.onPayload;
		this.onResponse = options.onResponse;
		this.beforeToolCall = options.beforeToolCall;
		this.afterToolCall = options.afterToolCall;
		this.prepareNextTurn = options.prepareNextTurn;
		this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
		// Passive queue always drains all-at-once: every pending notice is spliced
		// into the next turn that runs, never one-per-turn.
		this.passiveQueue = new PendingMessageQueue("all");
		this.sessionId = options.sessionId;
		this.thinkingBudgets = options.thinkingBudgets;
		this.transport = options.transport ?? "auto";
		this.maxRetryDelayMs = options.maxRetryDelayMs;
		this.idleTimeoutMs = options.idleTimeoutMs;
		this.toolExecution = options.toolExecution ?? "parallel";
		this.ttsrMatcher = options.ttsrMatcher;
		this.getOverthinkGuard = options.getOverthinkGuard;
		this.toolRewriteRegistry = options.toolRewriteRegistry;
		this.toolErrorHintRegistry = options.toolErrorHintRegistry;
		this.emitRepairNotes = options.emitRepairNotes;
	}

	/**
	 * Subscribe to agent lifecycle events.
	 *
	 * Listener promises run in parallel (via `Promise.all`) and all settle
	 * before the next event is dispatched; execution order between listeners is
	 * not observable. They are included in the current run's settlement.
	 * Listeners also receive the active abort signal for the current run.
	 *
	 * `agent_end` is the final emitted event for a run, but the agent does not
	 * become idle until all awaited listeners for that event have settled.
	 */
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Current agent state.
	 *
	 * Assigning `state.tools` or `state.messages` copies the provided top-level array.
	 */
	get state(): AgentState {
		return this._state;
	}

	/** Controls how queued steering messages are drained. */
	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}

	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	/** @deprecated Use {@link steeringMode}. */
	set queueMode(mode: QueueMode) {
		this.steeringMode = mode;
	}

	/** @deprecated Use {@link steeringMode}. */
	get queueMode(): QueueMode {
		return this.steeringMode;
	}

	/** Controls how queued follow-up messages are drained. */
	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}

	/** Queue a message to be injected after the current assistant turn finishes. */
	steer(message: AgentMessage, options?: { priority?: boolean }): void {
		if (options?.priority) {
			this.steeringQueue.enqueueFront(message);
		} else {
			this.steeringQueue.enqueue(message);
		}
	}

	/** Queue a message to run only after the agent would otherwise stop. */
	followUp(message: AgentMessage): void {
		this.followUpQueue.enqueue(message);
	}

	/**
	 * Queue a passive message to be spliced into the transcript at the next turn
	 * that already runs, WITHOUT forcing a turn of its own.
	 *
	 * Unlike {@link steer}/{@link followUp}, a passive message never keeps the
	 * loop alive: it is only drained on a turn the agent was already going to
	 * take (it still had tool calls). Use this to deliver out-of-band context
	 * (e.g. an inter-agent notice) to a busy agent without making it produce an
	 * extra reply turn or changing the final value it returns. If the agent is
	 * about to stop, the message stays queued and is simply never delivered.
	 */
	injectPassive(message: AgentMessage): void {
		this.passiveQueue.enqueue(message);
	}

	/** Remove all queued steering messages. */
	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	/** Remove all queued follow-up messages. */
	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	/** Remove all queued steering and follow-up messages. */
	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	/** Returns true when either queue still contains pending messages. */
	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	/** Active abort signal for the current run, if any. */
	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	/** Per-tool abort controllers (keyed by tool-call id), shared with the loop config. */
	private readonly toolAbortControllers = new Map<string, AbortController>();

	/** Abort the current run, if one is active. */
	abort(): void {
		this.activeRun?.abortController.abort();
	}

	/**
	 * Cancel a single in-flight tool by its tool-call id, without aborting the
	 * whole run. Returns true if a live controller was found and aborted. The
	 * tool sees an aborted signal (combined via AbortSignal.any in the loop) and
	 * the run continues with the remaining tools.
	 */
	cancelTool(toolCallId: string): boolean {
		const controller = this.toolAbortControllers.get(toolCallId);
		if (!controller) return false;
		controller.abort();
		return true;
	}

	/**
	 * Resolve when the current run and all awaited event listeners have finished.
	 *
	 * This resolves after `agent_end` listeners settle.
	 */
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/** Clear transcript state, runtime state, and queued messages. */
	reset(): void {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.errorMessage = undefined;
		this.clearFollowUpQueue();
		this.clearSteeringQueue();
		this.passiveQueue.clear();
	}

	/** Start a new prompt from text, a single message, or a batch of messages. */
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		const messages = this.normalizePromptInput(input, images);
		await this.runPromptMessages(messages);
	}

	/** Continue from the current transcript. The last message must be a user or tool-result message. */
	async continue(): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage) {
			throw new Error("No messages to continue from");
		}

		if (lastMessage.role === "assistant") {
			const queuedSteering = this.steeringQueue.drain();
			if (queuedSteering.length > 0) {
				await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}

			const queuedFollowUps = this.followUpQueue.drain();
			if (queuedFollowUps.length > 0) {
				await this.runPromptMessages(queuedFollowUps);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this.runContinuation();
	}

	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		if (Array.isArray(input)) {
			return input;
		}

		if (typeof input !== "string") {
			return [input];
		}

		const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		return [{ role: "user", content, timestamp: Date.now() }];
	}

	private async runPromptMessages(
		messages: AgentMessage[],
		options: { skipInitialSteeringPoll?: boolean } = {},
	): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoop(
				messages,
				this.createContextSnapshot(),
				this.createLoopConfig(options),
				(event) => this.processEvents(event),
				signal,
				this.streamFn,
			);
		});
	}

	private async runContinuation(): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoopContinue(
				this.createContextSnapshot(),
				this.createLoopConfig(),
				(event) => this.processEvents(event),
				signal,
				this.streamFn,
			);
		});
	}

	private createContextSnapshot(): AgentContext {
		return {
			systemPrompt: this._state.systemPrompt,
			// Clone happens once in runAgentLoop/runAgentLoopContinue so runLoop
			// mutations don't touch agent state.
			messages: this._state.messages,
			// Pass tools by reference: runLoop never mutates context.tools, and
			// state.tools is always a fresh array (the setter clones on assign),
			// so toolMapCache's WeakMap key stays stable across turns until tools
			// change. Slicing here broke the cache by minting a new array per turn.
			tools: this._state.tools,
		};
	}

	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		return {
			model: this._state.model,
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
			// Forward the per-run turn budget so the loop's native backstop cuts at
			// the caller's cap (undefined => loop default). Without this the cap was
			// inert and every run silently used DEFAULT_MAX_TURNS.
			maxTurns: this._state.maxTurns,
			sessionId: this.sessionId,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			transport: this.transport,
			thinkingBudgets: this.thinkingBudgets,
			maxRetryDelayMs: this.maxRetryDelayMs,
			idleTimeoutMs: this.idleTimeoutMs,
			toolExecution: this.toolExecution,
			toolAbortControllers: this.toolAbortControllers,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			prepareNextTurn: this.prepareNextTurn
				? async (nextTurnContext) => await this.prepareNextTurn?.(nextTurnContext)
				: undefined,
			// Re-read the live tool surface each turn so a tool activated mid-run
			// (e.g. search_tool_bm25) is callable on the next turn of the same run,
			// not just the next run. Returns the current array reference; the loop
			// skips the swap while it is unchanged.
			getActiveTools: () => this._state.tools,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.steeringQueue.drain();
			},
			getFollowUpMessages: async () => this.followUpQueue.drain(),
			getPassiveMessages: async () => this.passiveQueue.drain(),
			ttsrMatcher: this.ttsrMatcher,
			overthinkGuard: this.getOverthinkGuard?.(this._state.model, this._state.thinkingLevel),
			toolRewriteRegistry: this.toolRewriteRegistry,
			toolErrorHintRegistry: this.toolErrorHintRegistry,
			// Resolve the policy against the CURRENT model so a fallback/`/model`
			// switch flips the gate on the next run without re-constructing the Agent.
			emitRepairNotes:
				typeof this.emitRepairNotes === "function" ? this.emitRepairNotes(this._state.model) : this.emitRepairNotes,
		};
	}

	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		const abortController = new AbortController();
		let resolvePromise = () => {};
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		this.activeRun = { promise, resolve: resolvePromise, abortController };

		this._state.isStreaming = true;
		this._state.streamingMessage = undefined;
		this._state.errorMessage = undefined;

		try {
			await executor(abortController.signal);
		} catch (error) {
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			this.finishRun();
		}
	}

	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const failureMessage = {
			...buildErrorTurn(this._state.model, errorMessage),
			stopReason: aborted ? "aborted" : "error",
		} satisfies AgentMessage;
		// Each processEvents runs subscriber listeners (e.g. session persistence) that
		// can throw — and this runs INSIDE runWithLifecycle's catch, so a throw here
		// would escape (→ unhandledRejection / process death) AND skip the remaining
		// lifecycle events. Isolate each so message_end's failure can't suppress
		// turn_end/agent_end and nothing escapes onto the failure path.
		const emitSafe = async (event: AgentEvent): Promise<void> => {
			try {
				await this.processEvents(event);
			} catch {
				// A listener failure on the error path must not kill the run.
			}
		};
		await emitSafe({ type: "message_start", message: failureMessage });
		await emitSafe({ type: "message_end", message: failureMessage });
		await emitSafe({ type: "turn_end", message: failureMessage, toolResults: [] });
		await emitSafe({ type: "agent_end", messages: [failureMessage] });
	}

	private finishRun(): void {
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		// Passive messages are run-scoped: any that the loop never drained (the
		// agent stopped before a continuation turn) expire here so they can never
		// leak into a later, unrelated prompt's transcript.
		this.passiveQueue.clear();
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	/**
	 * Reduce internal state for a loop event, then await listeners.
	 *
	 * `agent_end` only means no further loop events will be emitted. The run is
	 * considered idle later, after all awaited listeners for `agent_end` finish
	 * and `finishRun()` clears runtime-owned state.
	 */
	private async processEvents(event: AgentEvent): Promise<void> {
		switch (event.type) {
			case "message_start":
				this._state.streamingMessage = event.message;
				break;

			case "message_update":
				this._state.streamingMessage = event.message;
				break;

			case "message_end":
				this._state.streamingMessage = undefined;
				if (!isStreamGuardAbortMessage(event.message)) {
					this._state.messages.push(event.message);
				}
				break;

			case "tool_execution_start":
				// Mutate in place: pendingToolCalls is internal mutable state, not
				// a public immutable snapshot. Re-cloning the Set on every tool
				// start/end allocated 2N Sets per parallel batch of N tools for
				// no observable benefit.
				this._state.pendingToolCalls.add(event.toolCallId);
				break;

			case "tool_execution_end":
				this._state.pendingToolCalls.delete(event.toolCallId);
				break;

			case "turn_end":
				if (event.message.role === "assistant" && event.message.errorMessage) {
					this._state.errorMessage = event.message.errorMessage;
				}
				break;

			case "agent_end":
				this._state.streamingMessage = undefined;
				break;
		}

		const signal = this.activeRun?.abortController.signal;
		if (!signal) {
			throw new Error("Agent listener invoked outside active run");
		}
		// Listeners run in parallel via Promise.all. Subscription order is no longer
		// observable between listeners, but all settle before the next event.
		if (this.listeners.size === 1) {
			for (const listener of this.listeners) {
				await listener(event, signal);
			}
		} else if (this.listeners.size > 1) {
			const pending: Array<Promise<void> | void> = [];
			for (const listener of this.listeners) {
				pending.push(listener(event, signal));
			}
			await Promise.all(pending);
		}
	}
}
