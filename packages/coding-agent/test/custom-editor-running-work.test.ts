import { setKeybindings, type Terminal, TUI } from "@pit/tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

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

function makeEditor(): CustomEditor {
	return new CustomEditor(new TUI(new FakeTerminal()), getEditorTheme(), keybindings, { embedded: true });
}

describe("CustomEditor running-work navigation", () => {
	test("Up on an empty composer enters running work when the host handles it", () => {
		const editor = makeEditor();
		const onNavigate = vi.fn(() => true);
		editor.onNavigateToRunningWork = onNavigate;
		editor.addToHistory("older prompt");

		editor.handleInput("\x1b[A");

		expect(onNavigate).toHaveBeenCalledOnce();
		expect(editor.getText()).toBe("");
	});

	test("Up falls back to prompt history when there is no running work", () => {
		const editor = makeEditor();
		const onNavigate = vi.fn(() => false);
		editor.onNavigateToRunningWork = onNavigate;
		editor.addToHistory("older prompt");

		editor.handleInput("\x1b[A");

		expect(onNavigate).toHaveBeenCalledOnce();
		expect(editor.getText()).toBe("older prompt");
	});

	test("Up keeps editing non-empty content without invoking running work", () => {
		const editor = makeEditor();
		const onNavigate = vi.fn(() => true);
		editor.onNavigateToRunningWork = onNavigate;
		editor.setText("draft");
		editor.render(80);

		editor.handleInput("\x1b[A");

		expect(onNavigate).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft");
	});
});
