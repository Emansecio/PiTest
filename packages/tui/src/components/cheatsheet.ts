/**
 * Keybinding cheatsheet overlay.
 *
 * Lists every resolved keybinding alongside its description in a clean
 * two-column layout (keys → description). Reads from the global
 * KeybindingsManager so it always reflects user overrides.
 *
 * The component is generic over its theme (plain `(text) => string` colorizers)
 * so it lives in the tui package and stays testable without app context. The
 * host wires the trigger and supplies a themed adapter + an onClose callback.
 */

import { getKeybindings, type Keybinding } from "../keybindings.ts";
import { matchesKey } from "../keys.ts";
import type { Component, Focusable } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

const KEY_COLUMN_GAP = 2;
const MIN_KEY_COLUMN_WIDTH = 8;
const MAX_KEY_COLUMN_WIDTH = 28;

export interface CheatsheetTheme {
	title: (text: string) => string;
	keys: (text: string) => string;
	description: (text: string) => string;
	hint: (text: string) => string;
}

export interface CheatsheetRow {
	keys: string;
	description: string;
}

/** Pretty-print a KeyId for display: "ctrl+shift+-" → "Ctrl+Shift+-". */
function formatKeyId(keyId: string): string {
	return keyId
		.split("+")
		.map((part) => {
			if (part.length === 0) return part;
			// Capitalize known modifier/word tokens; leave single symbol/letter keys as-is.
			if (/^[a-z]+$/.test(part) && part.length > 1) {
				return part.charAt(0).toUpperCase() + part.slice(1);
			}
			return part;
		})
		.join("+");
}

/**
 * Build display rows from the resolved keybindings. Bindings with no keys are
 * skipped. Sorted by binding id (groups related bindings, e.g. all `tui.editor.*`).
 */
export function buildCheatsheetRows(): CheatsheetRow[] {
	const kb = getKeybindings();
	const resolved = kb.getResolvedBindings();
	const rows: CheatsheetRow[] = [];

	const ids = Object.keys(resolved).sort();
	for (const id of ids) {
		const value = resolved[id];
		const keyList = value === undefined ? [] : Array.isArray(value) ? value : [value];
		if (keyList.length === 0) continue;
		const keys = keyList.map(formatKeyId).join(", ");
		const description = kb.getDefinition(id as Keybinding)?.description ?? id;
		rows.push({ keys, description });
	}

	return rows;
}

/** Pure renderer (testable): produces the cheatsheet lines for the given width. */
export function renderCheatsheet(rows: CheatsheetRow[], width: number, theme: CheatsheetTheme): string[] {
	const lines: string[] = [];
	lines.push(theme.title("Keyboard Shortcuts"));
	lines.push("");

	if (rows.length === 0) {
		lines.push(theme.description("  No keybindings registered"));
		return lines;
	}

	const widestKeys = rows.reduce((widest, row) => Math.max(widest, visibleWidth(row.keys)), 0);
	const keyColumnWidth = Math.max(MIN_KEY_COLUMN_WIDTH, Math.min(MAX_KEY_COLUMN_WIDTH, widestKeys));

	for (const row of rows) {
		const keysText = truncateToWidth(row.keys, keyColumnWidth, "");
		const padding = " ".repeat(Math.max(0, keyColumnWidth - visibleWidth(keysText)));
		const descStart = keyColumnWidth + KEY_COLUMN_GAP;
		const remaining = Math.max(1, width - descStart);
		const descText = truncateToWidth(row.description, remaining, "");
		lines.push(`${theme.keys(keysText)}${padding}${" ".repeat(KEY_COLUMN_GAP)}${theme.description(descText)}`);
	}

	lines.push("");
	lines.push(theme.hint("Esc to close"));
	return lines;
}

/**
 * Focusable cheatsheet component. Renders the keybinding list and closes on
 * Escape (or any of the configured cheatsheet keys, acting as a toggle).
 */
export class Cheatsheet implements Component, Focusable {
	public focused = false;
	private theme: CheatsheetTheme;
	private onClose: () => void;
	private rows: CheatsheetRow[] | null = null;
	private cachedWidth = -1;
	private cachedLines: string[] | null = null;

	constructor(theme: CheatsheetTheme, onClose: () => void) {
		this.theme = theme;
		this.onClose = onClose;
	}

	invalidate(): void {
		this.rows = null;
		this.cachedWidth = -1;
		this.cachedLines = null;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		if (!this.rows) {
			this.rows = buildCheatsheetRows();
		}
		const lines = renderCheatsheet(this.rows, width, this.theme);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		// Esc, Ctrl+C, or the cheatsheet hotkey itself all dismiss the overlay.
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || kb.matches(data, "tui.help.cheatsheet")) {
			this.onClose();
		}
	}
}
