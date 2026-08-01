import { type Component, type MouseEvent, type MouseTarget, truncateToWidth } from "@pit/tui";
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
 *
 * Also the mouse leaf for those selectors: the TUI's hit-test walker descends
 * the Container chain to the deepest {@link MouseTarget}, which is this row.
 * The owning selector wires `onClick` when building the row; a left press then
 * notifies the owner (which decides select vs confirm) and is claimed, so it
 * never counts as an unclaimed press (which would auto-suspend mouse tracking).
 */
export class SelectableRow implements Component, MouseTarget {
	private text: string;
	private isSelected: boolean;
	private paddingX: number;
	private onClick?: () => void;

	constructor(text: string, isSelected: boolean, paddingX = 0, onClick?: () => void) {
		this.text = text;
		this.isSelected = isSelected;
		this.paddingX = paddingX;
		this.onClick = onClick;
	}

	invalidate(): void {}

	/**
	 * Left-press claims the row and notifies the owner. Everything else — right/
	 * middle press, drag, release — is declined, and a row constructed without a
	 * handler declines too, keeping legacy call sites (no wiring) byte-identical
	 * in behavior and native text selection available over inert rows.
	 */
	onMouse(ev: MouseEvent, _localRow: number, _localCol: number): boolean {
		if (ev.type !== "press" || ev.button !== "left") return false;
		if (!this.onClick) return false;
		this.onClick();
		return true;
	}

	render(width: number): string[] {
		return [paintSelectedRow(this.text, width, this.isSelected, this.paddingX)];
	}
}
