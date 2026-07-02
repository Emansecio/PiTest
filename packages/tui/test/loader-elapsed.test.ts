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

describe("Loader elapsed with frozen indicator", () => {
	it("subscribes to the ticker for a single-frame indicator when elapsed is enabled", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => s,
			"Working…",
			{ frames: ["⠋"] },
		);
		loader.setElapsedEnabled(true);
		assert.strictEqual(t.active(), 1);
	});

	it("advances the elapsed suffix on ticker ticks without animating the frame", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => s,
			"Working…",
			{ frames: ["⠋"] },
		);
		loader.setElapsedEnabled(true);
		(loader as unknown as { startedAtMs: number }).startedAtMs = Date.now() - 5000;
		assert.strictEqual(t.tick(0), true);
		const text = loader.render(80).join("\n");
		assert.match(text, /5s/);
	});

	it("appends a trailing suffix independent of setMessage", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => s,
			"Working…",
			{ frames: ["⠋"] },
		);
		loader.setTrailingSuffix(" · hint");
		loader.setMessage("Thinking…");
		const text = loader.render(80).join("\n");
		assert.match(text, /hint/);
		assert.match(text, /Thinking/);
	});

	it("getElapsedMs discounts paused intervals", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => s,
			"Working…",
			{ frames: ["⠋"] },
		);
		loader.setElapsedEnabled(true);
		const internal = loader as unknown as { startedAtMs: number; pausedAtMs: number };
		internal.startedAtMs = Date.now() - 10_000;
		loader.setElapsedPaused(true);
		internal.pausedAtMs = Date.now() - 2_000;
		assert.ok(loader.getElapsedMs() >= 7_900 && loader.getElapsedMs() <= 8_100);
	});
});
