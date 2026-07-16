/**
 * Keybinding cheatsheet overlay.
 *
 * Lists every resolved keybinding alongside its description in a two-column
 * layout (keys → description), grouped into sections by binding scope so the
 * same key appearing in different contexts (editor vs session selector vs
 * tree) reads as scoped bindings, not conflicts. Reads from the global
 * KeybindingsManager so it always reflects user overrides.
 *
 * The body scrolls with ↑↓/PgUp/PgDn when it exceeds the viewport supplied by
 * the host; the title and the close hint stay pinned outside the scroll area.
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
	section: string;
}

/**
 * Binding-id prefix → section title. First match wins; order also defines the
 * display order of sections. Prefixes cover both the tui package's own
 * bindings and the app-level ids registered by hosts (e.g. the coding agent).
 */
const SECTION_RULES: ReadonlyArray<readonly [prefix: string, title: string]> = [
	["tui.editor.", "Editor"],
	["tui.input.", "Editor"],
	["tui.select.", "Lists & pickers"],
	["app.session.", "Session selector"],
	["app.tree.", "Session tree"],
	["tui.help.", "Help"],
	["app.", "Global"],
	["tui.", "Global"],
];

const SECTION_ORDER = ["Global", "Editor", "Lists & pickers", "Session selector", "Session tree", "Help", "Other"];

function sectionForId(id: string): string {
	for (const [prefix, title] of SECTION_RULES) {
		if (id.startsWith(prefix)) return title;
	}
	return "Other";
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
 * skipped. Sorted by section (display order), then by binding id so related
 * bindings (e.g. all `tui.editor.*`) stay adjacent within their section.
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
		rows.push({ keys, description, section: sectionForId(id) });
	}

	rows.sort((a, b) => {
		const orderDelta = SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section);
		return orderDelta;
	});
	return rows;
}

/**
 * Render the scrollable body: section headers + two-column binding rows.
 * Exported for the pure renderer below and reused by the component's
 * viewport slicing.
 */
function buildBodyLines(rows: CheatsheetRow[], width: number, theme: CheatsheetTheme): string[] {
	const lines: string[] = [];
	const widestKeys = rows.reduce((widest, row) => Math.max(widest, visibleWidth(row.keys)), 0);
	const keyColumnWidth = Math.max(MIN_KEY_COLUMN_WIDTH, Math.min(MAX_KEY_COLUMN_WIDTH, widestKeys));

	let currentSection: string | null = null;
	for (const row of rows) {
		if (row.section !== currentSection) {
			if (currentSection !== null) lines.push("");
			lines.push(theme.title(row.section));
			currentSection = row.section;
		}
		const keysText = truncateToWidth(row.keys, keyColumnWidth);
		const padding = " ".repeat(Math.max(0, keyColumnWidth - visibleWidth(keysText)));
		const descStart = keyColumnWidth + KEY_COLUMN_GAP;
		const remaining = Math.max(1, width - descStart);
		const descText = truncateToWidth(row.description, remaining);
		lines.push(`${theme.keys(keysText)}${padding}${" ".repeat(KEY_COLUMN_GAP)}${theme.description(descText)}`);
	}
	return lines;
}

/** Pure renderer (testable): produces the full cheatsheet lines for the given width. */
export function renderCheatsheet(rows: CheatsheetRow[], width: number, theme: CheatsheetTheme): string[] {
	const lines: string[] = [];
	lines.push(theme.title("Keyboard Shortcuts"));
	lines.push("");

	if (rows.length === 0) {
		lines.push(theme.description("  No keybindings registered"));
		return lines;
	}

	for (const bodyLine of buildBodyLines(rows, width, theme)) {
		lines.push(bodyLine);
	}
	lines.push("");
	lines.push(theme.hint("Esc to close"));
	return lines;
}

/**
 * Focusable cheatsheet component. Renders the keybinding list, scrolls it when
 * the host-provided viewport is shorter than the content, and closes on
 * Escape (or any of the configured cheatsheet keys, acting as a toggle).
 */
export class Cheatsheet implements Component, Focusable {
	public focused = false;
	private theme: CheatsheetTheme;
	private onClose: () => void;
	private getViewportRows?: () => number;
	private rows: CheatsheetRow[] | null = null;
	private cachedWidth = -1;
	private cachedBody: string[] | null = null;
	private scrollOffset = 0;
	private lastBodyViewport = 0;

	constructor(theme: CheatsheetTheme, onClose: () => void, getViewportRows?: () => number) {
		this.theme = theme;
		this.onClose = onClose;
		this.getViewportRows = getViewportRows;
	}

	invalidate(): void {
		this.rows = null;
		this.cachedWidth = -1;
		this.cachedBody = null;
	}

	render(width: number): string[] {
		if (!this.rows) {
			this.rows = buildCheatsheetRows();
			this.cachedBody = null;
		}
		if (this.rows.length === 0) {
			return renderCheatsheet(this.rows, width, this.theme);
		}
		if (!this.cachedBody || this.cachedWidth !== width) {
			this.cachedBody = buildBodyLines(this.rows, width, this.theme);
			this.cachedWidth = width;
		}
		const body = this.cachedBody;

		// Title + blank above the body, blank + hint pinned below it.
		const chrome = 4;
		const viewport = this.getViewportRows?.();
		if (viewport === undefined || body.length + chrome <= viewport) {
			this.scrollOffset = 0;
			this.lastBodyViewport = body.length;
			return [this.theme.title("Keyboard Shortcuts"), "", ...body, "", this.theme.hint("Esc to close")];
		}

		const bodyViewport = Math.max(1, viewport - chrome);
		this.lastBodyViewport = bodyViewport;
		const maxScroll = body.length - bodyViewport;
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
		const visible = body.slice(this.scrollOffset, this.scrollOffset + bodyViewport);
		const first = this.scrollOffset + 1;
		const last = this.scrollOffset + visible.length;
		const hint = this.theme.hint(`↑↓ scroll (${first}–${last} of ${body.length}) · Esc to close`);
		return [this.theme.title("Keyboard Shortcuts"), "", ...visible, "", hint];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.scrollOffset += 1; // clamped in render against the current body
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(1, this.lastBodyViewport));
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollOffset += Math.max(1, this.lastBodyViewport);
			return;
		}
		const kb = getKeybindings();
		// Esc, Ctrl+C, or the cheatsheet hotkey itself all dismiss the overlay.
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || kb.matches(data, "tui.help.cheatsheet")) {
			this.onClose();
		}
	}
}
