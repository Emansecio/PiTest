import { type Component, truncateToWidth } from "@pit/tui";
import { theme } from "../theme/theme.ts";

/**
 * Truncate a list row and, when selected, pad to width then paint `selectedBg`
 * across the full available width (same idiom as session/tree selectors).
 */
export function paintSelectedRow(line: string, width: number, isSelected: boolean, paddingX = 0): string {
	const available = Math.max(1, width - paddingX * 2);
	// Pad when selected so selectedBg fills the row; unselected stays flush
	// (no trailing spaces) like TruncatedText.
	let display = truncateToWidth(line, available, "…", isSelected);
	if (isSelected) {
		display = theme.bg("selectedBg", display);
	}
	const pad = " ".repeat(paddingX);
	return pad + display + pad;
}

/**
 * Single-line list row that paints `selectedBg` across the full available width
 * when selected (same idiom as session/tree selectors). Used by Container-based
 * selectors that rebuild via TruncatedText-style children without a render(width)
 * list body.
 */
export class SelectableRow implements Component {
	private text: string;
	private isSelected: boolean;
	private paddingX: number;

	constructor(text: string, isSelected: boolean, paddingX = 0) {
		this.text = text;
		this.isSelected = isSelected;
		this.paddingX = paddingX;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [paintSelectedRow(this.text, width, this.isSelected, this.paddingX)];
	}
}
