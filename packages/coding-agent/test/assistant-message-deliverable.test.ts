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

function countingTui(counter: { n: number }): TUI {
	return {
		requestRender() {},
		addAnimationCallback() {
			counter.n++;
			return () => {};
		},
	} as unknown as TUI;
}

function thinkingMsg(thinking: string, stopReason?: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "thinking", thinking }], stopReason } as unknown as AssistantMessage;
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

describe("narration dimming", () => {
	it("dims prose without altering the text or adding a marker", () => {
		const plain = new AssistantMessageComponent(undefined, false, undefined, undefined, fakeTui(), false);
		plain.updateContent(textMsg("Vou verificar o arquivo."));
		const plainRaw = plain.render(80).join("\n");

		const narr = new AssistantMessageComponent(undefined, false, undefined, undefined, fakeTui(), false);
		narr.updateContent(textMsg("Vou verificar o arquivo."));
		narr.markAsNarration();
		const narrRaw = narr.render(80).join("\n");

		// Same visible text, different styling (dim color applied), no marker.
		expect(stripAnsi(narrRaw)).toBe(stripAnsi(plainRaw));
		expect(narrRaw).not.toBe(plainRaw);
		expect(stripAnsi(narrRaw)).not.toMatch(/[●◉]/);
	});

	it("does not dim the deliverable (markAsNarration is a no-op once deliverable)", () => {
		const c = new AssistantMessageComponent(undefined, false, undefined, undefined, fakeTui(), false);
		c.updateContent(textMsg("Pronto."));
		c.markAsDeliverable();
		const beforeRaw = c.render(80).join("\n");
		c.markAsNarration();
		const afterRaw = c.render(80).join("\n");
		expect(afterRaw).toBe(beforeRaw);
		expect(stripAnsi(afterRaw)).toMatch(/[●◉]/);
	});
});

describe("thinking breath lifecycle", () => {
	it("breathes a live hidden-thinking label (no stopReason)", () => {
		const counter = { n: 0 };
		// hideThinkingBlock = true → shows the collapsible "Thinking…" label.
		const c = new AssistantMessageComponent(undefined, true, undefined, undefined, countingTui(counter), false);
		c.updateContent(thinkingMsg("pensando"));
		expect(counter.n).toBeGreaterThan(0); // breath ticker armed
	});

	it("does not breathe once the turn has settled/aborted (stopReason set)", () => {
		const counter = { n: 0 };
		const c = new AssistantMessageComponent(undefined, true, undefined, undefined, countingTui(counter), false);
		c.updateContent(thinkingMsg("pensando", "aborted"));
		expect(counter.n).toBe(0); // no forever-running ticker on a settled turn
	});
});

describe("hidden-thinking label visibility", () => {
	function thinkingThenTextMsg(thinking: string, text: string, stopReason?: string): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{ type: "thinking", thinking },
				{ type: "text", text },
			],
			stopReason,
		} as unknown as AssistantMessage;
	}

	it("renders no stale 'Thinking…' label for a settled hidden-thinking turn", () => {
		const c = new AssistantMessageComponent(undefined, true, undefined, undefined, fakeTui(), false);
		c.updateContent(thinkingThenTextMsg("raciocínio interno", "Vou ler o arquivo.", "stop"));
		const out = stripAnsi(c.render(80).join("\n"));
		expect(out).toContain("Vou ler o arquivo.");
		expect(out).not.toContain("Thinking…");
	});

	it("hides the settled thinking trace itself (only the answer text shows)", () => {
		const c = new AssistantMessageComponent(undefined, true, undefined, undefined, fakeTui(), false);
		c.updateContent(thinkingThenTextMsg("segredo-interno-do-modelo", "Resposta final.", "stop"));
		const out = stripAnsi(c.render(80).join("\n"));
		expect(out).toContain("Resposta final.");
		expect(out).not.toContain("Thinking…");
		expect(out).not.toContain("segredo-interno-do-modelo");
	});

	it("still shows the live 'Thinking…' label while the turn is in flight", () => {
		const c = new AssistantMessageComponent(undefined, true, undefined, undefined, fakeTui(), false);
		c.updateContent(thinkingOnlyMsg("pensando agora"));
		const out = stripAnsi(c.render(80).join("\n"));
		expect(out).toContain("Thinking…");
	});
});
