import type { AssistantMessage } from "@pit/ai";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const OSC133_PROMPT_START = "\x1b]133;A\x07"; // FTCS A: prompt — belongs to the user, not here
const OSC133_PROMPT_END = "\x1b]133;B\x07"; // FTCS B: command entered — user only
const OSC133_OUTPUT_START = "\x1b]133;C\x07"; // FTCS C: command output start
const OSC133_OUTPUT_END_PREFIX = "\x1b]133;D"; // FTCS D: finished (carries ;<exit>)

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
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

describe("AssistantMessageComponent", () => {
	test("wraps a tool-call-free assistant message in the OSC 133 output zone (C … D)", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		// Output start on the first line, finished (with exit status) on the last.
		expect(lines[0]).toContain(OSC133_OUTPUT_START);
		expect(lines[lines.length - 1]).toContain(`${OSC133_OUTPUT_END_PREFIX};0\x07`);

		// The prompt zone (A/B) belongs to the user message, never the assistant.
		const all = lines.join("\n");
		expect(all).not.toContain(OSC133_PROMPT_START);
		expect(all).not.toContain(OSC133_PROMPT_END);
	});

	test("reports a non-zero exit status on D when the turn was aborted", () => {
		initTheme("dark");

		const message = createAssistantMessage([{ type: "text", text: "partial" }]);
		message.stopReason = "aborted";
		const component = new AssistantMessageComponent(message);
		const lines = component.render(40);

		expect(lines[lines.length - 1]).toContain(`${OSC133_OUTPUT_END_PREFIX};130\x07`);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_OUTPUT_START)).toBe(false);
		expect(rendered.includes(OSC133_OUTPUT_END_PREFIX)).toBe(false);
		expect(rendered.includes(OSC133_PROMPT_START)).toBe(false);
	});
});
