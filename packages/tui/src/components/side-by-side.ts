/**
 * SideBySide — two components sharing one horizontal band.
 *
 * The transcript is append-only (settled rows scroll into the terminal's own
 * scrollback and are never repainted), so a true full-height side panel is not
 * something a stream-oriented TUI can offer. What it CAN offer is this: the live
 * band above the composer — the rows the renderer still owns — laid out in two
 * columns instead of stacked. On a wide terminal that turns dead right-hand space
 * into a place for standing state, without touching a single settled row.
 *
 * Layout:
 *
 *     ├ main column, width - rightWidth - gap ─┤  ├ gap ┤  ├ right ─┤
 *     todo 1                                              a.ts +4 −1
 *     todo 2                                              b.ts +9 −0
 *
 * Degrades to the main column ALONE — byte-identical to not having this wrapper
 * — when the terminal is narrower than `minWidth`, when the right component
 * renders nothing, or when a row of EITHER column is a sixel image line (those
 * carry their own cursor choreography and must never be concatenated with
 * anything — `truncateToWidth` does not even recognize the DCS wrapper, so
 * clipping one mangles the sequence). That last case is per-row, so a column
 * that paints an image mid-band simply drops the rail on that row and resumes
 * below it.
 *
 * Height is the taller of the two columns; the shorter one is padded with blanks.
 */

import { isImageLine } from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

export interface SideBySideOptions {
	/** Columns reserved for the right-hand component. */
	rightWidth: number;
	/** Blank columns between the two. */
	gap?: number;
	/** Below this terminal width the right column is dropped entirely. */
	minWidth: number;
	/** Runtime switch (a kill-flag, a setting): false renders the main column alone. */
	enabled?: () => boolean;
}

export class SideBySide implements Component {
	private readonly main: Component;
	private readonly right: Component;
	private readonly rightWidth: number;
	private readonly gap: number;
	private readonly minWidth: number;
	private readonly enabled: () => boolean;

	constructor(main: Component, right: Component, options: SideBySideOptions) {
		this.main = main;
		this.right = right;
		this.rightWidth = Math.max(1, Math.floor(options.rightWidth));
		this.gap = Math.max(0, Math.floor(options.gap ?? 2));
		this.minWidth = Math.max(1, Math.floor(options.minWidth));
		this.enabled = options.enabled ?? (() => true);
	}

	invalidate(): void {
		this.main.invalidate?.();
		this.right.invalidate?.();
	}

	render(width: number): string[] {
		if (!this.enabled() || width < this.minWidth) return this.main.render(width);

		const mainWidth = Math.max(1, width - this.rightWidth - this.gap);
		const rightLines = this.right.render(this.rightWidth);
		// Nothing on the right → the main column keeps the FULL width, exactly as
		// if this wrapper were not in the tree. Re-rendering is required: it was
		// just measured at the narrower width.
		if (rightLines.length === 0) return this.main.render(width);

		const mainLines = this.main.render(mainWidth);
		const rows = Math.max(mainLines.length, rightLines.length);
		const pad = " ".repeat(this.gap);
		const out: string[] = [];
		for (let i = 0; i < rows; i++) {
			const left = mainLines[i] ?? "";
			const rail = rightLines[i] ?? "";
			if (isImageLine(left) || isImageLine(rail)) {
				// A sixel row owns its whole line (cursor save/restore, self-clear).
				// Concatenating ONLY happens with plain text on both sides — an
				// image in the rail drops it on this row the same way one in the
				// main column does.
				out.push(left);
				continue;
			}
			if (!rail) {
				out.push(left);
				continue;
			}
			const clipped = truncateToWidth(left, mainWidth, "…");
			const filler = " ".repeat(Math.max(0, mainWidth - visibleWidth(clipped)));
			out.push(`${clipped}${filler}${pad}${truncateToWidth(rail, this.rightWidth, "…")}`);
		}
		return out;
	}
}
