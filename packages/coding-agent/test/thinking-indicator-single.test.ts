/**
 * One "Thinking…" on screen, ever.
 *
 * The footer working loader owns the reasoning state for a whole turn — spinner,
 * elapsed clock, token chips, reasoning preview. Under hidden-thinking the
 * transcript ALSO had a breathing "Thinking…" label on the live thinking block,
 * so a turn that reasons again inside an already-attached message (interleaved
 * thinking, the normal shape after a tool result) painted the same fact twice:
 * one of them with no clock and no spinner, which reads as a rendering artifact.
 *
 * The label also outlived the thought itself: `lastVisibleIndex` skips tool
 * calls, so "thinking → tool call" left it breathing over a message whose model
 * had long since moved on to running the tool.
 */

import type { TUI } from "@pit/tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createInteractiveHarness, type InteractiveHarness } from "./interactive-harness.ts";

beforeAll(() => initTheme("dark"));

let harness: InteractiveHarness | undefined;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
});

function countThinking(text: string): number {
	return text.split("Thinking…").length - 1;
}

/** Minimal TUI stand-in: enough for the component to consider itself live. */
const FAKE_UI = { addAnimationCallback: () => () => {} } as unknown as TUI;

function renderMessage(content: unknown[], thinkingShownElsewhere: boolean): string {
	const component = new AssistantMessageComponent(
		undefined,
		true, // hidden thinking — the only mode with an in-transcript label
		getMarkdownTheme(),
		"Thinking…",
		FAKE_UI,
		false,
		0,
		"off",
		() => thinkingShownElsewhere,
	);
	component.updateContent({ role: "assistant", content } as never);
	const out = component.render(80).join("\n");
	component.dispose();
	return out;
}

describe("in-transcript thinking label", () => {
	test("speaks when nothing else is indicating the thought", () => {
		const out = renderMessage([{ type: "thinking", thinking: "hmm" }], false);
		expect(countThinking(out)).toBe(1);
	});

	test("stands down while the footer loader is showing the same thing", () => {
		const out = renderMessage([{ type: "thinking", thinking: "hmm" }], true);
		expect(countThinking(out)).toBe(0);
	});

	test("a tool call after the thought ends it — no label over a running tool", () => {
		const out = renderMessage(
			[
				{ type: "thinking", thinking: "hmm" },
				{ type: "toolCall", id: "t1", name: "read", arguments: {} },
			],
			false,
		);
		expect(countThinking(out)).toBe(0);
	});
});

describe("no duplicate thinking indicator on screen", () => {
	/**
	 * The reported repro, in the reporter's config (grouped + hidden thinking):
	 * reason → answer → run a tool → reason AGAIN in the same message. Step 4 used
	 * to paint two "Thinking…" for a few seconds, until the answer resumed.
	 */
	test("interleaved thinking after a tool result never doubles up", async () => {
		harness = createInteractiveHarness({ toolActivity: "grouped" });
		const internals = harness.internals();
		internals.hideThinkingBlock = true;
		internals.workingVisible = true;
		const settings = internals.settingsManager as Record<string, unknown>;
		settings.getCodeBlockIndent = () => "";
		for (const name of ["getQuietStartup", "getPowerTipShown", "setPowerTipShown"]) {
			if (typeof settings[name] !== "function") settings[name] = () => undefined;
		}

		await harness.emit({ type: "agent_start" } as never);
		const message: Record<string, unknown> = { id: "m1", role: "assistant", content: [] };
		await harness.emit({ type: "message_start", message } as never);

		const push = async (block: unknown, kind: string) => {
			message.content = [...(message.content as unknown[]), block];
			await harness!.emit({ type: "message_update", message, assistantMessageEvent: { type: kind } } as never);
		};

		await push({ type: "thinking", thinking: "first thought" }, "thinking_delta");
		expect(countThinking(await harness.screen())).toBe(1);

		await push({ type: "text", text: "Let me check that file." }, "text_delta");
		await push({ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }, "toolcall_start");
		await harness.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "t1", args: {} } as never);
		await harness.emit({
			type: "tool_execution_end",
			toolName: "read",
			toolCallId: "t1",
			result: { content: [{ type: "text", text: "ok" }], output: "ok" },
			isError: false,
		} as never);
		// Tool settled → the footer goes back to "Thinking…".
		expect(countThinking(await harness.screen())).toBe(1);

		// The model reasons again inside the SAME, already-attached message.
		await push({ type: "thinking", thinking: "second thought" }, "thinking_delta");
		expect(countThinking(await harness.screen())).toBe(1);
		expect(countThinking(harness.chatText())).toBe(0);
	});
});
