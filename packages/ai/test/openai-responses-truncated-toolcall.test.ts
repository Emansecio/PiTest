import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, AssistantMessageEvent, Model, ToolCall } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

const SCRATCH_KEYS = ["partialJson", "partialArgs", "index", "streamIndex"] as const;

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

function onlyToolCall(output: AssistantMessage): ToolCall {
	const block = output.content.find((c): c is ToolCall => c.type === "toolCall");
	if (!block) throw new Error("No toolCall block in output.content");
	return block;
}

function expectNoScratch(output: AssistantMessage): void {
	for (const block of output.content) {
		for (const key of SCRATCH_KEYS) {
			expect({ type: block.type, key, present: key in block }).toEqual({
				type: block.type,
				key,
				present: false,
			});
		}
	}
}

/**
 * H10 — the model hits `max_output_tokens` mid-arguments: the wire sends
 * `output_item.added` + a run of `function_call_arguments.delta`, then the
 * terminal event, with NO `function_call_arguments.done` and NO
 * `output_item.done`. Before the fix the block kept `arguments: {}` (every
 * accumulated delta discarded) and leaked its `partialJson` scratch into the
 * persisted transcript.
 */
describe("processResponsesStream — H10 tool call left open at a terminal event", () => {
	// The codex routes normalize `response.incomplete` to `response.completed`
	// with status `incomplete` (mapCodexEvents), so this is the shape that reaches
	// the parser on the codex SSE/WebSocket paths.
	it("finalizes accumulated arguments on response.completed with status incomplete", async () => {
		const model = makeModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		const events: ResponseStreamEvent[] = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_T", call_id: "call_T", name: "bash", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_T", output_index: 0, delta: '{"command":' },
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_T",
				output_index: 0,
				delta: '"npm run build"}',
			},
			// No arguments.done, no output_item.done — the response just ends.
			{ type: "response.completed", response: { status: "incomplete" } },
		] as unknown as ResponseStreamEvent[];

		await processResponsesStream(fromEvents(events), output, stream, model);

		const toolCall = onlyToolCall(output);
		expect(toolCall.id).toBe("call_T|fc_T");
		expect(toolCall.name).toBe("bash");
		// The whole point: the accumulated deltas must survive, not be dropped.
		expect(toolCall.arguments).toEqual({ command: "npm run build" });
		expect(toolCall.arguments).not.toEqual({});
		expectNoScratch(output);
		// status incomplete → length; the toolUse upgrade only applies to "stop".
		expect(output.stopReason).toBe("length");

		// The harness already saw toolcall_start + deltas; it must also get the end,
		// pointing at the persisted block (H9's stream/message agreement invariant).
		const emitted = pushSpy.mock.calls.map(([e]) => e as AssistantMessageEvent);
		const ends = emitted.filter((e) => e.type === "toolcall_end");
		expect(ends).toHaveLength(1);
		const end = ends[0];
		if (!end || end.type !== "toolcall_end") throw new Error("expected toolcall_end");
		expect(end.toolCall).toBe(toolCall);
		expect(output.content[end.contentIndex]).toBe(toolCall);
		expect("partialJson" in end.toolCall).toBe(false);
	});

	// `response.incomplete` is its own event in the Responses SDK union and is what
	// the direct openai-responses route receives verbatim. It used to be unhandled,
	// so the turn died as "Stream ended without response.completed".
	it("treats a native response.incomplete event as terminal and finalizes the call", async () => {
		const model = makeModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		const events: ResponseStreamEvent[] = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_U", call_id: "call_U", name: "read", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_U", output_index: 0, delta: '{"path":"REA' },
			{
				type: "response.incomplete",
				response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
			},
		] as unknown as ResponseStreamEvent[];

		await expect(processResponsesStream(fromEvents(events), output, stream, model)).resolves.toBeUndefined();

		const toolCall = onlyToolCall(output);
		// Best-effort partial parse of the truncated buffer — still not `{}`.
		expect(toolCall.arguments).toEqual({ path: "REA" });
		expectNoScratch(output);
		expect(output.stopReason).toBe("length");
	});

	// Keyless streams (field-stripped proxies omit item_id) are never registered in
	// the item_id map, so the drain must scan content rather than that map.
	it("drains a keyless open tool call (no item_id on the argument deltas)", async () => {
		const model = makeModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		const events: ResponseStreamEvent[] = [
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "", call_id: "call_K", name: "edit", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", delta: '{"path":"a.txt","content":"x"}' },
			{ type: "response.completed", response: { status: "incomplete" } },
		] as unknown as ResponseStreamEvent[];

		await processResponsesStream(fromEvents(events), output, stream, model);

		expect(onlyToolCall(output).arguments).toEqual({ path: "a.txt", content: "x" });
		expectNoScratch(output);
	});

	// The drain is gated on the block still owning `partialJson`, which
	// output_item.done deletes — so a normally-finalized call must not be
	// re-finalized or get a second toolcall_end.
	it("does not emit a duplicate toolcall_end when output_item.done did arrive", async () => {
		const model = makeModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		const events: ResponseStreamEvent[] = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_D", call_id: "call_D", name: "read", arguments: "" },
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_D",
				output_index: 0,
				delta: '{"path":"a.txt"}',
			},
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_D",
				output_index: 0,
				arguments: '{"path":"a.txt"}',
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "function_call", id: "fc_D", call_id: "call_D", name: "read", arguments: '{"path":"a.txt"}' },
			},
			{ type: "response.completed", response: { status: "incomplete" } },
		] as unknown as ResponseStreamEvent[];

		await processResponsesStream(fromEvents(events), output, stream, model);

		const emitted = pushSpy.mock.calls.map(([e]) => e as AssistantMessageEvent);
		expect(emitted.filter((e) => e.type === "toolcall_end")).toHaveLength(1);
		expect(onlyToolCall(output).arguments).toEqual({ path: "a.txt" });
		expectNoScratch(output);
	});
});

