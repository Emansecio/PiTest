/**
 * The tool executors must not leave orphaned tool calls when a `tool_execution_end`
 * listener throws mid-batch.
 *
 * In production this throw is the coding-agent's doom-loop Tier-3 relapse: a
 * listener on `tool_execution_end` throws to abort the turn (by design). The throw
 * unwinds through the executor. The default (parallel) executor emits the batch's
 * tool-RESULT messages only AFTER `Promise.all` over every call's
 * `tool_execution_end`; a throw from one of those events bails before the fan-out,
 * so EVERY call in the batch is left with an assistant `tool_use` and no paired
 * `tool_result` — a transcript the next provider request rejects.
 *
 * These tests inject the throw directly at the `emit` sink (the exact seam the
 * doom-loop listener throws from) so the mid-batch unwind is deterministic — the
 * doom-loop's own counter cannot climb inside a single parallel batch, and
 * extension listeners are isolated by the runner, so the sink is the faithful
 * injection point. The invariant asserted is transcript-level and abort-agnostic:
 * every assistant `toolCall` id has a matching `toolResult` message.
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
import { runAgentLoop } from "../src/agent-loop.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.js";

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

function assistantWithToolCalls(calls: Array<{ id: string; name: string }>): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: {} })),
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

const identityConverter = (messages: AgentMessage[]): Message[] =>
	messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: "",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: `${name} ok` }], details: {} }),
	};
}

/** Collect assistant toolCall ids that have no matching toolResult across emitted message_end events. */
function orphanIdsFromEvents(events: AgentEvent[]): string[] {
	const resultIds = new Set<string>();
	const toolCallIds: Array<{ id: string; name: string }> = [];
	for (const event of events) {
		if (event.type !== "message_end") continue;
		const message = event.message;
		if (message.role === "toolResult") resultIds.add(message.toolCallId);
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "toolCall") toolCallIds.push({ id: part.id, name: part.name });
			}
		}
	}
	return toolCallIds.filter((c) => !resultIds.has(c.id)).map((c) => `${c.name}#${c.id}`);
}

/**
 * Drive one turn whose assistant message issues `calls` as a parallel batch, with
 * an `emit` sink that throws on the `tool_execution_end` of `throwOnToolCallId`
 * (simulating the doom-loop listener). Returns the events emitted before/through
 * the unwind.
 */
async function runBatchWithThrow(
	calls: Array<{ id: string; name: string }>,
	throwOnToolCallId: string,
): Promise<{ events: AgentEvent[]; threw: boolean }> {
	const tools = Array.from(new Set(calls.map((c) => c.name))).map(makeTool);
	const context: AgentContext = { systemPrompt: "s", messages: [], tools };
	const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

	let served = false;
	const streamFn = () => {
		const stream = new MockAssistantStream();
		const message = served
			? ({
					...assistantWithToolCalls([]),
					content: [{ type: "text", text: "done" }],
					stopReason: "stop",
				} as AssistantMessage)
			: assistantWithToolCalls(calls);
		served = true;
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
		return stream;
	};

	const events: AgentEvent[] = [];
	const emit = async (event: AgentEvent): Promise<void> => {
		events.push(event);
		if (event.type === "tool_execution_end" && event.toolCallId === throwOnToolCallId) {
			throw new Error("doom-loop-style abort from tool_execution_end listener");
		}
	};

	let threw = false;
	try {
		await runAgentLoop(
			[{ role: "user", content: "go", timestamp: Date.now() } satisfies UserMessage],
			context,
			config,
			emit,
			undefined,
			streamFn,
		);
	} catch {
		threw = true;
	}
	return { events, threw };
}

describe("tool-result pairing when a tool_execution_end listener throws", () => {
	it("pairs every call in a PARALLEL batch when the throw bails before the result fan-out", async () => {
		const calls = [
			{ id: "call-a", name: "boom" },
			{ id: "call-b", name: "ok" },
		];
		const { events, threw } = await runBatchWithThrow(calls, "call-a");

		// The throw propagated (turn aborts — the doom-loop behavior is preserved).
		expect(threw).toBe(true);
		// Both tool_use blocks are paired despite the mid-batch unwind.
		expect(orphanIdsFromEvents(events)).toEqual([]);
	});

	it("pairs a single-call batch aborted at tool_execution_end", async () => {
		const calls = [{ id: "solo", name: "boom" }];
		const { events, threw } = await runBatchWithThrow(calls, "solo");
		expect(threw).toBe(true);
		expect(orphanIdsFromEvents(events)).toEqual([]);
	});
});
