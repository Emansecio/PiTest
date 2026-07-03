/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "@pit/tui";
import { theme } from "../theme/theme.ts";

export interface KeyTextFormatOptions {
	capitalize?: boolean;
}

function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => formatKeyPart(part, options))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

export function keyHint(keybinding: Keybinding, description: string): string {
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}

/** Standard separator between inline key hints, shared across all selectors. */
export const HINT_SEPARATOR = " · ";

/**
 * Standard cursor prefix for selectable list rows: an accent arrow when the row
 * is selected, two spaces otherwise. Single source so every selector renders the
 * same glyph and color.
 */
export function selectionCursor(isSelected: boolean): string {
	return isSelected ? theme.fg("accent", "→ ") : "  ";
}

/**
 * Standard checkbox glyph for multi-select rows: `☑` when checked, `☐`
 * otherwise. Both are width-1. Returned uncolored — call sites apply their own
 * color (e.g. success for checked, dim for unchecked) so selectors stay
 * consistent on the glyph while keeping their local palette.
 */
export function checkboxGlyph(checked: boolean): string {
	return checked ? "☑" : "☐";
}
