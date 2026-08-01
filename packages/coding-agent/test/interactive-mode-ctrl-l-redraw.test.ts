import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

/**
 * P3-B (2026-07 TUI review): Ctrl+L is dual-use. With an EMPTY editor it is the
 * universal clear-screen — a hard full repaint via `ui.requestRender(true)`,
 * NOT a /clear of the visible transcript. With text in the editor it keeps its
 * previous behavior: opening the model selector.
 */

/**
 * Run the REAL setupKeyHandlers against a minimal fake and capture the
 * registered "app.model.select" action (same idiom as the onEscape capture in
 * interactive-mode-status.test.ts).
 */
function captureModelSelectAction(editorText: string) {
	const actions = new Map<string, () => void>();
	const editor: Record<string, unknown> = {
		onAction: (name: string, fn: () => void) => {
			actions.set(name, fn);
		},
	};
	const fakeThis: Record<string, unknown> = {
		defaultEditor: editor,
		editor: { getText: () => editorText },
		ui: { addInputListener: vi.fn(() => vi.fn()), requestRender: vi.fn() },
		signalCleanupHandlers: [],
		session: {},
		showModelSelector: vi.fn(),
	};
	(InteractiveMode.prototype as unknown as { setupKeyHandlers: (this: unknown) => void }).setupKeyHandlers.call(
		fakeThis,
	);
	const trigger = actions.get("app.model.select");
	if (!trigger) throw new Error("app.model.select was not registered");
	return { fakeThis: fakeThis as Record<string, any>, trigger };
}

describe("InteractiveMode Ctrl+L duality (app.model.select)", () => {
	test("empty editor: Ctrl+L forces a full repaint, not the model selector", () => {
		const { fakeThis, trigger } = captureModelSelectAction("");
		trigger();
		expect(fakeThis.ui.requestRender).toHaveBeenCalledWith(true);
		expect(fakeThis.showModelSelector).not.toHaveBeenCalled();
	});

	test("whitespace-only editor counts as empty", () => {
		const { fakeThis, trigger } = captureModelSelectAction("  \n\t ");
		trigger();
		expect(fakeThis.ui.requestRender).toHaveBeenCalledWith(true);
		expect(fakeThis.showModelSelector).not.toHaveBeenCalled();
	});

	test("editor with text: Ctrl+L keeps opening the model selector", () => {
		const { fakeThis, trigger } = captureModelSelectAction("draft prompt");
		trigger();
		expect(fakeThis.showModelSelector).toHaveBeenCalledTimes(1);
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalledWith(true);
	});
});
