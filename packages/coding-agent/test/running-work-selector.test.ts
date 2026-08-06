import { setKeybindings } from "@pit/tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type RunningWorkItem,
	RunningWorkSelectorComponent,
} from "../src/modes/interactive/components/running-work-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const FOREGROUND: RunningWorkItem = {
	kind: "foreground",
	id: "tool-1",
	label: "npm test",
	state: "running",
};
const BACKGROUND: RunningWorkItem = {
	kind: "background",
	id: "bg-1",
	label: "npm run build",
	state: "12s",
};

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager({}));
});

function makeSelector(items: RunningWorkItem[] = [FOREGROUND, BACKGROUND]) {
	const onView = vi.fn();
	const onInterrupt = vi.fn();
	const onCancel = vi.fn();
	const selector = new RunningWorkSelectorComponent({
		getItems: () => items,
		onView,
		onInterrupt,
		onCancel,
	});
	return { selector, onView, onInterrupt, onCancel };
}

describe("RunningWorkSelectorComponent", () => {
	test("arrows navigate items and Down past the final item returns to the composer", () => {
		const { selector, onCancel } = makeSelector();
		try {
			expect(stripAnsi(selector.render(80).join("\n"))).toContain("npm test");
			selector.handleInput("\x1b[B");
			expect(stripAnsi(selector.render(80).join("\n"))).toContain("bg-1");
			selector.handleInput("\x1b[B");
			expect(onCancel).toHaveBeenCalledOnce();
		} finally {
			selector.dispose();
		}
	});

	test("Enter opens actions and arrows plus Enter interrupt the selected command", () => {
		const { selector, onInterrupt, onCancel } = makeSelector();
		try {
			selector.handleInput("\r");
			expect(stripAnsi(selector.render(80).join("\n"))).toContain("View output");
			selector.handleInput("\x1b[B");
			selector.handleInput("\r");
			expect(onInterrupt).toHaveBeenCalledExactlyOnceWith(FOREGROUND);
			expect(onCancel).toHaveBeenCalledOnce();
		} finally {
			selector.dispose();
		}
	});

	test("Esc returns from actions to items before closing the selector", () => {
		const { selector, onCancel } = makeSelector();
		try {
			selector.handleInput("\r");
			selector.handleInput("\x1b");
			expect(onCancel).not.toHaveBeenCalled();
			expect(stripAnsi(selector.render(80).join("\n"))).toContain("npm test");
			selector.handleInput("\x1b");
			expect(onCancel).toHaveBeenCalledOnce();
		} finally {
			selector.dispose();
		}
	});

	test("View closes without interrupting", () => {
		const { selector, onView, onInterrupt, onCancel } = makeSelector();
		try {
			selector.handleInput("\r");
			selector.handleInput("\r");
			expect(onView).toHaveBeenCalledExactlyOnceWith(FOREGROUND);
			expect(onInterrupt).not.toHaveBeenCalled();
			expect(onCancel).toHaveBeenCalledOnce();
		} finally {
			selector.dispose();
		}
	});

	test("Keep running returns to the composer without invoking a work action", () => {
		const { selector, onView, onInterrupt, onCancel } = makeSelector();
		try {
			selector.handleInput("\r");
			selector.handleInput("\x1b[B");
			selector.handleInput("\x1b[B");
			selector.handleInput("\r");
			expect(onView).not.toHaveBeenCalled();
			expect(onInterrupt).not.toHaveBeenCalled();
			expect(onCancel).toHaveBeenCalledOnce();
		} finally {
			selector.dispose();
		}
	});

	test("does not transfer an open action to another command after refresh", () => {
		vi.useFakeTimers();
		let items = [FOREGROUND, BACKGROUND];
		const onInterrupt = vi.fn();
		const onCancel = vi.fn();
		const selector = new RunningWorkSelectorComponent({
			getItems: () => items,
			onView: vi.fn(),
			onInterrupt,
			onCancel,
		});
		try {
			selector.handleInput("\r");
			selector.handleInput("\x1b[B");
			items = [BACKGROUND];
			vi.advanceTimersByTime(1_000);

			selector.handleInput("\r");

			expect(onInterrupt).not.toHaveBeenCalled();
			expect(onCancel).not.toHaveBeenCalled();
			expect(stripAnsi(selector.render(80).join("\n"))).toContain("View output");
		} finally {
			selector.dispose();
			vi.useRealTimers();
		}
	});
});
