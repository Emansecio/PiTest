import type { AssistantMessage } from "@pit/ai";
import { type TUI, visibleWidth } from "@pit/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AssistantMessageComponent,
	appendRevealCaret,
	discreteFadeTailColorize,
	fadeLineTail,
} from "../src/modes/interactive/components/assistant-message.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
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
		// Pin a capable TERM so these tests exercise the wavefront path in any shell.
		process.env.TERM = "xterm-256color";
		delete process.env.PIT_NO_MOTION;
		delete process.env.PIT_REDUCED_MOTION;
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
		// First delta: an initial prefix is visible, with the ticker still subscribed.
		expect(rendered(comp)).not.toContain("END");
		expect(tui.animating).toBe(true);

		// Drive the reveal to completion.
		let guard = 0;
		while (tui.animating && guard++ < 1000) tui.tick(guard * 16);

		expect(rendered(comp)).toContain("END");
		expect(tui.animating).toBe(false); // unsubscribed once caught up — no idle frames
	});

	it("shows an initial prefix immediately instead of attaching a blank streaming block", () => {
		const tui = new ControllableTui();
		const comp = build(tui, true);

		comp.updateContent(textMsg(`START ${"x".repeat(80)} END`));

		const first = rendered(comp);
		expect(first.length).toBeGreaterThan(0);
		expect(first).not.toContain("END");
		expect(tui.animating).toBe(true);
	});

	it("catches up proportionally after a delayed animation tick", () => {
		const tui = new ControllableTui();
		const comp = build(tui, true);

		comp.updateContent(textMsg(`START ${"x".repeat(500)} END`));
		tui.tick(16);
		expect(rendered(comp)).not.toContain("END");

		tui.tick(500);

		expect(rendered(comp)).toContain("END");
		expect(tui.animating).toBe(false);
	});

	it("does not retract visible text when another delta arrives after catching up", () => {
		const tui = new ControllableTui();
		const comp = build(tui, true);
		const firstText = `START ${"x".repeat(70)}`;

		comp.updateContent(textMsg(firstText));
		let guard = 0;
		while (tui.animating && guard++ < 1000) tui.tick(guard * 16);
		expect(rendered(comp)).toContain(firstText);

		comp.updateContent(textMsg(`${firstText} ${"y".repeat(120)} END`));

		expect(rendered(comp)).toContain(firstText);
		expect(rendered(comp)).not.toContain("END");
		expect(tui.animating).toBe(true);
	});

	it("patches the content tree in place when only trailing text grows", () => {
		const comp = build(undefined, false);
		comp.updateContent(textMsg("hello"));
		const container = (comp as unknown as { contentContainer: { children: unknown[] } }).contentContainer;
		const childCount = container.children.length;
		expect(childCount).toBeGreaterThan(0);

		comp.updateContent(textMsg("hello world streaming"));
		expect(container.children.length).toBe(childCount);
		expect(rendered(comp)).toContain("streaming");
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

	it("holds the reveal cursor at zero while streamVisible is false, then streams on attach", () => {
		const tui = new ControllableTui();
		const comp = build(tui, true);
		comp.setStreamVisible(false);
		comp.updateContent(textMsg(`START ${"x".repeat(120)} END`));
		expect(rendered(comp)).not.toContain("START");
		expect(tui.animating).toBe(false);

		comp.setStreamVisible(true);
		const first = rendered(comp);
		expect(first).toContain("START");
		expect(first).not.toContain("END");
		expect(tui.animating).toBe(true);
	});

	it("snaps small provider deltas through immediately instead of clamping them", () => {
		const tui = new ControllableTui();
		const comp = build(tui, true);
		comp.updateContent(textMsg("Hello"));
		let guard = 0;
		while (tui.animating && guard++ < 100) tui.tick(16);
		expect(rendered(comp)).toContain("Hello");
		comp.updateContent(textMsg("Hello world"));
		expect(rendered(comp)).toContain("world");
	});

	it("keeps the reveal correct while the wavefront edge is faded (#3)", () => {
		const tui = new ControllableTui();
		const comp = build(tui, true);
		comp.updateContent(textMsg(`HELLO ${"w".repeat(40)} WORLD`));

		tui.tick(16); // one frame in: a few chars revealed, capped step
		const mid = comp.render(120).join("\n");
		expect(stripAnsi(mid)).not.toContain("WORLD"); // still revealing
		expect(mid).toContain("\x1b"); // colored output (markdown + edge fade)

		let guard = 0;
		while (tui.animating && guard++ < 1000) tui.tick(guard * 16);
		expect(stripAnsi(comp.render(120).join("\n"))).toContain("WORLD"); // settled & complete
	});
});

