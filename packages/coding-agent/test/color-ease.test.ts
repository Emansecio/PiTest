import { resetCapabilitiesCache, setCapabilities, type TUI } from "@pit/tui";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { COLOR_EASE_MS, ColorEase } from "../src/modes/interactive/components/color-ease.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));
afterAll(() => resetCapabilitiesCache());

const fakeTui = () =>
	({
		requestRender() {},
		addAnimationCallback() {
			return () => {};
		},
	}) as unknown as TUI;

function animTui(): { ui: TUI; tick: (now: number) => boolean; active: () => boolean } {
	let cb: ((now: number) => boolean) | null = null;
	const ui = {
		requestRender() {},
		addAnimationCallback(fn: (now: number) => boolean) {
			cb = fn;
			return () => {
				cb = null;
			};
		},
	} as unknown as TUI;
	return {
		ui,
		tick: (now: number) => cb?.(now) ?? false,
		active: () => cb !== null,
	};
}

describe("ColorEase", () => {
	it("returns the steady color and stays inactive when idle", () => {
		const ease = new ColorEase(fakeTui(), () => {});
		expect(ease.active).toBe(false);
		expect(stripAnsi(ease.colorize("toolOutput", "x"))).toBe("x");
	});

	it("preserves the colorized text while easing and clears on stop", () => {
		// Whether or not the terminal supports truecolor easing, colorize() must
		// never alter the text content — only its color. stop() ends any ease.
		const ease = new ColorEase(fakeTui(), () => {});
		ease.begin("text", "toolOutput");
		expect(stripAnsi(ease.colorize("toolOutput", "3 files"))).toBe("3 files");
		ease.stop();
		expect(ease.active).toBe(false);
		expect(stripAnsi(ease.colorize("toolOutput", "3 files"))).toBe("3 files");
	});

	it("stop() is idempotent and leaves the steady color", () => {
		const ease = new ColorEase(fakeTui(), () => {});
		ease.stop();
		ease.stop();
		expect(ease.active).toBe(false);
		expect(stripAnsi(ease.colorize("gutterToolSuccess", "✔"))).toBe("✔");
	});

	describe("dirty gating (#A)", () => {
		afterEach(() => {
			resetCapabilitiesCache();
			initTheme("dark");
		});

		it("coalesces repeat ticks at the same timestamp", () => {
			setCapabilities({ images: null, trueColor: true, hyperlinks: false });
			initTheme("dark");
			const { ui, tick, active } = animTui();
			const ease = new ColorEase(ui, () => {});
			ease.begin("gutterToolPending", "gutterToolSuccess");
			const anchor = performance.now();
			const mid = anchor + Math.floor(COLOR_EASE_MS * 0.4);

			expect(tick(mid)).toBe(true);
			expect(tick(mid)).toBe(false);

			let coalesced = 0;
			for (let ms = 0; ms <= COLOR_EASE_MS + 16; ms += 16) {
				const at = anchor + ms;
				tick(at);
				if (!tick(at)) coalesced += 1;
			}

			expect(active()).toBe(false);
			expect(coalesced).toBeGreaterThan(0);
		});

		it("reports dirty when progress crosses the 0.5 half (glyph crossfade)", () => {
			setCapabilities({ images: null, trueColor: true, hyperlinks: false });
			initTheme("dark");
			const { ui, tick } = animTui();
			const ease = new ColorEase(ui, () => {});
			ease.begin("gutterToolPending", "gutterToolSuccess");
			const anchor = performance.now();

			// Advance to just before the half boundary, then step into the second half.
			const beforeHalf = Math.floor(COLOR_EASE_MS * 0.45);
			tick(anchor + beforeHalf);
			const progressBefore = ease.progress;
			expect(progressBefore).toBeLessThan(0.5);

			const atHalf = Math.floor(COLOR_EASE_MS * 0.55);
			expect(tick(anchor + atHalf)).toBe(true);
			expect(ease.progress).toBeGreaterThanOrEqual(0.5);
		});

		it("calls onFrame only on snap, not on every animation tick", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			let onFrameCalls = 0;
			const ease = new ColorEase(fakeTui(), () => {
				onFrameCalls += 1;
			});
			ease.begin("text", "toolOutput");
			expect(onFrameCalls).toBe(1);
		});
	});
});
