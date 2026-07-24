import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, AssistantMessageEvent, Model, ToolCall } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

function makeModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5.1",
		name: "GPT-5.1",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function* fromEvents(events: ResponseStreamEvent[]): AsyncIterable<ResponseStreamEvent> {
	for (const event of events) {
		yield event;
	}
}

function toolCallById(output: AssistantMessage, callId: string): ToolCall {
	const block = output.content.find((c): c is ToolCall => c.type === "toolCall" && c.id.startsWith(`${callId}|`));
	if (!block) throw new Error(`No toolCall block for call_id ${callId}`);
	return block;
}

describe("processResponsesStream — H8 interleaved parallel tool calls", () => {
	// The Responses wire keys every function_call_arguments.{delta,done} event by
	// item_id (parallel_tool_calls: true, which Codex sends). The stream contract
	// permits a second function_call item to be `added` before the first item's
	// `done`. A parser that keeps a single current block would then route the
	// first call's argument deltas into the second call's block. Each toolCall
	// must end up with its OWN arguments.
	it("keeps each parallel tool call's arguments separate when items interleave", async () => {
		const model = makeModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		// item B is `added` before item A reaches `done`.
		const events: ResponseStreamEvent[] = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_A", call_id: "call_A", name: "read", arguments: "" },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "function_call", id: "fc_B", call_id: "call_B", name: "shell", arguments: "" },
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_A",
				output_index: 0,
				delta: '{"path":"a.txt"}',
			},
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_A",
				output_index: 0,
				arguments: '{"path":"a.txt"}',
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "function_call", id: "fc_A", call_id: "call_A", name: "read", arguments: '{"path":"a.txt"}' },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_B", output_index: 1, delta: '{"cmd":"ls"}' },
			{ type: "response.function_call_arguments.done", item_id: "fc_B", output_index: 1, arguments: '{"cmd":"ls"}' },
			{
				type: "response.output_item.done",
				output_index: 1,
				item: { type: "function_call", id: "fc_B", call_id: "call_B", name: "shell", arguments: '{"cmd":"ls"}' },
			},
			{ type: "response.completed", response: { status: "completed" } },
		] as unknown as ResponseStreamEvent[];

		await processResponsesStream(fromEvents(events), output, stream, model);

		const toolCalls = output.content.filter((c) => c.type === "toolCall");
		expect(toolCalls).toHaveLength(2);
		expect(toolCallById(output, "call_A").arguments).toEqual({ path: "a.txt" });
		expect(toolCallById(output, "call_B").arguments).toEqual({ cmd: "ls" });
		expect(output.stopReason).toBe("toolUse");
	});

	// Same demux requirement, but with the argument deltas themselves interleaved
	// frame-by-frame between the two open items.
	it("routes frame-by-frame interleaved argument deltas to the right block", async () => {
		const model = makeModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		const events: ResponseStreamEvent[] = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_A", call_id: "call_A", name: "read", arguments: "" },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "function_call", id: "fc_B", call_id: "call_B", name: "shell", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_A", output_index: 0, delta: '{"path":' },
			{ type: "response.function_call_arguments.delta", item_id: "fc_B", output_index: 1, delta: '{"cmd":' },
			{ type: "response.function_call_arguments.delta", item_id: "fc_A", output_index: 0, delta: '"a.txt"}' },
			{ type: "response.function_call_arguments.delta", item_id: "fc_B", output_index: 1, delta: '"ls"}' },
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_A",
				output_index: 0,
				arguments: '{"path":"a.txt"}',
			},
			{ type: "response.function_call_arguments.done", item_id: "fc_B", output_index: 1, arguments: '{"cmd":"ls"}' },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "function_call", id: "fc_A", call_id: "call_A", name: "read", arguments: '{"path":"a.txt"}' },
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: { type: "function_call", id: "fc_B", call_id: "call_B", name: "shell", arguments: '{"cmd":"ls"}' },
			},
			{ type: "response.completed", response: { status: "completed" } },
		] as unknown as ResponseStreamEvent[];

		await processResponsesStream(fromEvents(events), output, stream, model);

		expect(toolCallById(output, "call_A").arguments).toEqual({ path: "a.txt" });
		expect(toolCallById(output, "call_B").arguments).toEqual({ cmd: "ls" });

		// Every emitted tool event's contentIndex must actually point at the block
		// it describes (consumers index output.content[contentIndex]).
		const events2 = pushSpy.mock.calls.map(([e]) => e as AssistantMessageEvent);
		const indexA = output.content.indexOf(toolCallById(output, "call_A"));
		const indexB = output.content.indexOf(toolCallById(output, "call_B"));
		const endA = events2.find((e) => e.type === "toolcall_end" && e.toolCall.id.startsWith("call_A|"));
		const endB = events2.find((e) => e.type === "toolcall_end" && e.toolCall.id.startsWith("call_B|"));
		expect(endA && endA.type === "toolcall_end" && endA.contentIndex).toBe(indexA);
		expect(endB && endB.type === "toolcall_end" && endB.contentIndex).toBe(indexB);
	});
});

describe("processResponsesStream — H9 function_call output_item.done without added", () => {
	// A function_call `output_item.done` that never had a matching `added` must
	// still land in output.content, so the persisted message matches the
	// toolcall_end the harness already saw on the stream. (Reasoning/message
	// orphan dones are dropped by the parser; the function_call path used to emit
	// an event but never persist the block — a desync.)
	it("persists an orphan function_call done into content before emitting", async () => {
		const model = makeModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		const events: ResponseStreamEvent[] = [
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "function_call", id: "fc_X", call_id: "call_X", name: "read", arguments: '{"path":"x.txt"}' },
			},
			{ type: "response.completed", response: { status: "completed" } },
		] as unknown as ResponseStreamEvent[];

		await processResponsesStream(fromEvents(events), output, stream, model);

		expect(output.content).toHaveLength(1);
		const block = output.content[0];
		expect(block?.type).toBe("toolCall");
		if (!block || block.type !== "toolCall") throw new Error("expected toolCall block");
		expect(block.id).toBe("call_X|fc_X");
		expect(block.arguments).toEqual({ path: "x.txt" });
		// A tool call is present → the turn must stop for tool use, not "stop".
		expect(output.stopReason).toBe("toolUse");

		const emitted = pushSpy.mock.calls.map(([e]) => e as AssistantMessageEvent);
		const end = emitted.find((e) => e.type === "toolcall_end");
		expect(end).toBeDefined();
		if (!end || end.type !== "toolcall_end") throw new Error("expected toolcall_end");
		// contentIndex must resolve to the persisted block, not a stale/-1 index.
		expect(end.contentIndex).toBe(0);
		expect(output.content[end.contentIndex]).toBe(end.toolCall);
		expect(end.toolCall).toBe(block);
	});
});
