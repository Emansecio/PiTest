/**
 * CustomEditor (coding-agent) selection wiring:
 *  - the copySelection callback is invoked with the selected text on alt+c, and
 *    plumbs through to copyToClipboard when wired as interactive-mode does;
 *  - Esc with an active selection clears the selection and is consumed, so it never
 *    reaches the app's onEscape (interrupt/abort).
 */

import { setKeybindings, type Terminal, TUI } from "@pit/tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { copyToClipboard } from "../src/utils/clipboard.ts";

vi.mock("../src/utils/clipboard.ts", () => ({
	copyToClipboard: vi.fn(async () => {}),
}));

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

let keybindings: KeybindingsManager;

beforeAll(() => {
	initTheme("dark");
	keybindings = new KeybindingsManager({});
	setKeybindings(keybindings);
});

function makeEditor(options?: { copySelection?: (text: string) => void }): CustomEditor {
	const tui = new TUI(new FakeTerminal());
	const editor = new CustomEditor(tui, getEditorTheme(), keybindings, {
		embedded: true,
		copySelection: options?.copySelection,
	});
	return editor;
}

/** Select "hello" (cols [0,5)) on a "hello world" buffer via a press+drag gesture. */
function selectHello(editor: CustomEditor): void {
	editor.setText("hello world");
	editor.render(80);
	editor.onMouse({ type: "press", button: "left", x: 1, y: 1, shift: false, ctrl: false, alt: false, raw: "" }, 0, 0);
	editor.onMouse({ type: "drag", button: "left", x: 1, y: 1, shift: false, ctrl: false, alt: false, raw: "" }, 0, 5);
}

describe("CustomEditor copySelection wiring", () => {
	test("alt+c passes the selected text to the copySelection callback", () => {
		const copied: string[] = [];
		const editor = makeEditor({ copySelection: (t) => copied.push(t) });
		selectHello(editor);

		editor.handleInput("\x1bc"); // alt+c
		expect(copied).toEqual(["hello"]);
	});

	test("a copySelection wired to copyToClipboard reaches the clipboard helper", () => {
		const mockedCopy = vi.mocked(copyToClipboard);
		mockedCopy.mockClear();
		const editor = makeEditor({ copySelection: (text) => void copyToClipboard(text) });
		selectHello(editor);

		editor.handleInput("\x1bc"); // alt+c
		expect(mockedCopy).toHaveBeenCalledExactlyOnceWith("hello");
	});
});

describe("CustomEditor Esc with an active selection", () => {
	test("Esc clears the selection and does NOT fire the app onEscape", () => {
		const editor = makeEditor();
		const onEscape = vi.fn();
		editor.onEscape = onEscape;
		selectHello(editor);
		expect(editor.hasActiveSelection()).toBe(true);

		editor.handleInput("\x1b"); // Escape

		expect(editor.hasActiveSelection()).toBe(false);
		expect(onEscape).not.toHaveBeenCalled();
	});

	test("Esc with no selection fires the app onEscape", () => {
		const editor = makeEditor();
		const onEscape = vi.fn();
		editor.onEscape = onEscape;
		editor.setText("hello world");
		editor.render(80);

		editor.handleInput("\x1b"); // Escape

		expect(onEscape).toHaveBeenCalledOnce();
	});
});