/**
 * The drain law must track the incoming rate, not just decay the backlog. With
 * the pure `backlog / CATCHUP_FRAMES` law the drain equalled the arrival rate
 * only at a NON-ZERO backlog, so the cursor settled into a permanent trail of
 * `rate × 130ms` of text (measured: 30 chars behind at ~310 chars/s, ~95 at
 * ~890 chars/s) and dumped that whole trail in one frame at message_end.
 *
 * These drive a steady stream on a fake clock — `syncReveal` samples
 * `performance.now()` for the arrival estimate, so the deltas must be spaced on
 * the SAME clock the ticker is driven with, or the estimate sees every delta as
 * arriving in the same frame.
 */
describe("assistant message reveal keeps station with the stream", () => {
	const TOKEN_COUNT = 5; // chars per delta = TOKEN_COUNT * 6 = 30
	const DELTA_GAP_MS = 90; // ~330 chars/s, a realistic mid-rate stream
	const DELTAS = 24;

	beforeAll(() => {
		initTheme("dark");
		process.env.TERM = "xterm-256color";
		delete process.env.PIT_NO_MOTION;
		delete process.env.PIT_REDUCED_MOTION;
	});

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	interface StreamRun {
		/** Tail token of every delta still hidden when the NEXT delta landed. */
		stragglers: string[];
		/** Tail token still hidden when the stream stopped — what settling would dump. */
		hiddenAtSettle: string[];
		firstDeltaTail: string;
		comp: AssistantMessageComponent;
		tui: ControllableTui;
	}

	function streamAndCollectStragglers(): StreamRun {
		const tui = new ControllableTui();
		const comp = build(tui, true);
		let text = "";
		const stragglers: string[] = [];
		let previousTail: string | null = null;
		let firstDeltaTail = "";

		for (let d = 0; d < DELTAS; d++) {
			// Advance the shared clock a delta-gap, ticking the reveal each frame.
			for (let elapsed = 0; elapsed < DELTA_GAP_MS; elapsed += 16) {
				vi.advanceTimersByTime(16);
				tui.tick(performance.now());
			}
			// The previous delta's tail should already be on screen by now.
			if (previousTail !== null && !rendered(comp).includes(previousTail)) {
				stragglers.push(previousTail);
			}
			const tokens: string[] = [];
			for (let t = 0; t < TOKEN_COUNT; t++) {
				tokens.push(`w${String(d * TOKEN_COUNT + t).padStart(4, "0")}`);
			}
			text += `${tokens.join(" ")} `;
			previousTail = tokens[tokens.length - 1];
			if (d === 0) firstDeltaTail = previousTail;
			comp.updateContent(textMsg(text));
		}

		// Drain the final gap, then settle. Whatever is still hidden here is what
		// message_end would dump into a single frame.
		for (let elapsed = 0; elapsed < DELTA_GAP_MS; elapsed += 16) {
			vi.advanceTimersByTime(16);
			tui.tick(performance.now());
		}
		const beforeSettle = rendered(comp);
		const hiddenAtSettle = previousTail !== null && !beforeSettle.includes(previousTail) ? [previousTail] : [];
		return { stragglers, hiddenAtSettle, firstDeltaTail, comp, tui };
	}

	it("shows each delta before the next one arrives (no standing backlog)", () => {
		const { stragglers, firstDeltaTail } = streamAndCollectStragglers();
		// Under the old law EVERY delta was still partly hidden when its successor
		// landed — the trail never cleared, at any rate.
		//
		// The block's OPENING delta is the one legitimate exception: it is the first
		// text of a new message, so there is no earlier delta to measure an interval
		// against and the arrival term is still zero. That delta eases in on the pure
		// backlog law, which is the deliberate materialize-in at the head of an
		// answer. Everything after it must keep station.
		expect(stragglers.filter((tail) => tail !== firstDeltaTail)).toEqual([]);
	});

	it("has nothing left to dump when the message settles", () => {
		const { hiddenAtSettle, comp, tui } = streamAndCollectStragglers();
		expect(hiddenAtSettle).toEqual([]);
		// And settling is therefore a no-op for the visible text, not a pop.
		const before = rendered(comp);
		comp.updateContent(textMsg(`${before.trim()} `, "end_turn"));
		expect(tui.animating).toBe(false);
	});
});

