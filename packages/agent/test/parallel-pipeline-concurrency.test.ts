/**
 * P2-8 — the parallel executor runs one prepare→execute→finalize PIPELINE per
 * tool call, with no barrier between the stages.
 *
 * Why this matters: P1 (speculative execution) made the prepare stage of a
 * consumed speculation expensive — it awaits the speculative prepare AND execute.
 * With the old two-phase shape (`Promise.all(prepare)` → barrier →
 * `Promise.all(finalize)`), a batch like `[slow speculated grep, bash]` could not
 * start bash's execute until the grep had fully finished. These tests pin the
 * pipeline down with a gated speculative tool: a non-speculated sibling must
 * finish its execute while the speculative outcome is still parked.
 *
 * Harness mirrors speculative-execution.test.ts (realistic streamed tool calls,
 * since P1 only fires off `toolcall_end`).
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
import { describe, expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.js";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
} from "../src/types.js";

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
	} as AssistantMessage;
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

type StreamedCall = { id: string; name: string; arguments: Record<string, unknown> };

/** Emits the realistic streamed sequence so speculation (which fires off `toolcall_end`) can start. */
function pushStreamedToolCalls(stream: MockAssistantStream, calls: StreamedCall[]): void {
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

/** streamFn that serves `calls` on the first turn (streamed, then `done`) and a plain stop afterwards. */
function makeStreamFn(calls: StreamedCall[]): () => MockAssistantStream {
	let turn = 0;
	return () => {
		const stream = new MockAssistantStream();
		const current = ++turn;
		queueMicrotask(() => {
			if (current > 1) {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "done" }], "stop"),
				});
				return;
			}
			pushStreamedToolCalls(stream, calls);
			setTimeout(() => {
				stream.push({
					type: "done",
					reason: "toolUse",
					message: createAssistantMessage(
						calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.arguments })),
						"toolUse",
					),
				});
			}, 10);
		});
		return stream;
	};
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function startIds(events: AgentEvent[]): string[] {
	return events.flatMap((e) => (e.type === "tool_execution_start" ? [e.toolCallId] : []));
}

function endIds(events: AgentEvent[]): string[] {
	return events.flatMap((e) => (e.type === "tool_execution_end" ? [e.toolCallId] : []));
}

function resultMessageIds(events: AgentEvent[]): string[] {
	return events.flatMap((e) =>
		e.type === "message_end" && e.message.role === "toolResult" ? [e.message.toolCallId] : [],
	);
}

