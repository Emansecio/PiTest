import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("getMouseEnabled", () => {
	// getMouseEnabled reads PIT_NO_MOUSE at call time, so isolate the env per test.
	let savedEnv: string | undefined;
	beforeEach(() => {
		savedEnv = process.env.PIT_NO_MOUSE;
		delete process.env.PIT_NO_MOUSE;
	});
	afterEach(() => {
		if (savedEnv === undefined) delete process.env.PIT_NO_MOUSE;
		else process.env.PIT_NO_MOUSE = savedEnv;
	});

	test("defaults to true (on-by-default)", () => {
		expect(SettingsManager.inMemory().getMouseEnabled()).toBe(true);
	});

	test("honors an explicit false in settings.json", () => {
		expect(SettingsManager.inMemory({ mouse: false }).getMouseEnabled()).toBe(false);
	});

	test("PIT_NO_MOUSE=1 wins over a setting of true", () => {
		process.env.PIT_NO_MOUSE = "1";
		expect(SettingsManager.inMemory({ mouse: true }).getMouseEnabled()).toBe(false);
	});

	test("a falsy PIT_NO_MOUSE leaves it enabled", () => {
		process.env.PIT_NO_MOUSE = "0";
		expect(SettingsManager.inMemory().getMouseEnabled()).toBe(true);
	});

	test("setMouseEnabled round-trips through the getter", () => {
		const sm = SettingsManager.inMemory();
		sm.setMouseEnabled(false);
		expect(sm.getMouseEnabled()).toBe(false);
		sm.setMouseEnabled(true);
		expect(sm.getMouseEnabled()).toBe(true);
	});
});

/**
 * toggleMouse() flips the persisted intent and pushes it to the live TUI. With
 * PIT_NO_MOUSE set the intent is pinned off, so the toggle must refuse to lie and
 * report the kill-switch instead of touching settings/ui.
 */
describe("InteractiveMode.toggleMouse", () => {
	const toggleMouse = Reflect.get(InteractiveMode.prototype, "toggleMouse") as (this: Record<string, unknown>) => void;

	let savedEnv: string | undefined;
	beforeEach(() => {
		savedEnv = process.env.PIT_NO_MOUSE;
		delete process.env.PIT_NO_MOUSE;
	});
	afterEach(() => {
		if (savedEnv === undefined) delete process.env.PIT_NO_MOUSE;
		else process.env.PIT_NO_MOUSE = savedEnv;
	});

	test("on→off: persists false, pushes to the TUI, and reports the off status", () => {
		const setMouseEnabledSetting = vi.fn();
		const setMouseEnabledUi = vi.fn();
		const showStatus = vi.fn();
		const fakeThis = {
			settingsManager: { getMouseEnabled: () => true, setMouseEnabled: setMouseEnabledSetting },
			ui: { setMouseEnabled: setMouseEnabledUi },
			showStatus,
		};

		toggleMouse.call(fakeThis);

		expect(setMouseEnabledSetting).toHaveBeenCalledExactlyOnceWith(false);
		expect(setMouseEnabledUi).toHaveBeenCalledExactlyOnceWith(false);
		expect(showStatus).toHaveBeenCalledOnce();
		expect(showStatus.mock.calls[0][0]).toContain("mouse off");
	});

	test("off→on: persists true, pushes to the TUI, and reports the on status", () => {
		const setMouseEnabledSetting = vi.fn();
		const setMouseEnabledUi = vi.fn();
		const showStatus = vi.fn();
		const fakeThis = {
			settingsManager: { getMouseEnabled: () => false, setMouseEnabled: setMouseEnabledSetting },
			ui: { setMouseEnabled: setMouseEnabledUi },
			showStatus,
		};

		toggleMouse.call(fakeThis);

		expect(setMouseEnabledSetting).toHaveBeenCalledExactlyOnceWith(true);
		expect(setMouseEnabledUi).toHaveBeenCalledExactlyOnceWith(true);
		expect(showStatus.mock.calls[0][0]).toContain("mouse on");
	});

	test("PIT_NO_MOUSE=1: warns about the kill-switch and touches neither settings nor ui", () => {
		process.env.PIT_NO_MOUSE = "1";
		const setMouseEnabledSetting = vi.fn();
		const setMouseEnabledUi = vi.fn();
		const showStatus = vi.fn();
		const fakeThis = {
			settingsManager: { getMouseEnabled: () => false, setMouseEnabled: setMouseEnabledSetting },
			ui: { setMouseEnabled: setMouseEnabledUi },
			showStatus,
		};

		toggleMouse.call(fakeThis);

		expect(setMouseEnabledSetting).not.toHaveBeenCalled();
		expect(setMouseEnabledUi).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledOnce();
		expect(showStatus.mock.calls[0][0]).toContain("PIT_NO_MOUSE");
	});
});
