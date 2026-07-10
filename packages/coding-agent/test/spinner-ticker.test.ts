import { SPINNER_FRAMES, type TUI } from "@pit/tui";
import { describe, expect, test } from "vitest";
import { createSpinnerTicker } from "../src/modes/interactive/components/spinner-ticker.js";

function fakeTui(): { ui: TUI; tick: (now: number) => void; unsubbed: () => boolean } {
	let cb: ((now: number) => boolean) | null = null;
	let unsubbed = false;
	const ui = {
		addAnimationCallback: (fn: (now: number) => boolean) => {
			cb = fn;
			return () => {
				unsubbed = true;
			};
		},
	} as unknown as TUI;
	return { ui, tick: (now) => cb?.(now), unsubbed: () => unsubbed };
}

describe("createSpinnerTicker", () => {
	test("emits spinner glyphs while shouldSpin is true", () => {
		const { ui, tick } = fakeTui();
		const glyphs: Array<string | null> = [];
		createSpinnerTicker(
			ui,
			() => true,
			(g) => glyphs.push(g),
		);
		tick(0);
		tick(1000);
		expect(glyphs.length).toBeGreaterThan(0);
		expect(SPINNER_FRAMES).toContain(glyphs[0]);
	});

	test("emits null once when shouldSpin flips to false", () => {
		let spin = true;
		const { ui, tick } = fakeTui();
		const glyphs: Array<string | null> = [];
		createSpinnerTicker(
			ui,
			() => spin,
			(g) => glyphs.push(g),
		);
		tick(0);
		spin = false;
		tick(1000);
		tick(2000);
		expect(glyphs[glyphs.length - 1]).toBeNull();
		// only one null even after multiple idle ticks
		expect(glyphs.filter((g) => g === null).length).toBe(1);
	});

	test("stop() unsubscribes the animation callback", () => {
		const { ui, unsubbed } = fakeTui();
		const t = createSpinnerTicker(
			ui,
			() => true,
			() => {},
		);
		t.stop();
		expect(unsubbed()).toBe(true);
	});

	test("dirty callback alone schedules a render (onFrame must not call requestRender)", () => {
		const loop = { cb: null as ((now: number) => boolean) | null };
		let renders = 0;
		const ui = {
			requestRender() {
				renders += 1;
			},
			addAnimationCallback(fn: (now: number) => boolean) {
				loop.cb = fn;
				return () => {
					loop.cb = null;
				};
			},
		} as unknown as TUI;
		createSpinnerTicker(
			ui,
			() => true,
			() => {},
		);
		if (!loop.cb) throw new Error("expected animation callback");
		const tickCb = loop.cb;
		// Mirror TUI.tickAnimations(): render only when a callback returns true.
		if (tickCb(0)) renders += 1;
		expect(renders).toBe(1);
		if (tickCb(0)) renders += 1;
		expect(renders).toBe(1);
		if (tickCb(80)) renders += 1;
		expect(renders).toBe(2);
	});

	test("under reduced motion, dirty once per second so elapsed can advance (M0)", () => {
		const prev = process.env.PIT_REDUCED_MOTION;
		process.env.PIT_REDUCED_MOTION = "1";
		try {
			const loop = { cb: null as ((now: number) => boolean) | null };
			const ui = {
				addAnimationCallback(fn: (now: number) => boolean) {
					loop.cb = fn;
					return () => {
						loop.cb = null;
					};
				},
			} as unknown as TUI;
			let dirtyCount = 0;
			createSpinnerTicker(
				ui,
				() => true,
				() => {},
			);
			if (!loop.cb) throw new Error("expected animation callback");
			const tickCb = loop.cb;
			if (tickCb(0)) dirtyCount += 1;
			if (tickCb(100)) dirtyCount += 1; // same second — no dirty
			if (tickCb(1000)) dirtyCount += 1;
			if (tickCb(1500)) dirtyCount += 1; // same second — no dirty
			if (tickCb(2000)) dirtyCount += 1;
			expect(dirtyCount).toBeGreaterThanOrEqual(3);
		} finally {
			if (prev === undefined) delete process.env.PIT_REDUCED_MOTION;
			else process.env.PIT_REDUCED_MOTION = prev;
		}
	});
});
