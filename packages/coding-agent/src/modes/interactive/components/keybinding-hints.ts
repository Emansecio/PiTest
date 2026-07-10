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

/** Shared list-navigation hint labels (selectors, ask-picker, etc.). */
export const LIST_NAVIGATE_LABEL = "↑↓ navigate";
export const LIST_SELECT_LABEL = "select";
export const LIST_CLOSE_LABEL = "close";

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

/**
 * Scroll position line matching `@pit/tui` SelectList: `  ↑↓ (i/n)`.
 * `↑`/`↓` appear only when items exist above/below the visible window.
 * Returns `""` when the full list fits, unless `alwaysShow` is set (tree).
 */
export function scrollPositionHint(
	selectedIndex: number,
	total: number,
	startIndex: number,
	endIndex: number,
	options?: {
		alwaysShow?: boolean;
		/** 1-based position override (e.g. config counts items, not group headers). */
		displayCurrent?: number;
		displayTotal?: number;
	},
): string {
	if (total <= 0) return "";
	const canScroll = startIndex > 0 || endIndex < total;
	if (!canScroll && !options?.alwaysShow) return "";
	const up = startIndex > 0 ? "↑" : " ";
	const down = endIndex < total ? "↓" : " ";
	const current = options?.displayCurrent ?? selectedIndex + 1;
	const tot = options?.displayTotal ?? total;
	return `  ${up}${down} (${current}/${tot})`;
}

/** Muted themed scroll hint, or `""` when nothing to show. */
export function themedScrollPositionHint(
	selectedIndex: number,
	total: number,
	startIndex: number,
	endIndex: number,
	options?: {
		alwaysShow?: boolean;
		displayCurrent?: number;
		displayTotal?: number;
	},
): string {
	const raw = scrollPositionHint(selectedIndex, total, startIndex, endIndex, options);
	return raw ? theme.fg("muted", raw) : "";
}
