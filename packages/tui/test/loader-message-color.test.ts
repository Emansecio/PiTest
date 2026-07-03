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

// Time-aware label color that only depends on `now`: red on odd ms, green on
// even ms. Colors only — never changes the visible characters.
function nowColor(text: string, now: number): string {
	const code = Math.floor(now) % 2 === 0 ? 32 : 31;
	return `\x1b[${code}m${text}\x1b[39m`;
}

describe("Loader time-aware message color", () => {
	it("subscribes to the ticker for a frozen indicator once a time-aware color is set", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => s,
			"Working…",
			{ frames: ["⠋"] },
		);
		// Single frozen frame + static color → no ticker needed yet.
		assert.strictEqual(t.active(), 0);
		loader.setMessageColorAt(nowColor);
		assert.strictEqual(t.active(), 1);
	});

	it("repaints the label each frame from (text, now), not a memoized value", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => s,
			"Working…",
			{ frames: ["⠋"] },
		);
		loader.setMessageColorAt(nowColor);

		t.tick(0); // settle at an even ms → green
		const even = loader.render(80).join("\n");
		assert.match(even, /\x1b\[32mWorking…\x1b\[39m/);

		assert.strictEqual(t.tick(1), true); // odd ms → red: color changed → dirty
		const odd = loader.render(80).join("\n");
		assert.match(odd, /\x1b\[31mWorking…\x1b\[39m/);
		assert.notStrictEqual(even, odd);
	});

	it("coalesces frames whose time-aware color is unchanged", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => s,
			"Working…",
			{ frames: ["⠋"] },
		);
		loader.setMessageColorAt(nowColor);
		t.tick(2); // settle at now=2
		assert.strictEqual(t.tick(2), false); // same now → same color → no repaint
	});

	it("keeps the static (text)=>string path working when no time-aware fn is set", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => `[${s}]`,
			"Working…",
			{ frames: ["⠋"] },
		);
		const text = loader.render(80).join("\n");
		assert.match(text, /\[Working…\]/);
	});

	it("re-applies the time-aware color after setMessage swaps the label text", () => {
		const t = trackingTui();
		const loader = new Loader(
			t.ui,
			(s) => s,
			(s) => s,
			"Working…",
			{ frames: ["⠋"] },
		);
		loader.setMessageColorAt(nowColor);
		loader.setMessage("Thinking…");
		const text = loader.render(80).join("\n");
		assert.match(text, /\x1b\[3[12]mThinking…\x1b\[39m/);
	});
});
