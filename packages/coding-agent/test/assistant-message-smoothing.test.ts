import type { AssistantMessage } from "@pit/ai";
import type { TUI } from "@pit/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

// A TUI test double that captures animation callbacks so the test can drive the
// reveal cursor frame-by-frame and observe when it unsubscribes.
class ControllableTui {
	readonly callbacks = new Set<(now: number) => boolean>();
	requestRender(): void {}
	addAnimationCallback(cb: (now: number) => boolean): () => void {
		this.callbacks.add(cb);
		return () => this.callbacks.delete(cb);
	}
	tick(now = 0): void {
		for (const cb of [...this.callbacks]) cb(now);
	}
	get animating(): boolean {
		return this.callbacks.size > 0;
	}
}

function textMsg(text: string, stopReason?: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], stopReason } as unknown as AssistantMessage;
}

function build(tui: ControllableTui | undefined, smoothing: boolean): AssistantMessageComponent {
	return new AssistantMessageComponent(undefined, false, undefined, undefined, tui as unknown as TUI, smoothing);
}

function rendered(comp: AssistantMessageComponent): string {
	return stripAnsi(comp.render(120).join("\n"));
}

describe("assistant message streaming smoothing", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("reveals everything immediately when smoothing is off", () => {
		const comp = build(undefined, false);
		comp.updateContent(textMsg(`HELLO ${"y".repeat(30)} WORLD`));
		expect(rendered(comp)).toContain("WORLD");
	});

	it("clamps the trailing block on the first delta, then catches up via the ticker", () => {
		const tui = new ControllableTui();
		const comp = build(tui, true);

		comp.updateContent(textMsg(`START ${"x".repeat(50)} END`));
		// First frame: nothing revealed yet, ticker subscribed.
		expect(rendered(comp)).not.toContain("END");
		expect(tui.animating).toBe(true);

		// Drive the reveal to completion.
		let guard = 0;
		while (tui.animating && guard++ < 1000) tui.tick(guard * 16);

		expect(rendered(comp)).toContain("END");
		expect(tui.animating).toBe(false); // unsubscribed once caught up — no idle frames
	});

	it("flushes to full text the moment the message settles (stopReason set)", () => {
		const tui = new ControllableTui();
		const comp = build(tui, true);

		comp.updateContent(textMsg(`AAA ${"z".repeat(40)} ZZZ`)); // live stream
		expect(rendered(comp)).not.toContain("ZZZ");

		comp.updateContent(textMsg(`AAA ${"z".repeat(40)} ZZZ`, "end_turn")); // settled
		expect(rendered(comp)).toContain("ZZZ");
		expect(tui.animating).toBe(false);
	});

	it("is monotonic — the revealed prefix only grows across frames", () => {
		const tui = new ControllableTui();
		const comp = build(tui, true);
		comp.updateContent(textMsg("0123456789 ".repeat(8)));

		let prev = -1;
		let guard = 0;
		while (tui.animating && guard++ < 1000) {
			const len = rendered(comp).length;
			expect(len).toBeGreaterThanOrEqual(prev);
			prev = len;
			tui.tick(guard * 16);
		}
		expect(rendered(comp).length).toBeGreaterThanOrEqual(prev);
	});
});