describe("processResponsesStream — no streaming scratch on the success path", () => {
	// The scratch strip used to run ONLY in each provider's `catch`. A fully
	// successful turn must be scratch-free too: every content block that lands in
	// the persisted transcript is swept at the shared chokepoint.
	it("leaves no scratch fields on any block of a normally completed turn", async () => {
		const model = makeModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		const events: ResponseStreamEvent[] = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_1", summary: [] },
			},
			{ type: "response.reasoning_text.delta", output_index: 0, delta: "thinking" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }] },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{
				type: "response.content_part.added",
				output_index: 1,
				part: { type: "output_text", text: "", annotations: [] },
			},
			{ type: "response.output_text.delta", output_index: 1, delta: "hi" },
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "hi", annotations: [] }],
				},
			},
			{
				type: "response.output_item.added",
				output_index: 2,
				item: { type: "function_call", id: "fc_S", call_id: "call_S", name: "read", arguments: "" },
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_S",
				output_index: 2,
				delta: '{"path":"a.txt"}',
			},
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_S",
				output_index: 2,
				arguments: '{"path":"a.txt"}',
			},
			{
				type: "response.output_item.done",
				output_index: 2,
				item: { type: "function_call", id: "fc_S", call_id: "call_S", name: "read", arguments: '{"path":"a.txt"}' },
			},
			{ type: "response.completed", response: { status: "completed" } },
		] as unknown as ResponseStreamEvent[];

		await processResponsesStream(fromEvents(events), output, stream, model);

		expect(output.content.map((b) => b.type)).toEqual(["thinking", "text", "toolCall"]);
		expectNoScratch(output);
		expect(output.stopReason).toBe("toolUse");
		// A JSON round-trip is what actually hits the persisted transcript.
		expect(JSON.stringify(output)).not.toContain("partialJson");
	});
});
