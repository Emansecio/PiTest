/**
 * P1 — speculative tool execution (see agent-loop.ts's `SpeculationController`
 * and the P1 doc comment above it).
 *
 * Harness mirrors agent-loop.test.ts: a fake `streamFn` built on the same
 * `EventStream<AssistantMessageEvent, AssistantMessage>` the real providers use,
 * fake `AgentTool`s that record call order/args, and full-stream event
 * collection via `for await`.
 *
 * Unlike the existing agent-loop tests (which always push a single `done` event
 * carrying the complete tool call), these tests stream the realistic sequence —
 * `start` → `toolcall_start` → `toolcall_delta` → `toolcall_end` → (delay) →
 * `done`/`error` — because P1 only fires off `toolcall_end`.
 */
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@pit/ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.js";
import { ToolRewriteRegistry } from "../src/tool-rewrite-registry.js";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
} from "../src/types.js";

// --- Shared harness (mirrors agent-loop.test.ts) --------------------------

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	} as AssistantMessage;
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

/** Emits the realistic streamed sequence for a batch of tool calls: start, then per call toolcall_start/toolcall_delta/toolcall_end. */
function pushStreamedToolCalls(
	stream: MockAssistantStream,
	calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): void {
	let content: AssistantMessage["content"] = [];
	stream.push({ type: "start", partial: createAssistantMessage(content, "toolUse") });
	calls.forEach((call, i) => {
		stream.push({ type: "toolcall_start", contentIndex: i, partial: createAssistantMessage(content, "toolUse") });
		stream.push({
			type: "toolcall_delta",
			contentIndex: i,
			delta: JSON.stringify(call.arguments),
			partial: createAssistantMessage(content, "toolUse"),
		});
		const block: AgentToolCall = { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments };
		content = [...content, block];
		stream.push({
			type: "toolcall_end",
			contentIndex: i,
			toolCall: block,
			partial: createAssistantMessage(content, "toolUse"),
		});
	});
}

function baseContext(tools: AgentTool<any>[]): AgentContext {
	return { systemPrompt: "", messages: [], tools };
}

function baseConfig(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
	return { model: createModel(), convertToLlm: identityConverter, ...overrides };
}

async function runAndCollect(
	context: AgentContext,
	config: AgentLoopConfig,
	streamFn: NonNullable<Parameters<typeof agentLoop>[4]>,
	signal?: AbortSignal,
): Promise<{ events: AgentEvent[]; messages: AgentMessage[] }> {
	const events: AgentEvent[] = [];
	const stream = agentLoop([createUserMessage("go")], context, config, signal, streamFn);
	for await (const event of stream) events.push(event);
	const messages = await stream.result();
	return { events, messages };
}

async function withEnvVarAsync<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
	const prev = process.env[name];
	process.env[name] = value;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env[name];
		else process.env[name] = prev;
	}
}

type ToolCallEvent = Extract<
	AgentEvent,
	{ type: "tool_execution_start" | "tool_execution_end" | "tool_execution_update" }
>;

function toolExecutionEventsFor(events: AgentEvent[], toolCallId: string): ToolCallEvent[] {
	return events.filter(
		(e): e is ToolCallEvent =>
			(e.type === "tool_execution_start" || e.type === "tool_execution_end" || e.type === "tool_execution_update") &&
			e.toolCallId === toolCallId,
	);
}

// --- 1. Speculation actually happens ---------------------------------------