describe("P2-8 parallel executor pipeline (no prepare/execute barrier)", () => {
	it("a non-speculated sibling finishes its execute while the speculated call is still in flight", async () => {
		const order: string[] = [];
		const specGate = createDeferred();
		let specSettled = false;
		let fastDone = false;

		const specTool: AgentTool = {
			name: "slow_spec",
			label: "slow_spec",
			description: "",
			parameters: Type.Object({}, { additionalProperties: true }),
			speculationSafe: true,
			async execute() {
				order.push("spec:execute-start");
				await specGate.promise;
				specSettled = true;
				order.push("spec:execute-end");
				return { content: [{ type: "text", text: "spec" }], details: {} };
			},
		};
		const fastTool: AgentTool = {
			name: "fast",
			label: "fast",
			description: "",
			parameters: Type.Object({}, { additionalProperties: true }),
			// NOT speculationSafe: only runs post-stream, through the parallel executor.
			async execute() {
				order.push("fast:execute-start");
				fastDone = true;
				order.push("fast:execute-end");
				return { content: [{ type: "text", text: "fast" }], details: {} };
			},
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [specTool, fastTool] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
		const stream = agentLoop(
			[{ role: "user", content: "go", timestamp: Date.now() } satisfies UserMessage],
			context,
			config,
			undefined,
			makeStreamFn([
				{ id: "spec-1", name: "slow_spec", arguments: { a: 1 } },
				{ id: "fast-1", name: "fast", arguments: { b: 2 } },
			]),
		);

		const events: AgentEvent[] = [];
		const consume = (async () => {
			for await (const event of stream) events.push(event);
		})();

		// THE assertion: the fast call's execute completes while the speculative
		// outcome is still parked. Under the old phase barrier the fast execute could
		// not even start until `spec.outcome` settled, so this would time out.
		await vi.waitFor(() => expect(fastDone).toBe(true));
		expect(specSettled).toBe(false);

		specGate.resolve();
		await consume;

		// Ordering proof, independent of the flags above.
		expect(order).toEqual(["spec:execute-start", "fast:execute-start", "fast:execute-end", "spec:execute-end"]);
		// Invariant: tool_execution_start stays in the ORIGINAL call order even though
		// the first call's pipeline parks and the second one races ahead.
		expect(startIds(events)).toEqual(["spec-1", "fast-1"]);
		// tool_execution_end follows completion order (unchanged semantics)...
		expect(endIds(events)).toEqual(["fast-1", "spec-1"]);
		// ...while the deferred result-message fan-out stays in ORIGINAL order.
		expect(resultMessageIds(events)).toEqual(["spec-1", "fast-1"]);
	});

	it("partitioned batch: the parallel subset pipelines overlap, the sequential subset still waits for all of them", async () => {
		const order: string[] = [];
		const specGate = createDeferred();
		let fastDone = false;
		let specSettled = false;

		const specTool: AgentTool = {
			name: "slow_spec",
			label: "slow_spec",
			description: "",
			parameters: Type.Object({}, { additionalProperties: true }),
			speculationSafe: true,
			async execute() {
				order.push("spec:execute-start");
				await specGate.promise;
				specSettled = true;
				order.push("spec:execute-end");
				return { content: [{ type: "text", text: "spec" }], details: {} };
			},
		};
		const fastTool: AgentTool = {
			name: "fast",
			label: "fast",
			description: "",
			parameters: Type.Object({}, { additionalProperties: true }),
			async execute() {
				order.push("fast:execute-start");
				fastDone = true;
				return { content: [{ type: "text", text: "fast" }], details: {} };
			},
		};
		const seqTool: AgentTool = {
			name: "seq",
			label: "seq",
			description: "",
			parameters: Type.Object({}, { additionalProperties: true }),
			executionMode: "sequential",
			async execute() {
				order.push("seq:execute-start");
				return { content: [{ type: "text", text: "seq" }], details: {} };
			},
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [specTool, fastTool, seqTool] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
		const stream = agentLoop(
			[{ role: "user", content: "go", timestamp: Date.now() } satisfies UserMessage],
			context,
			config,
			undefined,
			makeStreamFn([
				{ id: "spec-1", name: "slow_spec", arguments: { a: 1 } },
				{ id: "seq-1", name: "seq", arguments: { s: 1 } },
				{ id: "fast-1", name: "fast", arguments: { b: 2 } },
			]),
		);

		const events: AgentEvent[] = [];
		const consume = (async () => {
			for await (const event of stream) events.push(event);
		})();

		await vi.waitFor(() => expect(fastDone).toBe(true));
		// Parallel subset overlaps...
		expect(specSettled).toBe(false);
		// ...and design (a) holds: no sequential tool may start while the parallel
		// subset is still running.
		expect(order).not.toContain("seq:execute-start");

		specGate.resolve();
		await consume;

		expect(order).toEqual(["spec:execute-start", "fast:execute-start", "spec:execute-end", "seq:execute-start"]);
		// Parallel-subset starts precede the sequential one, and results are replayed
		// in the ORIGINAL toolCall order across both subsets.
		expect(startIds(events)).toEqual(["spec-1", "fast-1", "seq-1"]);
		expect(resultMessageIds(events)).toEqual(["spec-1", "seq-1", "fast-1"]);
	});
});
