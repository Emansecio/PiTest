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
import { ToolErrorHintRegistry } from "../src/tool-error-hint-registry.js";
import { ToolRewriteRegistry } from "../src/tool-rewrite-registry.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.js";

/**
 * Audit fix (2026-06): Tier-4 hint rules used to run only inside
 * finalizeExecutedToolCall, which the "immediate" outcome branch (unknown
 * tool, schema/validation failure, beforeToolCall block) skipped — making
 * rules that target exactly those errors unreachable. Immediate errors now
 * flow through the same hint enrichment, EXCEPT rewrite-registry rejections
 * and aborts, whose text is already a deliberate, self-contained refusal.
 */

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

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function catchAllHintRegistry(): ToolErrorHintRegistry {
	const registry = new ToolErrorHintRegistry();
	registry.add({
		id: "catch-all",
		appliesTo: "*",
		matcher: () => true,
		hint: () => "HINT-FIRED",
	});
	return registry;
}

/**
 * Runs a loop whose first turn issues `toolCall` and whose second turn ends
 * with plain text, returning all events plus the final message list.
 */
async function runLoopWithToolCall(
	context: AgentContext,
	config: AgentLoopConfig,
	toolCall: { id: string; name: string; arguments: Record<string, unknown> },
): Promise<{ events: AgentEvent[]; messages: AgentMessage[] }> {
	let streamCalls = 0;
	const streamFn = () => {
		streamCalls++;
		const stream = new MockAssistantStream();
		const n = streamCalls;
		queueMicrotask(() => {
			const message =
				n === 1
					? createAssistantMessage([{ type: "toolCall", ...toolCall }])
					: createAssistantMessage([{ type: "text", text: "done" }]);
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};

	const events: AgentEvent[] = [];
	const stream = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
	for await (const event of stream) events.push(event);
	const messages = await stream.result();
	return { events, messages };
}

function toolResultText(messages: AgentMessage[]): string {
	const toolResult = messages.find((m) => m.role === "toolResult");
	return JSON.stringify(toolResult ?? {});
}

describe("immediate tool errors flow through the Tier-4 hint registry", () => {
	it("enriches an unknown-tool immediate error with hints", async () => {
		const context: AgentContext = { systemPrompt: "s", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolErrorHintRegistry: catchAllHintRegistry(),
		};
		const { events, messages } = await runLoopWithToolCall(context, config, {
			id: "c1",
			name: "no_such_tool",
			arguments: {},
		});

		expect(toolResultText(messages)).toContain("HINT-FIRED");
		expect(events.map((e) => e.type)).toContain("tool_error_hint_applied");
	});

	it("enriches a schema-validation immediate error with hints", async () => {
		const strictTool: AgentTool = {
			name: "strict",
			label: "strict",
			description: "",
			parameters: Type.Object({ value: Type.Number() }, { additionalProperties: false }),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
		};
		const context: AgentContext = { systemPrompt: "s", messages: [], tools: [strictTool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolErrorHintRegistry: catchAllHintRegistry(),
		};
		const { events, messages } = await runLoopWithToolCall(context, config, {
			id: "c1",
			name: "strict",
			arguments: { value: "not-a-number" },
		});

		expect(toolResultText(messages)).toContain("HINT-FIRED");
		expect(events.map((e) => e.type)).toContain("tool_error_hint_applied");
	});

	it("does NOT enrich rewrite-registry rejections (deliberate refusals)", async () => {
		const pingTool: AgentTool = {
			name: "ping",
			label: "ping",
			description: "",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "pong" }], details: {} }),
		};
		const rewriteRegistry = new ToolRewriteRegistry();
		rewriteRegistry.add({
			id: "block-ping",
			appliesTo: "ping",
			matcher: () => true,
			action: { tier: "block", reason: () => "ping is blocked by policy" },
		});
		const context: AgentContext = { systemPrompt: "s", messages: [], tools: [pingTool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolErrorHintRegistry: catchAllHintRegistry(),
			toolRewriteRegistry: rewriteRegistry,
		};
		const { events, messages } = await runLoopWithToolCall(context, config, {
			id: "c1",
			name: "ping",
			arguments: {},
		});

		const text = toolResultText(messages);
		expect(text).toContain("ping is blocked by policy");
		expect(text).not.toContain("HINT-FIRED");
		expect(events.map((e) => e.type)).not.toContain("tool_error_hint_applied");
	});
});
