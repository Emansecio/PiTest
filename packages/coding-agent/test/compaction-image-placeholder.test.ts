import type { Message } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { serializeConversation, serializeConversationDelta } from "../src/core/compaction/utils.js";

// N9 — images must leave a placeholder in both serialized forms so a decision
// based on a screenshot is not silently lost at compaction time.

function image(): { type: "image"; data: string; mimeType: string } {
	return { type: "image", data: "AAAA", mimeType: "image/png" };
}

function userMsg(content: Message["content"]): Message {
	return { role: "user", content, timestamp: 1 } as Message;
}

function toolResult(name: string, content: Message["content"]): Message {
	return {
		role: "toolResult",
		toolCallId: "tc1",
		toolName: name,
		content,
		isError: false,
		timestamp: 1,
	} as Message;
}

type DeltaEvent = { k: string; n?: string; t?: string };
const parseDelta = (raw: string) => JSON.parse(raw) as DeltaEvent[];

describe("N9 image placeholder in summarization serialization", () => {
	it("prose emits [image] for an image block in a user message", () => {
		const prose = serializeConversation([userMsg([{ type: "text", text: "look at this" }, image()])]);
		expect(prose).toContain("[User]: look at this");
		expect(prose).toContain("[image]");
	});

	it("prose keeps an image-only user message that previously vanished", () => {
		const prose = serializeConversation([userMsg([image()])]);
		expect(prose).toBe("[image]");
	});

	it("delta emits {k:'img'} for a user image", () => {
		const raw = serializeConversationDelta([userMsg([{ type: "text", text: "hi" }, image()])]);
		expect(raw).toContain('"k":"img"');
		const events = parseDelta(raw);
		expect(events.map((e) => e.k)).toEqual(["u", "img"]);
		// User images carry no tool provenance.
		expect(events.find((e) => e.k === "img")?.n).toBeUndefined();
	});

	it("prose tags a tool-result image with its source tool", () => {
		const prose = serializeConversation([toolResult("chrome", [{ type: "text", text: "page loaded" }, image()])]);
		expect(prose).toContain("[Tool result]: page loaded");
		expect(prose).toContain("[image from chrome]");
	});

	it("delta tags a tool-result image with {k:'img', n:<tool>}", () => {
		const raw = serializeConversationDelta([toolResult("inspect_image", [image()])]);
		const events = parseDelta(raw);
		// Image-only result: no text 'r' event, just the image placeholder.
		expect(events).toEqual([{ k: "img", n: "inspect_image" }]);
	});

	it("emits one placeholder per image (count preserved) in prose and delta", () => {
		const msgs = [toolResult("screenshot", [image(), image(), image()])];
		const prose = serializeConversation(msgs);
		expect(prose.match(/\[image from screenshot\]/g)).toHaveLength(3);
		const events = parseDelta(serializeConversationDelta(msgs));
		expect(events.filter((e) => e.k === "img")).toHaveLength(3);
	});

	it("is byte-identical to the legacy output when no images are present", () => {
		const msgs: Message[] = [
			userMsg([{ type: "text", text: "hello" }]),
			{
				role: "assistant",
				content: [{ type: "text", text: "hi there" }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
			toolResult("read", [{ type: "text", text: "file body" }]),
		];

		expect(serializeConversation(msgs)).toBe("[User]: hello\n\n[Assistant]: hi there\n\n[Tool result]: file body");
		expect(serializeConversationDelta(msgs)).toBe(
			'[{"k":"u","t":"hello"},{"k":"a","t":"hi there"},{"k":"r","n":"read","t":"file body"}]',
		);
	});

	it("leaves the non-image lines of a message unchanged when an image is added", () => {
		const withImage = serializeConversation([userMsg([{ type: "text", text: "context" }, image()])]);
		expect(withImage.startsWith("[User]: context\n")).toBe(true);
	});
});