describe("P1 speculative tool execution", () => {
	it("execute() starts before `done` arrives when the tool is speculationSafe", async () => {
		const order: string[] = [];
		const specTool: AgentTool = {
			name: "spec_tool",
			label: "spec_tool",
			description: "",
			parameters: Type.Object({}, { additionalProperties: true }),
			speculationSafe: true,
			async execute(_id, args) {
				order.push("execute-start");
				return { content: [{ type: "text", text: `ok:${JSON.stringify(args)}` }], details: {}, terminate: true };
			},
		};

		const context = baseContext([specTool]);
		const config = baseConfig();
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				pushStreamedToolCalls(stream, [{ id: "c1", name: "spec_tool", arguments: { a: 1 } }]);
				setTimeout(() => {
					order.push("push-done");
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "c1", name: "spec_tool", arguments: { a: 1 } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				}, 20);
			});
			return stream;
		};

		await runAndCollect(context, config, streamFn);

		// The execute must have started strictly before the delayed `done` was
		// even pushed onto the stream — proof the executor did not wait for the
		// assistant message to finish streaming.
		expect(order).toEqual(["execute-start", "push-done"]);
	});

	// --- 2. Byte-identical transcript with speculation on vs off -------------

	it("emits an identical event-type/toolCallId sequence with speculation ON vs PIT_NO_SPECULATIVE_TOOLS=1", async () => {
		type Summary = { type: string; toolCallId?: string };
		const summarize = (events: AgentEvent[]): Summary[] =>
			events.map((e) => {
				if (
					e.type === "tool_execution_start" ||
					e.type === "tool_execution_update" ||
					e.type === "tool_execution_end" ||
					e.type === "tool_call_rewritten" ||
					e.type === "tool_call_rejected" ||
					e.type === "tool_error_hint_applied"
				) {
					return { type: e.type, toolCallId: e.toolCallId };
				}
				if (e.type === "message_start" || e.type === "message_end") {
					return { type: e.type, toolCallId: e.message.role === "toolResult" ? e.message.toolCallId : undefined };
				}
				return { type: e.type };
			});

		const runScenario = async (): Promise<Summary[]> => {
			const tool: AgentTool = {
				name: "echo_tool",
				label: "echo_tool",
				description: "",
				parameters: Type.Object({}, { additionalProperties: true }),
				speculationSafe: true,
				async execute(_id, args) {
					return { content: [{ type: "text", text: `ok:${JSON.stringify(args)}` }], details: {}, terminate: true };
				},
			};
			const context = baseContext([tool]);
			const config = baseConfig();
			const streamFn = () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					pushStreamedToolCalls(stream, [{ id: "c1", name: "echo_tool", arguments: { a: 1 } }]);
					setTimeout(() => {
						const message = createAssistantMessage(
							[{ type: "toolCall", id: "c1", name: "echo_tool", arguments: { a: 1 } }],
							"toolUse",
						);
						stream.push({ type: "done", reason: "toolUse", message });
					}, 10);
				});
				return stream;
			};
			const { events } = await runAndCollect(context, config, streamFn);
			return summarize(events);
		};

		const specOn = await runScenario();
		const specOff = await withEnvVarAsync("PIT_NO_SPECULATIVE_TOOLS", "1", runScenario);

		expect(specOn.length).toBeGreaterThan(0);
		expect(specOn).toEqual(specOff);
	});

	// --- 3. Hooks fire exactly once --------------------------------------------

	it("beforeToolCall fires exactly once per call when speculation is consumed", async () => {
		let beforeCalls = 0;
		const tool: AgentTool = {
			name: "spec_tool",
			label: "spec_tool",
			description: "",
			parameters: Type.Object({}, { additionalProperties: true }),
			speculationSafe: true,
			async execute(_id, args) {
				return { content: [{ type: "text", text: `ok:${JSON.stringify(args)}` }], details: {}, terminate: true };
			},
		};
		const context = baseContext([tool]);
		const config = baseConfig({
			beforeToolCall: async () => {
				beforeCalls++;
				return undefined;
			},
		});
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				pushStreamedToolCalls(stream, [{ id: "c1", name: "spec_tool", arguments: { a: 1 } }]);
				setTimeout(() => {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "c1", name: "spec_tool", arguments: { a: 1 } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				}, 10);
			});
			return stream;
		};

		await runAndCollect(context, config, streamFn);

		expect(beforeCalls).toBe(1);
	});

	// --- 4. Buffered events replay in normal position, never mid-stream --------

	it("replays a buffered tool_call_rewritten event AFTER tool_execution_start, never during the stream", async () => {
		const tool: AgentTool = {
			name: "spec_tool",
			label: "spec_tool",
			description: "",
			parameters: Type.Object({}, { additionalProperties: true }),
			speculationSafe: true,
			async execute(_id, args) {
				return { content: [{ type: "text", text: `ok:${JSON.stringify(args)}` }], details: {}, terminate: true };
			},
		};
		const rewriteRegistry = new ToolRewriteRegistry();
		rewriteRegistry.add({
			id: "add-marker",
			appliesTo: "spec_tool",
			matcher: () => true,
			action: {
				tier: "auto",
				rewrite: (call) => ({ ...call, arguments: { ...call.arguments, marker: true } }),
			},
		});

		const context = baseContext([tool]);
		const config = baseConfig({ toolRewriteRegistry: rewriteRegistry });
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				pushStreamedToolCalls(stream, [{ id: "c1", name: "spec_tool", arguments: { a: 1 } }]);
				setTimeout(() => {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "c1", name: "spec_tool", arguments: { a: 1 } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				}, 10);
			});
			return stream;
		};

		const { events } = await runAndCollect(context, config, streamFn);

		const assistantMessageEndIndex = events.findIndex(
			(e) => e.type === "message_end" && e.message.role === "assistant",
		);
		const rewrittenIndex = events.findIndex((e) => e.type === "tool_call_rewritten");
		const toolExecStartIndex = events.findIndex((e) => e.type === "tool_execution_start" && e.toolCallId === "c1");

		expect(assistantMessageEndIndex).toBeGreaterThanOrEqual(0);
		expect(rewrittenIndex).toBeGreaterThanOrEqual(0);
		// Replayed strictly after the stream's assistant message_end...
		expect(rewrittenIndex).toBeGreaterThan(assistantMessageEndIndex);
		// ...and in the call's normal position, right after tool_execution_start.
		expect(rewrittenIndex).toBeGreaterThan(toolExecStartIndex);
	});

	// --- 5. Discard on stream error after toolcall_end --------------------------

	it("discards the speculation on a stream error: no tool events, onSpeculationDiscarded fires", async () => {
		const order: string[] = [];
		const discarded: Array<{ id: string; args: unknown }> = [];
		const tool: AgentTool = {
			name: "spec_tool",
			label: "spec_tool",
			description: "",
			parameters: Type.Object({}, { additionalProperties: true }),
			speculationSafe: true,
			onSpeculationDiscarded: (id, args) => discarded.push({ id, args }),
			async execute(_id, args) {
				order.push("execute-start");
				return { content: [{ type: "text", text: `ok:${JSON.stringify(args)}` }], details: {} };
			},
		};

		const context = baseContext([tool]);
		const config = baseConfig();
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				pushStreamedToolCalls(stream, [{ id: "c1", name: "spec_tool", arguments: { a: 1 } }]);
				setTimeout(() => {
					order.push("push-error");
					const errMessage = createAssistantMessage([], "error", "boom");
					stream.push({ type: "error", reason: "error", error: errMessage });
				}, 20);
			});
			return stream;
		};

		const { events, messages } = await runAndCollect(context, config, streamFn);

		// Speculative execute DID run (it started before the error interrupted the turn)...
		expect(order).toEqual(["execute-start", "push-error"]);
		// ...but no tool event ever reached the transcript.
		expect(toolExecutionEventsFor(events, "c1")).toEqual([]);
		expect(events.some((e) => e.type.startsWith("tool_"))).toBe(false);
		// Cleanup ran with the original (validated) args.
		expect(discarded).toEqual([{ id: "c1", args: { a: 1 } }]);
		// The run ended on the error turn.
		const last = messages[messages.length - 1] as AssistantMessage;
		expect(last.stopReason).toBe("error");
	});

	// --- 6. Discard when the final message omits the streamed call --------------

	it("discards the speculation when the final message omits the call (provider edge case)", async () => {
		const discarded: Array<{ id: string; args: unknown }> = [];
		const tool: AgentTool = {
			name: "spec_tool",
			label: "spec_tool",
			description: "",
			parameters: Type.Object({}, { additionalProperties: true }),
			speculationSafe: true,
			onSpeculationDiscarded: (id, args) => discarded.push({ id, args }),
			async execute(_id, args) {
				return { content: [{ type: "text", text: `ok:${JSON.stringify(args)}` }], details: {} };
			},
		};

		const context = baseContext([tool]);
		const config = baseConfig();
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				pushStreamedToolCalls(stream, [{ id: "ghost-1", name: "spec_tool", arguments: { ghost: true } }]);
				setTimeout(() => {
					// Final message drops the tool call entirely (text-only, stop).
					const message = createAssistantMessage([{ type: "text", text: "never mind" }], "stop");
					stream.push({ type: "done", reason: "stop", message });
				}, 20);
			});
			return stream;
		};

		const { events } = await runAndCollect(context, config, streamFn);

		expect(toolExecutionEventsFor(events, "ghost-1")).toEqual([]);
		expect(events.some((e) => e.type.startsWith("tool_"))).toBe(false);
		expect(discarded).toEqual([{ id: "ghost-1", args: { ghost: true } }]);
	});

	// --- 7. Fingerprint mismatch: re-prepared and re-executed for real -----------

	it("re-executes for real when final args differ from the streamed (speculated) args", async () => {
		const calls: Array<{ args: unknown }> = [];
		let beforeCalls = 0;
		const discarded: Array<{ id: string; args: unknown }> = [];
		const tool: AgentTool = {
			name: "spec_tool",
			label: "spec_tool",
			description: "",
			parameters: Type.Object({}, { additionalProperties: true }),
			speculationSafe: true,
			onSpeculationDiscarded: (id, args) => discarded.push({ id, args }),
			async execute(_id, args) {
				calls.push({ args });
				return {
					content: [{ type: "text", text: `real:${JSON.stringify(args)}` }],
					details: {},
					terminate: true,
				};
			},
		};
		const context = baseContext([tool]);
		const config = baseConfig({
			beforeToolCall: async () => {
				beforeCalls++;
				return undefined;
			},
		});
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				pushStreamedToolCalls(stream, [{ id: "c1", name: "spec_tool", arguments: { a: 1 } }]);
				setTimeout(() => {
					// Final message carries the SAME id but DIFFERENT arguments.
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "c1", name: "spec_tool", arguments: { a: 2 } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				}, 20);
			});
			return stream;
		};

		const { events, messages } = await runAndCollect(context, config, streamFn);

		// execute ran twice: the discarded speculative run (a:1), then the real one (a:2).
		expect(calls).toEqual([{ args: { a: 1 } }, { args: { a: 2 } }]);
		// beforeToolCall ran once per prepare funnel invocation (speculative + real).
		expect(beforeCalls).toBe(2);
		// The mismatch discarded the speculative entry with its (validated) original args.
		expect(discarded).toEqual([{ id: "c1", args: { a: 1 } }]);
		// Only ONE tool_execution_start/end pair reached the transcript (the real run) —
		// the discarded speculative run's funnel never emitted transcript events.
		expect(events.filter((e) => e.type === "tool_execution_start")).toHaveLength(1);
		expect(events.filter((e) => e.type === "tool_execution_end")).toHaveLength(1);
		// The delivered result reflects the REAL run's output.
		const toolResult = messages.find((m) => m.role === "toolResult") as Extract<AgentMessage, { role: "toolResult" }>;
		const text = toolResult.content[0]?.type === "text" ? toolResult.content[0].text : "";
		expect(text).toContain('"a":2');
	});

	// --- 8. Gates: speculation must NOT start early ------------------------------

	describe("gates: execute() never starts before `done` when speculation should not run", () => {
		async function runGateScenario(
			tool: AgentTool,
			order: string[],
			configOverrides: Partial<AgentLoopConfig> = {},
			signal?: AbortSignal,
		): Promise<void> {
			const context = baseContext([tool]);
			const config = baseConfig(configOverrides);
			const streamFn = () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					pushStreamedToolCalls(stream, [{ id: "g1", name: tool.name, arguments: { a: 1 } }]);
					setTimeout(() => {
						order.push("push-done");
						const message = createAssistantMessage(
							[{ type: "toolCall", id: "g1", name: tool.name, arguments: { a: 1 } }],
							"toolUse",
						);
						stream.push({ type: "done", reason: "toolUse", message });
					}, 15);
				});
				return stream;
			};
			await runAndCollect(context, config, streamFn, signal);
		}

		function gateTool(overrides: Partial<AgentTool>, order: string[]): AgentTool {
			return {
				name: "gate_tool",
				label: "gate_tool",
				description: "",
				parameters: Type.Object({}, { additionalProperties: true }),
				async execute(_id) {
					order.push("execute-start");
					return { content: [{ type: "text", text: "ok" }], details: {}, terminate: true };
				},
				...overrides,
			};
		}

		it("(a) tool without speculationSafe never speculates", async () => {
			const order: string[] = [];
			await runGateScenario(gateTool({}, order), order);
			expect(order).toEqual(["push-done", "execute-start"]);
		});

		it("(b) executionMode: 'sequential' on the tool never speculates, even if speculationSafe is true", async () => {
			const order: string[] = [];
			await runGateScenario(gateTool({ speculationSafe: true, executionMode: "sequential" }, order), order);
			expect(order).toEqual(["push-done", "execute-start"]);
		});

		it("(c) config.toolExecution: 'sequential' never speculates", async () => {
			const order: string[] = [];
			await runGateScenario(gateTool({ speculationSafe: true }, order), order, { toolExecution: "sequential" });
			expect(order).toEqual(["push-done", "execute-start"]);
		});

		it("(d) config.canSpeculateToolCall: () => false vetoes speculation", async () => {
			const order: string[] = [];
			await runGateScenario(gateTool({ speculationSafe: true }, order), order, {
				canSpeculateToolCall: () => false,
			});
			expect(order).toEqual(["push-done", "execute-start"]);
		});

		it("(e) PIT_NO_SPECULATIVE_TOOLS=1 disables speculation", async () => {
			const order: string[] = [];
			await withEnvVarAsync("PIT_NO_SPECULATIVE_TOOLS", "1", () =>
				runGateScenario(gateTool({ speculationSafe: true }, order), order),
			);
			expect(order).toEqual(["push-done", "execute-start"]);
		});
	});

	// --- 9. Abort mid-stream after toolcall_end ----------------------------------

	it("aborting the run after toolcall_end discards the speculation without crashing and without tool events", async () => {
		const discarded: Array<{ id: string; args: unknown }> = [];
		const tool: AgentTool = {
			name: "spec_tool",
			label: "spec_tool",
			description: "",
			parameters: Type.Object({}, { additionalProperties: true }),
			speculationSafe: true,
			onSpeculationDiscarded: (id, args) => discarded.push({ id, args }),
			async execute(_id, args) {
				// Slow enough to still be in flight when the abort fires.
				await new Promise((resolve) => setTimeout(resolve, 50));
				return { content: [{ type: "text", text: `ok:${JSON.stringify(args)}` }], details: {} };
			},
		};

		const context = baseContext([tool]);
		const config = baseConfig();
		const controller = new AbortController();
		const streamFn = (_model: Model<any>, _ctx: unknown, options?: { signal?: AbortSignal }) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				pushStreamedToolCalls(stream, [{ id: "c1", name: "spec_tool", arguments: { a: 1 } }]);
			});
			// Well-behaved streamFn contract: encode the abort as a terminal error event.
			options?.signal?.addEventListener(
				"abort",
				() => {
					const abortedMessage = createAssistantMessage([], "aborted", "Request was aborted");
					stream.push({ type: "error", reason: "aborted", error: abortedMessage });
				},
				{ once: true },
			);
			return stream;
		};

		setTimeout(() => controller.abort(), 15);

		let threw: unknown;
		let events: AgentEvent[] = [];
		let messages: AgentMessage[] = [];
		try {
			const result = await runAndCollect(context, config, streamFn, controller.signal);
			events = result.events;
			messages = result.messages;
		} catch (err) {
			threw = err;
		}

		expect(threw).toBeUndefined();
		expect(events.some((e) => e.type.startsWith("tool_"))).toBe(false);
		expect(discarded).toHaveLength(1);
		expect(discarded[0]?.id).toBe("c1");
		const last = messages[messages.length - 1] as AssistantMessage;
		expect(last.stopReason).toBe("aborted");
	});

	// --- 10. Mixed batch: speculative + sequential in the same turn --------------

	it("partitioned mixed batch: the speculative call is consumed once, the sequential call runs normally, order preserved", async () => {
		const specCalls: Array<{ args: unknown }> = [];
		const seqCalls: Array<{ args: unknown }> = [];
		const order: string[] = [];

		const specTool: AgentTool = {
			name: "spec_tool",
			label: "spec_tool",
			description: "",
			parameters: Type.Object({}, { additionalProperties: true }),
			speculationSafe: true,
			async execute(_id, args) {
				order.push("spec-execute-start");
				specCalls.push({ args });
				return { content: [{ type: "text", text: "spec-result" }], details: {}, terminate: true };
			},
		};
		const seqTool: AgentTool = {
			name: "seq_tool",
			label: "seq_tool",
			description: "",
			parameters: Type.Object({}, { additionalProperties: true }),
			executionMode: "sequential",
			async execute(_id, args) {
				order.push("seq-execute-start");
				seqCalls.push({ args });
				return { content: [{ type: "text", text: "seq-result" }], details: {}, terminate: true };
			},
		};

		const context = baseContext([specTool, seqTool]);
		const config = baseConfig();
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				pushStreamedToolCalls(stream, [
					{ id: "spec-1", name: "spec_tool", arguments: { a: 1 } },
					{ id: "seq-1", name: "seq_tool", arguments: { b: 2 } },
				]);
				setTimeout(() => {
					order.push("push-done");
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "spec-1", name: "spec_tool", arguments: { a: 1 } },
							{ type: "toolCall", id: "seq-1", name: "seq_tool", arguments: { b: 2 } },
						],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				}, 20);
			});
			return stream;
		};

		const { events } = await runAndCollect(context, config, streamFn);

		// The speculative tool ran exactly once (consumed, not re-executed)...
		expect(specCalls).toEqual([{ args: { a: 1 } }]);
		// ...and started BEFORE `done` was pushed.
		expect(order[0]).toBe("spec-execute-start");
		expect(order).toContain("push-done");
		expect(order.indexOf("spec-execute-start")).toBeLessThan(order.indexOf("push-done"));
		// The sequential tool ran exactly once, normally (after the stream ended).
		expect(seqCalls).toEqual([{ args: { b: 2 } }]);
		expect(order.indexOf("seq-execute-start")).toBeGreaterThan(order.indexOf("push-done"));

		// Result ordering follows the ORIGINAL toolCall order across the partition.
		const toolResultIds = events.flatMap((e) =>
			e.type === "message_end" && e.message.role === "toolResult" ? [e.message.toolCallId] : [],
		);
		expect(toolResultIds).toEqual(["spec-1", "seq-1"]);
		const turnToolResultIds = events.flatMap((e) =>
			e.type === "turn_end" ? e.toolResults.map((r) => r.toolCallId) : [],
		);
		expect(turnToolResultIds).toEqual(["spec-1", "seq-1"]);
	});
});
