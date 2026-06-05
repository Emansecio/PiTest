import type { AssistantMessage } from "@pit/ai";
import type { TUI } from "@pit/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

beforeAll(() => initTheme("dark"));

function fakeTui(): TUI {
	return {
		requestRender() {},
		addAnimationCallback() {
			return () => {};
		},
	} as unknown as TUI;
}

function textMsg(text: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as unknown as AssistantMessage;
}

function thinkingOnlyMsg(thinking: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking }],
	} as unknown as AssistantMessage;
}

describe("deliverable marker", () => {
	it("prepends a marker glyph to the first text line once marked", () => {
		const c = new AssistantMessageComponent(undefined, false, undefined, undefined, fakeTui(), false);
		c.updateContent(textMsg("Pronto — corrigido."));
		expect(stripAnsi(c.render(80).join("\n"))).not.toMatch(/[●◉]/);
		c.markAsDeliverable();
		expect(stripAnsi(c.render(80).join("\n"))).toMatch(/[●◉]/);
	});

	it("is idempotent — calling markAsDeliverable twice still renders one glyph", () => {
		const c = new AssistantMessageComponent(undefined, false, undefined, undefined, fakeTui(), false);
		c.updateContent(textMsg("Done."));
		c.markAsDeliverable();
		c.markAsDeliverable();
		const rendered = stripAnsi(c.render(80).join("\n"));
		// Should contain at most one marker on the first content line
		const firstContentLine = rendered.split("\n").find((l) => /[●◉]/.test(l));
		expect(firstContentLine).toBeDefined();
		const matches = (firstContentLine ?? "").match(/[●◉]/g);
		expect(matches?.length).toBe(1);
	});

	it("does nothing when the message has no visible text", () => {
		const c = new AssistantMessageComponent(undefined, false, undefined, undefined, fakeTui(), false);
		c.updateContent(thinkingOnlyMsg("hmm"));
		c.markAsDeliverable();
		const out = c.render(80).map(stripAnsi).join("\n");
		expect(out).not.toMatch(/[●◉]/);
	});

	it("glyph does not appear before markAsDeliverable is called", () => {
		const c = new AssistantMessageComponent(undefined, false, undefined, undefined, fakeTui(), false);
		c.updateContent(textMsg("Hello world"));
		const before = stripAnsi(c.render(80).join("\n"));
		expect(before).not.toMatch(/[●◉]/);
	});
});
