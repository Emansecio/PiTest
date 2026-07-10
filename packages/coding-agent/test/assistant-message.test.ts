import type { AssistantMessage } from "@pit/ai";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

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

	test("repeated renders do not accumulate decoration (copy-on-write over the memoized super array)", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const first = component.render(40);
		const firstBytes = first.slice();

		// Steady state: Container.render memoizes and returns the same child
		// array; a render() that decorated it in place would re-prefix the OSC
		// markers (and the deliverable glyph) on every subsequent frame.
		const second = component.render(40);
		const third = component.render(40);

		expect(second).toEqual(firstBytes);
		expect(third).toEqual(firstBytes);
		// Exactly ONE output-start marker on the first line and ONE finished
		// marker on the last — accumulation would yield 2+ here.
		expect(third[0].split(OSC133_OUTPUT_START).length - 1).toBe(1);
		expect(third[third.length - 1].split(`${OSC133_OUTPUT_END_PREFIX};0\x07`).length - 1).toBe(1);
		// The array handed out earlier was not mutated by later renders.
		expect(first).toEqual(firstBytes);
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

	test("wraps visible thinking in a MessageShell gutter tinted by thinking level", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "pondering the void" }]),
			false,
			undefined,
			"Thinking…",
			undefined,
			false,
			100,
			"high",
		);
		const lines = component.render(60);
		const plain = lines.map(stripAnsi).join("\n");
		expect(plain).toContain("│");
		expect(plain).toContain("pondering the void");
		// Gutter mode (not framed): no rounded card corners
		expect(plain).not.toContain("╭");
	});

	test("prefixes hidden Thinking… label with a thinking-level gutter glyph", () => {
		initTheme("dark");

		const fakeUi = {
			addAnimationCallback: () => () => {},
			requestRender: () => {},
		} as unknown as import("@pit/tui").TUI;

		const message = createAssistantMessage([{ type: "thinking", thinking: "still thinking" }]);
		message.stopReason = undefined as unknown as AssistantMessage["stopReason"];
		const component = new AssistantMessageComponent(
			message,
			true,
			undefined,
			"Thinking…",
			fakeUi,
			false,
			100,
			"medium",
		);
		const plain = component.render(40).map(stripAnsi).join("\n");
		expect(plain).toMatch(/│\s*Thinking/);
	});
});
