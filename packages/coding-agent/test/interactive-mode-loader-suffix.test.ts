import { setKeybindings } from "@pit/tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

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
	const formatStreamThroughput = Reflect.get(InteractiveMode.prototype, "formatStreamThroughput") as (
		this: Record<string, unknown>,
		cps: number,
	) => string;

	function makeFakeThis(outputTokens: number) {
		const setTrailingSuffix = vi.fn();
		return {
			loadingAnimation: { setTrailingSuffix },
			currentTurnOutputTokens: () => outputTokens,
			formatTokenChip,
			formatStreamThroughput,
			getLoaderInterruptSuffix,
			cachedLoaderInterruptSuffix: null as string | null,
			lastAppliedLoaderSuffix: undefined as string | undefined,
			lastStreamRateSampleMs: 0,
			lastStreamRateCharCount: 0,
			streamTextCharCount: 0,
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

		// Same output tokens, no rate sample due (lastStreamRateSampleMs stayed 0)
		// -> the composed suffix is byte-identical to the one already applied.
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

		// And skips again once settled at the new value.
		refreshLoaderTrailingSuffix.call(fakeThis);
		expect(fakeThis.setTrailingSuffix).toHaveBeenCalledTimes(2);
	});

	test("memoizes the interrupt suffix fragment across calls", () => {
		const fakeThis = makeFakeThis(0);
		const first = getLoaderInterruptSuffix.call(fakeThis);
		expect(fakeThis.cachedLoaderInterruptSuffix).toBe(first);
		const second = getLoaderInterruptSuffix.call(fakeThis);
		expect(second).toBe(first);
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
