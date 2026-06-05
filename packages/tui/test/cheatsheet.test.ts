import assert from "node:assert";
import { describe, it } from "node:test";
import { buildCheatsheetRows, Cheatsheet, renderCheatsheet } from "../src/components/cheatsheet.js";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.js";
import { matchesKey } from "../src/keys.js";

const testTheme = {
	title: (text: string) => text,
	keys: (text: string) => text,
	description: (text: string) => text,
	hint: (text: string) => text,
};

describe("Cheatsheet", () => {
	it("builds rows from resolved keybindings with descriptions", () => {
		// Ensure the global manager uses defaults for this test.
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

		const rows = buildCheatsheetRows();

		// At least one row per defined keybinding with keys.
		assert.ok(rows.length > 0, "should produce rows");

		// Undo binding should be present with its description and key.
		const undoRow = rows.find((r) => r.description === "Undo");
		assert.ok(undoRow, "undo row should exist");
		assert.ok(undoRow.keys.toLowerCase().includes("ctrl"), `undo keys should include ctrl, got: ${undoRow.keys}`);

		// Redo binding should be present.
		const redoRow = rows.find((r) => r.description === "Redo");
		assert.ok(redoRow, "redo row should exist");

		// Cheatsheet binding should be present.
		const cheatsheetRow = rows.find((r) => r.description === "Show keybinding cheatsheet");
		assert.ok(cheatsheetRow, "cheatsheet row should exist");
	});

	it("renders a title, the bindings, and a close hint", () => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		const rows = buildCheatsheetRows();
		const lines = renderCheatsheet(rows, 80, testTheme);

		assert.strictEqual(lines[0], "Keyboard Shortcuts");
		assert.ok(
			lines.some((l) => l.includes("Undo")),
			"rendered output should mention Undo",
		);
		assert.ok(
			lines.some((l) => l.includes("Esc to close")),
			"rendered output should include the close hint",
		);
	});

	it("renders a placeholder when there are no bindings", () => {
		const lines = renderCheatsheet([], 80, testTheme);
		assert.ok(lines.some((l) => l.includes("No keybindings registered")));
	});

	it("closes on Escape", () => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		let closed = false;
		const sheet = new Cheatsheet(testTheme, () => {
			closed = true;
		});

		// Escape sequence.
		sheet.handleInput("\x1b");
		assert.strictEqual(closed, true);
	});

	it("closes on the cheatsheet hotkey (toggle)", () => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		let closed = false;
		const sheet = new Cheatsheet(testTheme, () => {
			closed = true;
		});

		// Find a raw byte sequence that matches the default cheatsheet key (ctrl+/).
		// ctrl+/ raw legacy byte is 0x1f? No — that is ctrl+-. Use Kitty CSI-u for "/".
		// "/" codepoint = 47, ctrl modifier => CSI-u modValue 5: \x1b[47;5u
		const ctrlSlash = "\x1b[47;5u";
		assert.ok(matchesKey(ctrlSlash, "ctrl+/"), "sanity: sequence should match ctrl+/");
		sheet.handleInput(ctrlSlash);
		assert.strictEqual(closed, true);
	});
});
