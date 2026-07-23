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

	it("renders the detail suffix between the message and the elapsed counter", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => s,
			"Thinking…",
			{ frames: ["⠋"] },
		);
		loader.setElapsedEnabled(true);
		(loader as unknown as { startedAtMs: number }).startedAtMs = Date.now() - 8000;
		t.tick(0);
		loader.setDetailSuffix(" ·…tail of the reasoning");
		loader.setTrailingSuffix(" · hint");
		const text = loader.render(80).join("\n");
		const messageIdx = text.indexOf("Thinking…");
		const detailIdx = text.indexOf("tail of the reasoning");
		const elapsedIdx = text.indexOf("8s");
		const hintIdx = text.indexOf("hint");
		assert.ok(messageIdx >= 0 && detailIdx > messageIdx, "detail suffix follows the message");
		assert.ok(elapsedIdx > detailIdx, "elapsed counter follows the detail suffix");
		assert.ok(hintIdx > elapsedIdx, "trailing suffix still renders after elapsed");
	});

	it("setDetailSuffix is independent of setTrailingSuffix and clears with an empty string", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => s,
			"Thinking…",
			{ frames: ["⠋"] },
		);
		loader.setDetailSuffix(" ·…partial thought");
		assert.match(loader.render(80).join("\n"), /partial thought/);
		loader.setDetailSuffix("");
		assert.doesNotMatch(loader.render(80).join("\n"), /partial thought/);
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

	it("can restart the elapsed counter for a new phase", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => s,
			"Working…",
			{ frames: ["⠋"] },
		);
		loader.setElapsedEnabled(true);
		(loader as unknown as { startedAtMs: number }).startedAtMs = Date.now() - 10_000;
		loader.resetElapsed();
		assert.ok(loader.getElapsedMs() < 100);
		assert.doesNotMatch(loader.render(80).join("\n"), /10s/);
	});
});
