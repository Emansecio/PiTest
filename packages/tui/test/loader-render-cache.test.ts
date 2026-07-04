import assert from "node:assert";
import { describe, it } from "node:test";
import { Loader } from "../src/components/loader.js";
import type { TUI } from "../src/tui.js";

function trackingTui(): { ui: TUI; tick: (now: number) => boolean; active: () => number } {
	const cbs = new Set<(now: number) => boolean>();
	const ui = {
		requestRender() {},
		addAnimationCallback(fn: (now: number) => boolean) {
			cbs.add(fn);
			return () => {
				cbs.delete(fn);
			};
		},
	} as unknown as TUI;
	return {
		ui,
		active: () => cbs.size,
		tick: (now: number) => {
			let dirty = false;
			for (const fn of [...cbs]) {
				if (fn(now)) dirty = true;
			}
			return dirty;
		},
	};
}

// Loader.render(width) wraps the inner Text's cached lines with a leading
// blank line (`["", ...super.render(width)]`). Per the Component memoization
// contract (tui.ts), the parent Container/Box relies on reference identity to
// skip re-flattening the transcript, so the wrapper must return the SAME
// array whenever the inner Text also returns its cached (unchanged) array, and
// a NEW array whenever the inner Text's output actually changes.
describe("Loader render caching", () => {
	it("returns the same array reference across repeated renders with a stable inner Text", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => s,
			"Working…",
			{ frames: ["⠋"] },
		);
		const first = loader.render(80);
		const second = loader.render(80);
		assert.strictEqual(first, second);
	});

	it("returns a new array reference when the inner Text changes (setMessage)", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => s,
			"Working…",
			{ frames: ["⠋"] },
		);
		const first = loader.render(80);
		loader.setMessage("Thinking…");
		const second = loader.render(80);
		assert.notStrictEqual(first, second);
		assert.match(second.join("\n"), /Thinking…/);
	});

	it("returns the same array reference again once settled after a change", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => s,
			"Working…",
			{ frames: ["⠋"] },
		);
		loader.render(80);
		loader.setMessage("Thinking…");
		const second = loader.render(80);
		const third = loader.render(80);
		assert.strictEqual(second, third);
	});

	it("returns a new array reference when width changes", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => s,
			"Working…",
			{ frames: ["⠋"] },
		);
		const first = loader.render(80);
		const second = loader.render(40);
		assert.notStrictEqual(first, second);
	});

	it("returns a new array reference after a tick that changes the visible spinner frame", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => s,
			"Working…",
			{ frames: ["a", "b"], intervalMs: 10 },
		);
		// seedFrameFromClock() (called during construction) derives the initial
		// frame from the real wall clock, so it's whichever of the two frames
		// happens to be live right now — read it back instead of assuming, then
		// pick a `now` that is guaranteed to land on the *other* frame (interval
		// 10ms, 2 frames: frameAt(now) = floor(now / 10) % 2).
		const internal = loader as unknown as { currentFrame: number };
		const otherFrame = internal.currentFrame === 0 ? 1 : 0;
		const now = otherFrame === 1 ? 10 : 20;

		const first = loader.render(80);
		const dirty = t.tick(now);
		assert.strictEqual(dirty, true);
		const second = loader.render(80);
		assert.notStrictEqual(first, second);
	});

	it("returns a new array reference after invalidate()", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => s,
			"Working…",
			{ frames: ["⠋"] },
		);
		const first = loader.render(80);
		loader.invalidate();
		const second = loader.render(80);
		assert.notStrictEqual(first, second);
		assert.deepStrictEqual(first, second);
	});
});
