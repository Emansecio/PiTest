import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function makeThemePreviewFakeThis(): any {
	return {
		ui: { invalidate: vi.fn(), requestRender: vi.fn() },
		invalidateLoaderInterruptSuffix: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		_cachedMarkdownTheme: {},
		_themePreviewInvalidateTimer: undefined,
	};
}

function callPreviewTheme(fakeThis: any, themeName: string): void {
	(InteractiveMode as any).prototype.previewTheme.call(fakeThis, themeName);
}

describe("InteractiveMode.previewTheme", () => {
	beforeAll(() => {
		// setTheme uses the global theme registry; embedded themes are always available.
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("recolors the transcript after the debounce window", () => {
		vi.useFakeTimers();
		const fakeThis = makeThemePreviewFakeThis();

		callPreviewTheme(fakeThis, "light");

		expect(fakeThis.ui.requestRender).toHaveBeenCalled();
		expect(fakeThis.ui.invalidate).not.toHaveBeenCalled();

		vi.advanceTimersByTime(100);

		expect(fakeThis.ui.invalidate).toHaveBeenCalledTimes(1);
	});

	test("coalesces rapid successive previews into a single invalidate", () => {
		vi.useFakeTimers();
		const fakeThis = makeThemePreviewFakeThis();

		callPreviewTheme(fakeThis, "light");
		callPreviewTheme(fakeThis, "dark");
		callPreviewTheme(fakeThis, "light");
		callPreviewTheme(fakeThis, "dark");
		callPreviewTheme(fakeThis, "light");

		vi.advanceTimersByTime(100);

		expect(fakeThis.ui.invalidate).toHaveBeenCalledTimes(1);
	});

	test("an invalid theme name is a no-op: no mocks called, no timer scheduled", () => {
		vi.useFakeTimers();
		const fakeThis = makeThemePreviewFakeThis();

		callPreviewTheme(fakeThis, "nope-does-not-exist");

		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
		expect(fakeThis.ui.invalidate).not.toHaveBeenCalled();
		expect(fakeThis.invalidateLoaderInterruptSuffix).not.toHaveBeenCalled();
		expect(fakeThis.updateEditorBorderColor).not.toHaveBeenCalled();
		expect(fakeThis._themePreviewInvalidateTimer).toBeUndefined();

		vi.advanceTimersByTime(1000);
		expect(fakeThis.ui.invalidate).not.toHaveBeenCalled();
	});

	test("updates the cheap immediate surfaces synchronously", () => {
		vi.useFakeTimers();
		const fakeThis = makeThemePreviewFakeThis();

		callPreviewTheme(fakeThis, "light");

		expect(fakeThis._cachedMarkdownTheme).toBeUndefined();
		expect(fakeThis.updateEditorBorderColor).toHaveBeenCalled();
	});
});