describe("reveal edge fade (fadeLineTail)", () => {
	beforeAll(() => {
		initTheme("dark");
		// Pin a capable TERM so these tests exercise the wavefront path in any shell.
		process.env.TERM = "xterm-256color";
		delete process.env.PIT_NO_MOTION;
		delete process.env.PIT_REDUCED_MOTION;
	});

	it("preserves the visible text and width, only recoloring the tail", () => {
		const line = "hello brave new world";
		const out = fadeLineTail(line);
		expect(stripAnsi(out)).toBe(line); // characters unchanged
		expect(visibleWidth(out)).toBe(visibleWidth(line)); // width unchanged
		expect(out).not.toBe(line); // the tail was recolored
		expect(out.length).toBeGreaterThan(line.length); // ANSI was added
	});

	it("fades the text edge, leaving right padding intact", () => {
		const padded = `short line${" ".repeat(10)}`;
		const out = fadeLineTail(padded);
		expect(stripAnsi(out)).toBe(padded); // text + padding both intact
		expect(visibleWidth(out)).toBe(visibleWidth(padded));
	});

	it("is a no-op on blank / padding-only lines", () => {
		expect(fadeLineTail("     ")).toBe("     ");
		expect(fadeLineTail("")).toBe("");
	});

	it("discrete 256-color ramp uses text → muted → dim stops", () => {
		const textAnsi = theme.getFgAnsi("text");
		const mutedAnsi = theme.getFgAnsi("muted");
		const dimAnsi = theme.getFgAnsi("dim");
		expect(discreteFadeTailColorize(0)("a")).toContain(textAnsi);
		expect(discreteFadeTailColorize(0.5)("a")).toContain(mutedAnsi);
		expect(discreteFadeTailColorize(1)("a")).toContain(dimAnsi);
		expect(discreteFadeTailColorize(0)("a")).not.toBe(discreteFadeTailColorize(1)("a"));
	});
});

describe("reveal caret (appendRevealCaret)", () => {
	beforeAll(() => {
		initTheme("dark");
		// Pin a capable TERM so these tests exercise the wavefront path in any shell.
		process.env.TERM = "xterm-256color";
		delete process.env.PIT_NO_MOTION;
		delete process.env.PIT_REDUCED_MOTION;
	});

	it("appends a dim block caret at the content edge", () => {
		const out = appendRevealCaret("hello");
		expect(stripAnsi(out)).toBe("hello▌");
		expect(out).toContain("▌");
	});

	it("consumes one pad column so padded width stays stable", () => {
		const padded = `short${" ".repeat(5)}`;
		const out = appendRevealCaret(padded);
		expect(visibleWidth(out)).toBe(visibleWidth(padded));
		expect(stripAnsi(out)).toContain("▌");
	});
});

describe("reveal caret on live stream", () => {
	beforeAll(() => {
		initTheme("dark");
		// Pin a capable TERM so these tests exercise the wavefront path in any shell.
		process.env.TERM = "xterm-256color";
		delete process.env.PIT_NO_MOTION;
		delete process.env.PIT_REDUCED_MOTION;
	});

	it("shows ▌ while revealing and drops it once settled", () => {
		const tui = new ControllableTui();
		const comp = build(tui, true);
		const long = `HELLO ${"y".repeat(40)} WORLD`;
		comp.updateContent(textMsg(long));
		const mid = comp.render(120).join("\n");
		expect(mid).toContain("▌");

		let guard = 0;
		while (tui.animating && guard++ < 1000) tui.tick(guard * 16);
		comp.updateContent(textMsg(long, "stop"));
		const settled = comp.render(120).join("\n");
		expect(settled).not.toContain("▌");
		expect(stripAnsi(settled)).toContain("WORLD");
	});
});
