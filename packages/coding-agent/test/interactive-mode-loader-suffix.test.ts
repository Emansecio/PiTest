import { setKeybindings } from "@pit/tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	// Ensure test isolation: keybindings are a global singleton
	setKeybindings(new KeybindingsManager());
});

describe("InteractiveMode.refreshLoaderTrailingSuffix", () => {
	const refreshLoaderTrailingSuffix = Reflect.get(InteractiveMode.prototype, "refreshLoaderTrailingSuffix") as (
		this: Record<string, unknown>,
	) => void;
	const getLoaderInterruptSuffix = Reflect.get(InteractiveMode.prototype, "getLoaderInterruptSuffix") as (
		this: Record<string, unknown>,
	) => string;
	const invalidateLoaderInterruptSuffix = Reflect.get(
		InteractiveMode.prototype,
		"invalidateLoaderInterruptSuffix",
	) as (this: Record<string, unknown>) => void;
	const formatTokenChip = Reflect.get(InteractiveMode.prototype, "formatTokenChip") as (
		this: Record<string, unknown>,
		count: number,
	) => string;

	function makeFakeThis(outputTokens: number, streamTextCharCount = 0) {
		const setTrailingSuffix = vi.fn();
		return {
			loadingAnimation: { setTrailingSuffix },
			currentTurnOutputTokens: () => outputTokens,
			formatTokenChip,
			getLoaderInterruptSuffix,
			// The suffix is state-aware: with no cancellable tools in flight the
			// plain "esc to interrupt" fragment is expected.
			getInterruptiblePendingTools: () => [] as Array<{ id: string; name: string }>,
			cachedLoaderInterruptSuffix: null as string | null,
			cachedLoaderInterruptToolsSuffix: null as string | null,
			lastAppliedLoaderSuffix: undefined as string | undefined,
			streamTextCharCount,
			setTrailingSuffix,
		};
	}

	test("is a no-op when there is no active loader", () => {
		const fakeThis = { loadingAnimation: undefined } as Record<string, unknown>;
		expect(() => refreshLoaderTrailingSuffix.call(fakeThis)).not.toThrow();
	});

	test("calls setTrailingSuffix on the first refresh", () => {
		const fakeThis = makeFakeThis(120);
		refreshLoaderTrailingSuffix.call(fakeThis);
		expect(fakeThis.setTrailingSuffix).toHaveBeenCalledTimes(1);
	});

	test("does not call setTrailingSuffix again when nothing changed", () => {
		const fakeThis = makeFakeThis(120);
		refreshLoaderTrailingSuffix.call(fakeThis);
		expect(fakeThis.setTrailingSuffix).toHaveBeenCalledTimes(1);

		refreshLoaderTrailingSuffix.call(fakeThis);
		refreshLoaderTrailingSuffix.call(fakeThis);
		expect(fakeThis.setTrailingSuffix).toHaveBeenCalledTimes(1);
	});

	test("calls setTrailingSuffix again once the token chip changes", () => {
		const fakeThis = makeFakeThis(120);
		refreshLoaderTrailingSuffix.call(fakeThis);
		expect(fakeThis.setTrailingSuffix).toHaveBeenCalledTimes(1);

		fakeThis.currentTurnOutputTokens = () => 4200;
		refreshLoaderTrailingSuffix.call(fakeThis);
		expect(fakeThis.setTrailingSuffix).toHaveBeenCalledTimes(2);

		refreshLoaderTrailingSuffix.call(fakeThis);
		expect(fakeThis.setTrailingSuffix).toHaveBeenCalledTimes(2);
	});

	test("includes accumulated stream chars as a ↓ chip", () => {
		const fakeThis = makeFakeThis(0, 1200);
		refreshLoaderTrailingSuffix.call(fakeThis);
		expect(fakeThis.setTrailingSuffix).toHaveBeenCalledTimes(1);
		const suffix = stripAnsi(String(fakeThis.setTrailingSuffix.mock.calls[0][0]));
		expect(suffix).toContain("↓1.2k");
	});

	test("calls setTrailingSuffix again when stream char count changes", () => {
		const fakeThis = makeFakeThis(0, 100);
		refreshLoaderTrailingSuffix.call(fakeThis);
		expect(fakeThis.setTrailingSuffix).toHaveBeenCalledTimes(1);

		fakeThis.streamTextCharCount = 2500;
		refreshLoaderTrailingSuffix.call(fakeThis);
		expect(fakeThis.setTrailingSuffix).toHaveBeenCalledTimes(2);
		const suffix = stripAnsi(String(fakeThis.setTrailingSuffix.mock.calls[1][0]));
		expect(suffix).toContain("↓2.5k");
	});

	test("memoizes the interrupt suffix fragment across calls", () => {
		const fakeThis = makeFakeThis(0);
		const first = getLoaderInterruptSuffix.call(fakeThis);
		expect(fakeThis.cachedLoaderInterruptSuffix).toBe(first);
		const second = getLoaderInterruptSuffix.call(fakeThis);
		expect(second).toBe(first);
	});

	test("tells the truth while cancellable tools are in flight: stop/cancel + ctrl+c", () => {
		const fakeThis = makeFakeThis(0);
		const idle = stripAnsi(getLoaderInterruptSuffix.call(fakeThis));
		expect(idle).toContain("to interrupt");

		fakeThis.getInterruptiblePendingTools = () => [{ id: "t1", name: "bash" }];
		const busy = stripAnsi(getLoaderInterruptSuffix.call(fakeThis));
		expect(busy).toContain("stop/cancel");
		expect(busy).toContain("ctrl+c interrupt");

		// Back to the plain hint once the tools settle.
		fakeThis.getInterruptiblePendingTools = () => [];
		expect(stripAnsi(getLoaderInterruptSuffix.call(fakeThis))).toBe(idle);
	});

	test("invalidateLoaderInterruptSuffix forces a recompute on next read", () => {
		const fakeThis = makeFakeThis(0) as Record<string, unknown> & {
			cachedLoaderInterruptSuffix: string | null;
		};
		getLoaderInterruptSuffix.call(fakeThis);
		expect(fakeThis.cachedLoaderInterruptSuffix).not.toBeNull();

		invalidateLoaderInterruptSuffix.call(fakeThis);
		expect(fakeThis.cachedLoaderInterruptSuffix).toBeNull();
	});
});
