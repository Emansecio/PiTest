import { beforeAll, describe, expect, it } from "vitest";
import { ColorEase } from "../src/modes/interactive/components/color-ease.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

const fakeTui = () =>
	({
		requestRender() {},
		addAnimationCallback() {
			return () => {};
		},
	}) as any;

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
});
