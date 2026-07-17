import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@pit/ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentLoop, agentLoopContinue, runAgentLoop } from "../src/agent-loop.js";
import { THINKING_CHARS_PER_TOKEN } from "../src/overthink-guard.js";
import * as stableArgsFingerprintMod from "../src/stable-args-fingerprint.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.js";

// Mock stream for testing - mimics MockAssistantStream
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
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

// Simple identity converter for tests - just passes through standard messages
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

describe("agentLoop with AgentMessage", () => {
	it("should emit events with AgentMessage types", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("Hello");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Hi there!" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should have user message and assistant message
		expect(messages.length).toBe(2);
		expect(messages[0].role).toBe("user");
		expect(messages[1].role).toBe("assistant");

		// Verify event sequence
		const eventTypes = events.map((e) => e.type);
		expect(eventTypes).toContain("agent_start");
		expect(eventTypes).toContain("turn_start");
		expect(eventTypes).toContain("message_start");
		expect(eventTypes).toContain("message_end");
		expect(eventTypes).toContain("turn_end");
		expect(eventTypes).toContain("agent_end");
	});

	it("stops at config.maxTurns with a terminal turn-budget message (unbounded-loop backstop)", async () => {
		let streamCalls = 0;
		const pingTool: AgentTool = {
			name: "ping",
			label: "ping",
			description: "",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "pong" }], details: {} }),
		};
		const context: AgentContext = { systemPrompt: "s", messages: [], tools: [pingTool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			maxTurns: 3,
		};
		// Always respond with a tool call → hasMoreToolCalls never clears, so the
		// loop would run forever without the maxTurns backstop.
		const streamFn = () => {
			streamCalls++;
			const stream = new MockAssistantStream();
			const n = streamCalls;
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "toolCall", id: `c${n}`, name: "ping", arguments: {} }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
		for await (const event of stream) events.push(event);
		const messages = await stream.result();

		// The model was asked exactly maxTurns times, not infinitely.
		expect(streamCalls).toBe(3);
		// Terminal message surfaces the budget reason (never a silent stop).
		const last = messages[messages.length - 1] as AssistantMessage;
		expect(last.role).toBe("assistant");
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toMatch(/turn budget of 3 turns/i);
		expect(events.map((e) => e.type)).toContain("agent_end");
	});

	it("should handle custom message types via convertToLlm", async () => {
		// Create a custom message type
		interface CustomNotification {
			role: "notification";
			text: string;
			timestamp: number;
		}

		const notification: CustomNotification = {
			role: "notification",
			text: "This is a notification",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [notification as unknown as AgentMessage], // Custom message in context
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("Hello");

		let convertedMessages: Message[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: (messages) => {
				// Filter out notifications, convert rest
				convertedMessages = messages
					.filter((m) => (m as { role: string }).role !== "notification")
					.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
				return convertedMessages;
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		// The notification should have been filtered out in convertToLlm
		expect(convertedMessages.length).toBe(1); // Only user message
		expect(convertedMessages[0].role).toBe("user");
	});

	it("should apply transformContext before convertToLlm", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [
				createUserMessage("old message 1"),
				createAssistantMessage([{ type: "text", text: "old response 1" }]),
				createUserMessage("old message 2"),
				createAssistantMessage([{ type: "text", text: "old response 2" }]),
			],
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("new message");

		let transformedMessages: AgentMessage[] = [];
		let convertedMessages: Message[] = [];

		const config: AgentLoopConfig = {
			model: createModel(),
			transformContext: async (messages) => {
				// Keep only last 2 messages (prune old ones)
				transformedMessages = messages.slice(-2);
				return transformedMessages;
			},
			convertToLlm: (messages) => {
				convertedMessages = messages.filter(
					(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
				) as Message[];
				return convertedMessages;
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const _ of stream) {
			// consume
		}

		// transformContext should have been called first, keeping only last 2
		expect(transformedMessages.length).toBe(2);
		// Then convertToLlm receives the pruned messages
		expect(convertedMessages.length).toBe(2);
	});

	it("fails the turn (never skips) when transformContext exceeds its timeout (A1)", async () => {
		const prev = process.env.PIT_TRANSFORM_CONTEXT_TIMEOUT_MS;
		process.env.PIT_TRANSFORM_CONTEXT_TIMEOUT_MS = "20";
		try {
			const context: AgentContext = { systemPrompt: "s", messages: [], tools: [] };
			let streamCalled = false;
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				// Hung hook: never resolves.
				transformContext: () => new Promise<AgentMessage[]>(() => {}),
			};
			const streamFn = () => {
				streamCalled = true;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "hi" }]),
					});
				});
				return stream;
			};

			const events: AgentEvent[] = [];
			const stream = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
			for await (const event of stream) events.push(event);
			const messages = await stream.result();

			const last = messages[messages.length - 1] as AssistantMessage;
			expect(last.stopReason).toBe("error");
			expect(last.errorMessage).toMatch(/transformContext hook timed out after 20ms/i);
			// Load-bearing transform: the model must NOT have been streamed with a
			// context that skipped the (hung) transform.
			expect(streamCalled).toBe(false);
			expect(events.map((e) => e.type)).toContain("agent_end");
		} finally {
			if (prev === undefined) delete process.env.PIT_TRANSFORM_CONTEXT_TIMEOUT_MS;
			else process.env.PIT_TRANSFORM_CONTEXT_TIMEOUT_MS = prev;
		}
	});

	it("does not trip the transformContext timeout on a hook that completes in time (A1)", async () => {
		const prev = process.env.PIT_TRANSFORM_CONTEXT_TIMEOUT_MS;
		process.env.PIT_TRANSFORM_CONTEXT_TIMEOUT_MS = "200";
		try {
			const context: AgentContext = { systemPrompt: "s", messages: [], tools: [] };
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				transformContext: async (messages) => {
					await new Promise((r) => setTimeout(r, 5));
					return messages;
				},
			};
			const streamFn = () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "ok" }]),
					});
				});
				return stream;
			};

			const stream = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
			for await (const _ of stream) {
				// consume
			}
			const messages = await stream.result();
			const last = messages[messages.length - 1] as AssistantMessage;
			expect(last.stopReason).toBe("stop");
			expect(last.errorMessage).toBeUndefined();
		} finally {
			if (prev === undefined) delete process.env.PIT_TRANSFORM_CONTEXT_TIMEOUT_MS;
			else process.env.PIT_TRANSFORM_CONTEXT_TIMEOUT_MS = prev;
		}
	});

	it("should handle tool calls and results", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo something");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: return tool call
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					// Second call: return final response
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		// Tool should have been executed
		expect(executed).toEqual(["hello"]);

		// Should have tool execution events
		const toolStart = events.find((e) => e.type === "tool_execution_start");
		const toolEnd = events.find((e) => e.type === "tool_execution_end");
		expect(toolStart).toBeDefined();
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(false);
		}
	});

	it("should execute valid guard-mutated args after post-firewall revalidation", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo something");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			beforeToolCall: async ({ args }) => {
				const mutableArgs = args as { value: string };
				mutableArgs.value = "fixed-by-guard";
				return undefined;
			},
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// consume
		}

		expect(executed).toEqual(["fixed-by-guard"]);
	});

	it("never fingerprints args in the beforeToolCall path", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo something");
		const fingerprintSpy = vi.spyOn(stableArgsFingerprintMod, "stableArgsFingerprint");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			beforeToolCall: async () => undefined,
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// consume
		}

		expect(executed).toEqual(["hello"]);
		// Mutation detection is the Proxy/markArgsMutated flag; revalidation goes
		// through validator.Check. No fingerprint is computed on any path.
		expect(fingerprintSpy).toHaveBeenCalledTimes(0);
		fingerprintSpy.mockRestore();
	});

	it("executes normally when a guard flags a mutation but leaves values unchanged", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo something");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			beforeToolCall: async ({ args }) => {
				// Writing the SAME value flips the Proxy's mutated flag without
				// changing anything. Revalidation (validator.Check fast path) must
				// pass and execution proceed with the original args.
				const mutableArgs = args as { value: string };
				mutableArgs.value = "hello";
				return undefined;
			},
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// consume
		}

		expect(executed).toEqual(["hello"]);
	});

	it("should block execution when a guard mutation produces invalid args", async () => {
		const toolSchema = Type.Object({ count: Type.Integer({ minimum: 1 }) });
		const executed: number[] = [];
		const tool: AgentTool<typeof toolSchema, { count: number }> = {
			name: "counter",
			label: "Counter",
			description: "Counter tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.count);
				return {
					content: [{ type: "text", text: String(params.count) }],
					details: { count: params.count },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("count");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			beforeToolCall: async ({ args }) => {
				const mutableArgs = args as { count: number };
				mutableArgs.count = 0;
				return undefined;
			},
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "counter", arguments: { count: 2 } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect(executed).toEqual([]);
		const toolEnd = events.find((e) => e.type === "tool_execution_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(true);
			const text =
				toolEnd.result.content.find((block: { type: string; text?: string }) => block.type === "text")?.text ?? "";
			expect(text).toContain("Tool arguments became invalid after a guard mutation");
		}
	});

	it("should prepare tool arguments for validation", async () => {
		const replaceSchema = Type.Object({ oldText: Type.String(), newText: Type.String() });
		const toolSchema = Type.Object({ edits: Type.Array(replaceSchema) });
		const executed: Array<Array<{ oldText: string; newText: string }>> = [];
		const tool: AgentTool<typeof toolSchema, { count: number }> = {
			name: "edit",
			label: "Edit",
			description: "Edit tool",
			parameters: toolSchema,
			prepareArguments(args) {
				if (!args || typeof args !== "object") {
					return args as { edits: { oldText: string; newText: string }[] };
				}
				const input = args as {
					edits?: Array<{ oldText: string; newText: string }>;
					oldText?: string;
					newText?: string;
				};
				if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
					return args as { edits: { oldText: string; newText: string }[] };
				}
				return {
					edits: [...(input.edits ?? []), { oldText: input.oldText, newText: input.newText }],
				};
			},
			async execute(_toolCallId, params) {
				executed.push(params.edits);
				return {
					content: [{ type: "text", text: `edited ${params.edits.length}` }],
					details: { count: params.edits.length },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("edit something");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "edit",
								arguments: { oldText: "before", newText: "after" },
							},
						],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// consume
		}

		expect(executed).toEqual([[{ oldText: "before", newText: "after" }]]);
	});

	it("should emit tool_execution_end in completion order but persist tool results in source order", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const toolExecutionEndIds = events.flatMap((event) => {
			if (event.type !== "tool_execution_end") {
				return [];
			}
			return [event.toolCallId];
		});
		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		const turnToolResultIds = events.flatMap((event) => {
			if (event.type !== "turn_end") {
				return [];
			}
			return event.toolResults.map((toolResult) => toolResult.toolCallId);
		});

		expect(parallelObserved).toBe(true);
		expect(toolExecutionEndIds).toEqual(["tool-2", "tool-1"]);
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
		expect(turnToolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("should inject queued messages after all tool calls complete", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("start");
		const queuedUserMessage: AgentMessage = createUserMessage("interrupt");

		let queuedDelivered = false;
		let callIndex = 0;
		let sawInterruptInContext = false;

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "sequential",
			getSteeringMessages: async () => {
				// Return steering message after tool execution has started.
				if (executed.length >= 1 && !queuedDelivered) {
					queuedDelivered = true;
					return [queuedUserMessage];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, (_model, ctx, _options) => {
			// Check if interrupt message is in context on second call
			if (callIndex === 1) {
				sawInterruptInContext = ctx.messages.some(
					(m) => m.role === "user" && typeof m.content === "string" && m.content === "interrupt",
				);
			}

			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: return two tool calls
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					// Second call: return final response
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		for await (const event of stream) {
			events.push(event);
		}

		// Both tools should execute before steering is injected
		expect(executed).toEqual(["first", "second"]);

		const toolEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnds.length).toBe(2);
		expect(toolEnds[0].isError).toBe(false);
		expect(toolEnds[1].isError).toBe(false);

		// Queued message should appear in events after both tool result messages
		const eventSequence = events.flatMap((event) => {
			if (event.type !== "message_start") return [];
			if (event.message.role === "toolResult") return [`tool:${event.message.toolCallId}`];
			if (event.message.role === "user" && typeof event.message.content === "string") {
				return [event.message.content];
			}
			return [];
		});
		expect(eventSequence).toContain("interrupt");
		expect(eventSequence.indexOf("tool:tool-1")).toBeLessThan(eventSequence.indexOf("interrupt"));
		expect(eventSequence.indexOf("tool:tool-2")).toBeLessThan(eventSequence.indexOf("interrupt"));

		// Interrupt message should be in context when second LLM call is made
		expect(sawInterruptInContext).toBe(true);
	});

	it("should force sequential execution when a tool has executionMode=sequential even with default parallel config", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const slowTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "slow",
			label: "Slow",
			description: "Slow tool",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `slow: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [slowTool],
		};

		const userPrompt: AgentMessage = createUserMessage("run both");
		// config is parallel (default), but tool forces sequential
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "slow", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "slow", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// With sequential execution, second tool should NOT start before first finishes
		expect(parallelObserved).toBe(false);

		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("partitions a mixed batch: parallel-safe tools overlap, sequential runs serialized, results in original order", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executionOrder: string[] = [];
		let parallelObserved = false;
		let fastAResolved = false;
		let releaseFastA: (() => void) | undefined;
		const fastAGate = new Promise<void>((resolve) => {
			releaseFastA = resolve;
		});

		// Sequential tool sits FIRST in the batch, yet with partitioning the two
		// parallel-safe siblings run (and overlap) before it.
		const seqTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "seq",
			label: "Seq",
			description: "Sequential tool",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				executionOrder.push(`seq:${params.value}`);
				return {
					content: [{ type: "text", text: `seq: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const fastTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "fast",
			label: "Fast",
			description: "Parallel-safe tool",
			parameters: toolSchema,
			// no executionMode = defaults to parallel
			async execute(_toolCallId, params) {
				executionOrder.push(`fast:${params.value}`);
				if (params.value === "a") {
					await fastAGate;
					fastAResolved = true;
				}
				// If b runs while a is still parked, the two parallel-safe tools
				// truly overlapped.
				if (params.value === "b" && !fastAResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `fast: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [seqTool, fastTool],
		};

		const userPrompt: AgentMessage = createUserMessage("run all");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			// parallel by default; seqTool forces the batch to partition
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "seq", arguments: { value: "s" } },
							{ type: "toolCall", id: "tool-2", name: "fast", arguments: { value: "a" } },
							{ type: "toolCall", id: "tool-3", name: "fast", arguments: { value: "b" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFastA?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const toolResultIds = events.flatMap((event) =>
			event.type === "message_end" && event.message.role === "toolResult" ? [event.message.toolCallId] : [],
		);
		const turnToolResultIds = events.flatMap((event) =>
			event.type === "turn_end" ? event.toolResults.map((r) => r.toolCallId) : [],
		);

		// The two parallel-safe tools overlapped each other...
		expect(parallelObserved).toBe(true);
		// ...and both ran before the sequential tool (design (a): parallel subset first).
		expect(executionOrder.indexOf("seq:s")).toBe(executionOrder.length - 1);
		expect(executionOrder).toContain("fast:a");
		expect(executionOrder).toContain("fast:b");
		// Result + turn-end ordering follow the ORIGINAL toolCall order across subsets.
		expect(toolResultIds).toEqual(["tool-1", "tool-2", "tool-3"]);
		expect(turnToolResultIds).toEqual(["tool-1", "tool-2", "tool-3"]);
	});

	it("PIT_NO_BATCH_PARTITION restores all-sequential execution for a mixed batch", async () => {
		const prev = process.env.PIT_NO_BATCH_PARTITION;
		process.env.PIT_NO_BATCH_PARTITION = "1";
		try {
			const toolSchema = Type.Object({ value: Type.String() });
			let parallelObserved = false;
			let fastAResolved = false;
			let releaseFastA: (() => void) | undefined;
			const fastAGate = new Promise<void>((resolve) => {
				releaseFastA = resolve;
			});

			const seqTool: AgentTool<typeof toolSchema, { value: string }> = {
				name: "seq",
				label: "Seq",
				description: "Sequential tool",
				parameters: toolSchema,
				executionMode: "sequential",
				async execute(_toolCallId, params) {
					return { content: [{ type: "text", text: `seq: ${params.value}` }], details: { value: params.value } };
				},
			};
			const fastTool: AgentTool<typeof toolSchema, { value: string }> = {
				name: "fast",
				label: "Fast",
				description: "Parallel-safe tool",
				parameters: toolSchema,
				async execute(_toolCallId, params) {
					if (params.value === "a") {
						await fastAGate;
						fastAResolved = true;
					}
					if (params.value === "b" && !fastAResolved) {
						parallelObserved = true;
					}
					return { content: [{ type: "text", text: `fast: ${params.value}` }], details: { value: params.value } };
				},
			};

			const context: AgentContext = { systemPrompt: "", messages: [], tools: [seqTool, fastTool] };
			const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

			let callIndex = 0;
			const stream = agentLoop([createUserMessage("run all")], context, config, undefined, () => {
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callIndex === 0) {
						const message = createAssistantMessage(
							[
								{ type: "toolCall", id: "tool-1", name: "seq", arguments: { value: "s" } },
								{ type: "toolCall", id: "tool-2", name: "fast", arguments: { value: "a" } },
								{ type: "toolCall", id: "tool-3", name: "fast", arguments: { value: "b" } },
							],
							"toolUse",
						);
						mockStream.push({ type: "done", reason: "toolUse", message });
						setTimeout(() => releaseFastA?.(), 20);
					} else {
						mockStream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					callIndex++;
				});
				return mockStream;
			});

			const events: AgentEvent[] = [];
			for await (const event of stream) {
				events.push(event);
			}

			const toolResultIds = events.flatMap((event) =>
				event.type === "message_end" && event.message.role === "toolResult" ? [event.message.toolCallId] : [],
			);
			// Kill-switch: whole batch runs sequentially, so the two fast tools never overlap.
			expect(parallelObserved).toBe(false);
			// Result order is still the original toolCall order.
			expect(toolResultIds).toEqual(["tool-1", "tool-2", "tool-3"]);
		} finally {
			if (prev === undefined) delete process.env.PIT_NO_BATCH_PARTITION;
			else process.env.PIT_NO_BATCH_PARTITION = prev;
		}
	});

	it("partitioned batch: abort mid sequential-subset synthesizes aborted results in original order", async () => {
		const toolSchema = Type.Object({});
		let seqAStarted = false;
		let fastRan = false;

		const fastTool: AgentTool<typeof toolSchema, undefined> = {
			name: "fast",
			label: "Fast",
			description: "Parallel-safe; completes before the abort",
			parameters: toolSchema,
			async execute() {
				fastRan = true;
				return { content: [{ type: "text", text: "fast-done" }], details: undefined };
			},
		};
		const seqA: AgentTool<typeof toolSchema, undefined> = {
			name: "seqA",
			label: "SeqA",
			description: "Sequential; parks until aborted",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, _params, signal) {
				seqAStarted = true;
				await new Promise<void>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
				return { content: [{ type: "text", text: "should-not-finish" }], details: undefined };
			},
		};
		const seqB: AgentTool<typeof toolSchema, undefined> = {
			name: "seqB",
			label: "SeqB",
			description: "Sequential; must get a synthetic aborted result",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute() {
				return { content: [{ type: "text", text: "should-not-run" }], details: undefined };
			},
		};

		const runAbort = new AbortController();
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [fastTool, seqA, seqB] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		const stream = agentLoop([createUserMessage("go")], context, config, runAbort.signal, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[
						{ type: "toolCall", id: "tc-fast", name: "fast", arguments: {} },
						{ type: "toolCall", id: "tc-a", name: "seqA", arguments: {} },
						{ type: "toolCall", id: "tc-b", name: "seqB", arguments: {} },
					],
					"toolUse",
				);
				mockStream.push({ type: "done", reason: "toolUse", message });
			});
			return mockStream;
		});

		const toolResults: Array<{ toolCallId: string; isError?: boolean; content: unknown }> = [];
		const orderedIds: string[] = [];
		const consume = (async () => {
			for await (const event of stream) {
				if (event.type === "message_end" && event.message.role === "toolResult") {
					orderedIds.push(event.message.toolCallId);
					toolResults.push({
						toolCallId: event.message.toolCallId,
						isError: event.message.isError,
						content: event.message.content,
					});
				}
			}
		})();

		await vi.waitFor(() => expect(seqAStarted).toBe(true));
		runAbort.abort();
		await consume;

		// Parallel subset completed before the abort landed on the sequential subset.
		expect(fastRan).toBe(true);
		// All three calls get a result, emitted in ORIGINAL order.
		expect(orderedIds).toEqual(["tc-fast", "tc-a", "tc-b"]);
		const b = toolResults.find((r) => r.toolCallId === "tc-b");
		expect(b?.isError).toBe(true);
		expect(JSON.stringify(b?.content)).toContain("Operation aborted");
	});

	it("should allow parallel execution when all tools have executionMode=parallel", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			executionMode: "parallel",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// With executionMode=parallel, second tool should start before first finishes
		expect(parallelObserved).toBe(true);
	});

	it("isolates prepareNextTurn throws so a successful turn is not converted to an error", async () => {
		const context: AgentContext = {
			systemPrompt: "test",
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			prepareNextTurn: () => {
				throw new Error("Cannot read properties of undefined (reading 'messages')");
			},
		};

		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				mockStream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "hello" }]),
				});
			});
			return mockStream;
		});

		const events = [];
		for await (const event of stream) {
			events.push(event);
		}

		const assistants = events.filter((e) => e.type === "message_end" && e.message.role === "assistant");
		expect(assistants.length).toBe(1);
		expect((assistants[0] as { message: { stopReason: string; errorMessage?: string } }).message.stopReason).toBe(
			"stop",
		);
		expect((assistants[0] as { message: { errorMessage?: string } }).message.errorMessage).toBeUndefined();
	});

	it("should use prepareNextTurn snapshot before continuing", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = {
			systemPrompt: "first prompt",
			messages: [],
			tools: [tool],
		};
		let convertedSecondTurnSystemPrompt = "";
		let prepared = false;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			prepareNextTurn: async ({ context: currentContext }) => {
				if (prepared) return undefined;
				prepared = true;
				return {
					context: {
						systemPrompt: "second prompt",
						messages: currentContext.messages.slice(),
						tools: currentContext.tools,
					},
				};
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, (_model, ctx) => {
			llmCalls++;
			if (llmCalls === 2) {
				convertedSecondTurnSystemPrompt = ctx.systemPrompt ?? "";
			}
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
							"toolUse",
						),
					});
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(2);
		expect(convertedSecondTurnSystemPrompt).toBe("second prompt");
	});

	it("should stop after the current turn when shouldStopAfterTurn returns true", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		let steeringPolls = 0;
		let followUpPolls = 0;
		let callbackToolResultIds: string[] = [];
		let callbackContextRoles: string[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			getSteeringMessages: async () => {
				steeringPolls++;
				return [];
			},
			getFollowUpMessages: async () => {
				followUpPolls++;
				return [createUserMessage("follow up should stay queued")];
			},
			shouldStopAfterTurn: async ({ message, toolResults, context }) => {
				expect(message.role).toBe("assistant");
				callbackToolResultIds = toolResults.map((toolResult) => toolResult.toolCallId);
				callbackContextRoles = context.messages.map((contextMessage) => contextMessage.role);
				return true;
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "should not run" }]),
					});
				}
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(llmCalls).toBe(1);
		expect(executed).toEqual(["hello"]);
		expect(steeringPolls).toBe(1);
		expect(followUpPolls).toBe(0);
		expect(callbackToolResultIds).toEqual(["tool-1"]);
		expect(callbackContextRoles).toEqual(["user", "assistant", "toolResult"]);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
	});

	it("should stop after a tool batch when every tool result sets terminate=true", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
					terminate: true,
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					"toolUse",
				);
				mockStream.push({ type: "done", reason: "toolUse", message });
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(llmCalls).toBe(1);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
	});

	it("should continue after parallel tool calls when not all tool results terminate", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
					terminate: params.value === "first",
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("echo both")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		const messages = await stream.result();
		expect(callIndex).toBe(2);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"assistant",
		]);
	});

	it("should allow afterToolCall to mark a tool batch as terminating", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			afterToolCall: async () => ({ terminate: true }),
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					"toolUse",
				);
				mockStream.push({ type: "done", reason: "toolUse", message });
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(1);
	});

	// Memory-leak guard: a long-running tool that streams many updates must
	// deliver every update, in order, before the final tool result — and the
	// loop must not retain settled update promises. We assert the observable
	// contract: all N updates arrive (ordered) strictly before tool_execution_end,
	// which is exactly what draining the in-flight set guarantees.
	it("delivers all streamed tool updates in order before the result and does not retain settled emits", async () => {
		const UPDATE_COUNT = 1000;
		const toolSchema = Type.Object({});
		const tool: AgentTool<typeof toolSchema, { seq: number }> = {
			name: "streamer",
			label: "Streamer",
			description: "Streams many updates",
			parameters: toolSchema,
			async execute(_toolCallId, _params, _signal, onUpdate) {
				for (let i = 0; i < UPDATE_COUNT; i++) {
					onUpdate?.({
						content: [{ type: "text", text: `chunk ${i}` }],
						details: { seq: i },
					});
				}
				return { content: [{ type: "text", text: "done" }], details: { seq: -1 } };
			},
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "streamer", arguments: {} }],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);

		// Every update was delivered, in arrival order (seq 0..N-1).
		const updateSeqs = events.flatMap((e) =>
			e.type === "tool_execution_update" ? [(e.partialResult as { details: { seq: number } }).details.seq] : [],
		);
		expect(updateSeqs.length).toBe(UPDATE_COUNT);
		expect(updateSeqs).toEqual(Array.from({ length: UPDATE_COUNT }, (_v, i) => i));

		// The completion barrier holds: the last update is emitted strictly before
		// tool_execution_end. This is observable proof that Promise.all over the
		// in-flight set awaited (and thus drained) every emit before the result.
		const lastUpdateIdx = events.map((e) => e.type).lastIndexOf("tool_execution_update");
		const endIdx = events.findIndex((e) => e.type === "tool_execution_end");
		expect(lastUpdateIdx).toBeGreaterThanOrEqual(0);
		expect(endIdx).toBeGreaterThan(lastUpdateIdx);

		const toolEnd = events.find((e) => e.type === "tool_execution_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(false);
		}
	});
});

describe("agentLoopContinue with AgentMessage", () => {
	it("should throw when context has no messages", () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		expect(() => agentLoopContinue(context, config)).toThrow("Cannot continue: no messages in context");
	});

	it("should continue from existing context without emitting user message events", async () => {
		const userMessage: AgentMessage = createUserMessage("Hello");

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [userMessage],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoopContinue(context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should only return the new assistant message (not the existing user message)
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("assistant");

		// Should NOT have user message events (that's the key difference from agentLoop)
		const messageEndEvents = events.filter((e) => e.type === "message_end");
		expect(messageEndEvents.length).toBe(1);
		expect((messageEndEvents[0] as any).message.role).toBe("assistant");
	});

	it("should allow custom message types as last message (caller responsibility)", async () => {
		// Custom message that will be converted to user message by convertToLlm
		interface CustomMessage {
			role: "custom";
			text: string;
			timestamp: number;
		}

		const customMessage: CustomMessage = {
			role: "custom",
			text: "Hook content",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [customMessage as unknown as AgentMessage],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: (messages) => {
				// Convert custom to user message
				return messages
					.map((m) => {
						if ((m as any).role === "custom") {
							return {
								role: "user" as const,
								content: (m as any).text,
								timestamp: m.timestamp,
							};
						}
						return m;
					})
					.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response to custom message" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		// Should not throw - the custom message will be converted to user message
		const stream = agentLoopContinue(context, config, undefined, streamFn);

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("assistant");
	});
});

describe("agent loop rejection guard", () => {
	// A throw on the synchronous path to the first await (here: convertToLlm) must
	// NOT become an unhandled rejection (fatal under Node's default) and must NOT
	// hang the for-await consumer. The loop's `.then` rejection handler converts
	// it into a terminal failure turn ending in `agent_end`.
	async function consumeWithGuard(stream: ReturnType<typeof agentLoop>): Promise<{
		events: AgentEvent[];
		unhandled: unknown[];
	}> {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		const events: AgentEvent[] = [];
		try {
			// Race the drain against a timeout so a regression (stream never ends)
			// fails loudly instead of hanging the whole suite.
			const drain = (async () => {
				for await (const event of stream) events.push(event);
			})();
			const timeout = new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error("stream did not terminate (hung)")), 1000);
			});
			await Promise.race([drain, timeout]);
		} finally {
			// Give any queued microtask rejection a tick to surface before asserting.
			await new Promise((resolve) => setTimeout(resolve, 0));
			process.off("unhandledRejection", onUnhandled);
		}
		return { events, unhandled };
	}

	it("agentLoop: surfaces a terminal failure turn when convertToLlm throws (no unhandled rejection, no hang)", async () => {
		const context: AgentContext = { systemPrompt: "s", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: () => {
				throw new Error("boom in convertToLlm");
			},
		};

		const stream = agentLoop([createUserMessage("hi")], context, config);
		const { events, unhandled } = await consumeWithGuard(stream);

		// (a) no unhandled rejection escaped the loop.
		expect(unhandled).toEqual([]);
		// (b) the consumer saw a terminal agent_end and the stream resolved.
		const eventTypes = events.map((e) => e.type);
		expect(eventTypes).toContain("agent_end");
		const messages = await stream.result();
		const last = messages[messages.length - 1] as AssistantMessage;
		expect(last.role).toBe("assistant");
		expect(last.stopReason).toBe("error");
		// the error reason is carried through, not swallowed.
		expect(last.errorMessage).toMatch(/boom in convertToLlm/);
	});

	it("aborts overlong thinking mid-stream, injects a reminder, and retries the turn", async () => {
		let streamCalls = 0;
		const context: AgentContext = { systemPrompt: "s", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			overthinkGuard: { enabled: true, tokenThreshold: 10, maxRetriesPerTurn: 2 },
		};
		const streamFn = () => {
			streamCalls++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (streamCalls === 1) {
					const partial = createAssistantMessage([{ type: "thinking", thinking: "" }]);
					stream.push({ type: "start", partial });
					stream.push({ type: "thinking_start", contentIndex: 0, partial });
					const longThinking = "x".repeat(THINKING_CHARS_PER_TOKEN * 10);
					stream.push({
						type: "thinking_delta",
						contentIndex: 0,
						delta: longThinking,
						partial: createAssistantMessage([{ type: "thinking", thinking: longThinking }]),
					});
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "thinking", thinking: longThinking }]),
					});
					return;
				}
				const message = createAssistantMessage([{ type: "text", text: "acting now" }]);
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const loop = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
		for await (const event of loop) events.push(event);
		const messages = await loop.result();

		expect(streamCalls).toBe(2);
		const reminder = messages.find(
			(m) => m.role === "user" && (m as { _overthink_injected?: boolean })._overthink_injected,
		);
		expect(reminder).toBeDefined();
		expect(
			messages.some((m) => m.role === "assistant" && (m as { _stream_guard_abort?: boolean })._stream_guard_abort),
		).toBe(false);
		const assistant = messages[messages.length - 1] as AssistantMessage;
		expect(assistant.content[0]).toEqual({ type: "text", text: "acting now" });
	});

	it("emits message_end on overthink interrupt without retaining the partial assistant turn", async () => {
		const context: AgentContext = { systemPrompt: "s", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			overthinkGuard: { enabled: true, tokenThreshold: 10, maxRetriesPerTurn: 2 },
		};
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const partial = createAssistantMessage([{ type: "thinking", thinking: "" }]);
				stream.push({ type: "start", partial });
				stream.push({ type: "thinking_start", contentIndex: 0, partial });
				const longThinking = "x".repeat(THINKING_CHARS_PER_TOKEN * 10);
				stream.push({
					type: "thinking_delta",
					contentIndex: 0,
					delta: longThinking,
					partial: createAssistantMessage([{ type: "thinking", thinking: longThinking }]),
				});
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "thinking", thinking: longThinking }]),
				});
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const loop = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
		for await (const event of loop) events.push(event);
		const messages = await loop.result();

		const guardAbortEnds = events.filter(
			(e) =>
				e.type === "message_end" &&
				e.message.role === "assistant" &&
				(e.message as { _stream_guard_abort?: boolean })._stream_guard_abort,
		);
		expect(guardAbortEnds.length).toBeGreaterThan(0);
		expect(
			messages.some((m) => m.role === "assistant" && (m as { _stream_guard_abort?: boolean })._stream_guard_abort),
		).toBe(false);
	});

	it("aborts overlong plain-text reasoning mid-stream when watchTextDelta is on", async () => {
		let streamCalls = 0;
		const context: AgentContext = { systemPrompt: "s", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			overthinkGuard: { enabled: true, tokenThreshold: 10, maxRetriesPerTurn: 2, watchTextDelta: true },
		};
		const streamFn = () => {
			streamCalls++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (streamCalls === 1) {
					const partial = createAssistantMessage([{ type: "text", text: "" }]);
					stream.push({ type: "start", partial });
					stream.push({ type: "text_start", contentIndex: 0, partial });
					const longText = "x".repeat(THINKING_CHARS_PER_TOKEN * 10);
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: longText,
						partial: createAssistantMessage([{ type: "text", text: longText }]),
					});
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: longText }]),
					});
					return;
				}
				const message = createAssistantMessage([{ type: "text", text: "acting now" }]);
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const loop = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
		for await (const _ of loop) {
			// consume
		}
		const messages = await loop.result();

		expect(streamCalls).toBe(2);
		expect(
			messages.some((m) => m.role === "user" && (m as { _overthink_injected?: boolean })._overthink_injected),
		).toBe(true);
	});

	it("agentLoopContinue: surfaces a terminal failure turn when convertToLlm throws", async () => {
		const context: AgentContext = {
			systemPrompt: "s",
			messages: [createUserMessage("hi")],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: () => {
				throw new Error("boom in continue");
			},
		};

		const stream = agentLoopContinue(context, config);
		const { events, unhandled } = await consumeWithGuard(stream);

		expect(unhandled).toEqual([]);
		expect(events.map((e) => e.type)).toContain("agent_end");
		const messages = await stream.result();
		const last = messages[messages.length - 1] as AssistantMessage;
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toMatch(/boom in continue/);
	});

	it("regression: per-tool abort works on the sequential execution path", async () => {
		const toolAbortControllers = new Map<string, AbortController>();
		let sawAbort = false;
		const toolSchema = Type.Object({});
		const hangTool: AgentTool<typeof toolSchema, undefined> = {
			name: "hang",
			label: "Hang",
			description: "Blocks until per-tool abort",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, _params, signal) {
				await new Promise<void>((_resolve, reject) => {
					if (signal?.aborted) {
						sawAbort = true;
						reject(new Error("aborted"));
						return;
					}
					signal?.addEventListener(
						"abort",
						() => {
							sawAbort = true;
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				});
				return { content: [{ type: "text", text: "done" }], details: undefined };
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [hangTool],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolAbortControllers,
		};

		let streamCalls = 0;
		const stream = agentLoop([createUserMessage("hang")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			const call = ++streamCalls;
			queueMicrotask(() => {
				if (call === 1) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-hang", name: "hang", arguments: {} }],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					// After the aborted tool result, the loop may request another turn.
					const message = createAssistantMessage([{ type: "text", text: "stopped" }], "stop");
					mockStream.push({ type: "done", reason: "stop", message });
				}
			});
			return mockStream;
		});

		const consume = (async () => {
			for await (const _event of stream) {
				// drain
			}
		})();

		await vi.waitFor(() => expect(toolAbortControllers.has("tool-hang")).toBe(true));
		toolAbortControllers.get("tool-hang")!.abort();

		await consume;
		expect(sawAbort).toBe(true);
	});

	it("sequential abort synthesizes Operation aborted results for remaining tool calls", async () => {
		const toolSchema = Type.Object({});
		let firstStarted = false;
		const slowTool: AgentTool<typeof toolSchema, undefined> = {
			name: "slow",
			label: "Slow",
			description: "First tool; abort mid-batch after it starts",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, _params, signal) {
				firstStarted = true;
				await new Promise<void>((_resolve, reject) => {
					signal?.addEventListener(
						"abort",
						() => {
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				});
				return { content: [{ type: "text", text: "done" }], details: undefined };
			},
		};
		const secondTool: AgentTool<typeof toolSchema, undefined> = {
			name: "second",
			label: "Second",
			description: "Must still get a synthetic aborted result",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute() {
				return { content: [{ type: "text", text: "should-not-run" }], details: undefined };
			},
		};

		const runAbort = new AbortController();
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [slowTool, secondTool],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "sequential",
		};

		const stream = agentLoop([createUserMessage("go")], context, config, runAbort.signal, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[
						{ type: "toolCall", id: "tc-1", name: "slow", arguments: {} },
						{ type: "toolCall", id: "tc-2", name: "second", arguments: {} },
					],
					"toolUse",
				);
				mockStream.push({ type: "done", reason: "toolUse", message });
			});
			return mockStream;
		});

		const toolResults: Array<{ toolCallId: string; isError?: boolean; content: unknown }> = [];
		const consume = (async () => {
			for await (const event of stream) {
				if (event.type === "message_end" && event.message.role === "toolResult") {
					toolResults.push({
						toolCallId: event.message.toolCallId,
						isError: event.message.isError,
						content: event.message.content,
					});
				}
			}
		})();

		await vi.waitFor(() => expect(firstStarted).toBe(true));
		runAbort.abort();
		await consume;

		expect(toolResults.map((r) => r.toolCallId).sort()).toEqual(["tc-1", "tc-2"]);
		const second = toolResults.find((r) => r.toolCallId === "tc-2");
		expect(second?.isError).toBe(true);
		expect(JSON.stringify(second?.content)).toContain("Operation aborted");
	});
});

describe("P04 message_update fire-and-forget", () => {
	it("keeps draining the provider stream while a message_update listener is slow", async () => {
		const context: AgentContext = {
			systemPrompt: "s",
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let releaseFirstUpdate!: () => void;
		const firstUpdateParked = new Promise<void>((resolve) => {
			releaseFirstUpdate = resolve;
		});
		let firstUpdateStarted = false;
		let updatesFinished = 0;
		let messageEndSeen = false;
		let streamedPartial: AssistantMessage | undefined;

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				streamedPartial = createAssistantMessage([{ type: "text", text: "" }]);
				stream.push({ type: "start", partial: streamedPartial });
				// Distinct contentIndex forces a flush per delta (no coalesce).
				for (let i = 0; i < 8; i++) {
					const text = "x".repeat(i + 1);
					streamedPartial.content = [{ type: "text", text }];
					stream.push({
						type: "text_delta",
						contentIndex: i,
						delta: "x",
						partial: streamedPartial,
					});
				}
				const final = createAssistantMessage([{ type: "text", text: "xxxxxxxx" }]);
				stream.push({ type: "done", reason: "stop", message: final });
			});
			return stream;
		};

		const loopPromise = runAgentLoop(
			[createUserMessage("hi")],
			context,
			config,
			async (event) => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					if (!firstUpdateStarted) {
						firstUpdateStarted = true;
						await firstUpdateParked;
					}
					updatesFinished++;
					expect(messageEndSeen).toBe(false);
				}
				if (event.type === "message_end" && event.message.role === "assistant") {
					messageEndSeen = true;
					expect(updatesFinished).toBeGreaterThan(0);
				}
			},
			undefined,
			streamFn,
		);

		await vi.waitFor(() => expect(firstUpdateStarted).toBe(true));
		// While the first update is parked, the loop must keep applying provider
		// deltas onto the shared partial (P04: emit is not awaited on the hot path).
		// Observe the streamFn partial — runAgentLoop copies context.messages.
		await vi.waitFor(() => {
			const block = streamedPartial?.content.find((b) => b.type === "text");
			expect(block && block.type === "text" ? block.text.length : 0).toBe(8);
		});
		releaseFirstUpdate();
		await loopPromise;

		expect(messageEndSeen).toBe(true);
		expect(updatesFinished).toBeGreaterThan(0);
	});

	it("drains all message_update emits before message_end", async () => {
		const context: AgentContext = {
			systemPrompt: "s",
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};
		const order: string[] = [];

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const partial = createAssistantMessage([{ type: "text", text: "" }]);
				stream.push({ type: "start", partial });
				for (let i = 0; i < 5; i++) {
					partial.content = [{ type: "text", text: "x".repeat(i + 1) }];
					stream.push({
						type: "text_delta",
						contentIndex: i,
						delta: "x",
						partial,
					});
				}
				const final = createAssistantMessage([{ type: "text", text: "xxxxx" }]);
				stream.push({ type: "done", reason: "stop", message: final });
			});
			return stream;
		};

		await runAgentLoop(
			[createUserMessage("hi")],
			context,
			config,
			async (event) => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					await new Promise((r) => setTimeout(r, 5));
					order.push("update");
				}
				if (event.type === "message_end" && event.message.role === "assistant") {
					order.push("end");
				}
			},
			undefined,
			streamFn,
		);

		expect(order.at(-1)).toBe("end");
		expect(order.filter((x) => x === "update").length).toBeGreaterThan(0);
		expect(order.indexOf("end")).toBeGreaterThan(order.lastIndexOf("update"));
	});

	it("aborts on TTSR mid-stream, injects a reminder, and retries the turn", async () => {
		let streamCalls = 0;
		const context: AgentContext = { systemPrompt: "s", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			ttsrMatcher: {
				reset: vi.fn(),
				feed(chunk, scope) {
					if (scope === "assistant_text" && chunk.includes("sorry")) {
						return { name: "no-apology", message: "Do not apologize." };
					}
				},
			},
		};
		const streamFn = () => {
			streamCalls++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (streamCalls === 1) {
					const partial = createAssistantMessage([{ type: "text", text: "" }]);
					stream.push({ type: "start", partial });
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: "sorry about that",
						partial: createAssistantMessage([{ type: "text", text: "sorry about that" }]),
					});
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "sorry about that" }]),
					});
					return;
				}
				const message = createAssistantMessage([{ type: "text", text: "ok" }]);
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const loop = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
		for await (const _event of loop) {
			/* drain */
		}
		const messages = await loop.result();

		expect(streamCalls).toBe(2);
		const reminder = messages.find((m) => m.role === "user" && (m as { _ttsr_injected?: boolean })._ttsr_injected);
		expect(reminder).toBeDefined();
		const assistant = messages[messages.length - 1] as AssistantMessage;
		expect(assistant.content[0]).toEqual({ type: "text", text: "ok" });
	});

	it("stops with [stop: ttsr] after exceeding TTSR retries", async () => {
		let streamCalls = 0;
		const context: AgentContext = { systemPrompt: "s", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			ttsrMatcher: {
				reset: vi.fn(),
				feed(_chunk, scope) {
					if (scope === "assistant_text") {
						return { name: "no-apology", message: "Do not apologize." };
					}
				},
			},
		};
		const streamFn = () => {
			streamCalls++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const partial = createAssistantMessage([{ type: "text", text: "" }]);
				stream.push({ type: "start", partial });
				stream.push({
					type: "text_delta",
					contentIndex: 0,
					delta: "sorry",
					partial: createAssistantMessage([{ type: "text", text: "sorry" }]),
				});
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "sorry" }]),
				});
			});
			return stream;
		};

		const loop = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
		for await (const _event of loop) {
			/* drain */
		}
		const messages = await loop.result();
		expect(streamCalls).toBe(4); // 3 retries + final error turn still streams once more? Actually: initial + 3 retries = 4, then error without another stream
		const last = messages[messages.length - 1] as AssistantMessage;
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toMatch(/\[stop: ttsr\]/);
	});

	// A stateful matcher mirroring the real TTSR rolling buffer: feeds are
	// concatenative, so detection is a property of the accumulated stream, not
	// of the chunking. Records every fed chunk so tests can assert the feed
	// CADENCE (coalesced vs per-delta) independently of detection.
	function makeBufferedMatcher(needle: string) {
		let buf = "";
		const feeds: string[] = [];
		const matcher = {
			reset: () => {
				buf = "";
			},
			feed(chunk: string, scope: "assistant_text" | "tool_args") {
				feeds.push(chunk);
				if (scope !== "assistant_text") return undefined;
				buf += chunk;
				if (buf.includes(needle)) {
					buf = "";
					return { name: "span-rule", message: "matched across chunks" };
				}
				return undefined;
			},
		};
		return { matcher, feeds };
	}

	it("TTSR coalesced feed: identical detection, remainder fed by the FINAL flush", async () => {
		// Freeze performance.now (fake clock, never advanced) so the 16ms
		// coalescing window can never elapse mid-stream. The cadence is then
		// fully deterministic: the FIRST delta still flushes immediately (the
		// deliberate lastEmitTime=0 first-paint design), every later delta stays
		// pending, and only the final drain at `done` feeds the remainder. Real
		// setTimeout stays live (the loop's terminal-event sentinel depends on it).
		vi.useFakeTimers({ toFake: ["performance"] });
		try {
			let streamCalls = 0;
			const { matcher, feeds } = makeBufferedMatcher("forbidden");
			const context: AgentContext = { systemPrompt: "s", messages: [], tools: [] };
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				ttsrMatcher: matcher,
			};
			const streamFn = () => {
				streamCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (streamCalls === 1) {
						const partial = createAssistantMessage([{ type: "text", text: "" }]);
						stream.push({ type: "start", partial });
						for (const [i, delta] of ["forb", "idden", " tail"].entries()) {
							stream.push({
								type: "text_delta",
								contentIndex: 0,
								delta,
								partial: createAssistantMessage([
									{ type: "text", text: ["forb", "forbidden", "forbidden tail"][i]! },
								]),
							});
						}
						stream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "forbidden tail" }]),
						});
						return;
					}
					const message = createAssistantMessage([{ type: "text", text: "ok" }]);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			};

			const loop = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
			for await (const _event of loop) {
				/* drain */
			}
			const messages = await loop.result();

			// Detection identical to the per-delta feed: rule fired, turn replayed.
			expect(streamCalls).toBe(2);
			const reminder = messages.find((m) => m.role === "user" && (m as { _ttsr_injected?: boolean })._ttsr_injected);
			expect(reminder).toBeDefined();
			const assistant = messages[messages.length - 1] as AssistantMessage;
			expect(assistant.content[0]).toEqual({ type: "text", text: "ok" });
			// Coalesced cadence: the matcher saw the identical character stream in
			// TWO feeds — the immediate first-paint flush ("forb") plus the final
			// end-of-message drain carrying the coalesced remainder ("idden tail")
			// — instead of one regex pass per raw delta.
			expect(feeds).toEqual(["forb", "idden tail"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("TTSR per-delta feed is restored under PIT_NO_TTSR_COALESCED_FEED=1", async () => {
		const prev = process.env.PIT_NO_TTSR_COALESCED_FEED;
		process.env.PIT_NO_TTSR_COALESCED_FEED = "1";
		try {
			let streamCalls = 0;
			const { matcher, feeds } = makeBufferedMatcher("forbidden");
			const context: AgentContext = { systemPrompt: "s", messages: [], tools: [] };
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				ttsrMatcher: matcher,
			};
			const streamFn = () => {
				streamCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (streamCalls === 1) {
						const partial = createAssistantMessage([{ type: "text", text: "" }]);
						stream.push({ type: "start", partial });
						for (const [i, delta] of ["forb", "idden", " tail"].entries()) {
							stream.push({
								type: "text_delta",
								contentIndex: 0,
								delta,
								partial: createAssistantMessage([
									{ type: "text", text: ["forb", "forbidden", "forbidden tail"][i]! },
								]),
							});
						}
						stream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "forbidden tail" }]),
						});
						return;
					}
					const message = createAssistantMessage([{ type: "text", text: "ok" }]);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			};

			const loop = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
			for await (const _event of loop) {
				/* drain */
			}
			await loop.result();

			// Same detection, but fed once per raw delta: the hit fires ON the
			// second chunk and the stream aborts before " tail" is ever fed.
			expect(streamCalls).toBe(2);
			expect(feeds).toEqual(["forb", "idden"]);
		} finally {
			if (prev === undefined) delete process.env.PIT_NO_TTSR_COALESCED_FEED;
			else process.env.PIT_NO_TTSR_COALESCED_FEED = prev;
		}
	});

	it("synthesizes an error turn when the stream ends without a terminal event", async () => {
		const context: AgentContext = { systemPrompt: "s", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const partial = createAssistantMessage([{ type: "text", text: "partial" }]);
				stream.push({ type: "start", partial });
				stream.end();
			});
			return stream;
		};

		const loop = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
		for await (const _event of loop) {
			/* drain */
		}
		const messages = await loop.result();
		const last = messages[messages.length - 1] as AssistantMessage;
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toMatch(/Stream ended without a terminal event/);
	});
});
