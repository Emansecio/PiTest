/**
 * A hairline rule between conversation turns. Rendered before a new user prompt
 * when prior messages already exist (never before the first), so the transcript
 * reads as discrete turns instead of one unbroken column.
 *
 * Renders exactly two lines: a leading blank, then a `─` rule capped to the
 * assistant reading width in the muted border color. The trailing gap is left
 * to the following user message's own leading padding.
 */

import type { Component } from "@pit/tui";
import { DEFAULT_ASSISTANT_READING_COLUMNS } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";

export class TurnRule implements Component {
	// Memoized by width; the color fn is fixed, and theme changes cascade an
	// `ui.invalidate()` that clears this cache (see DynamicBorder for the same
	// contract). Reallocated on width change and on invalidate().
	private cachedWidth = -1;
	private cachedLines: string[] | null = null;
	private readonly maxColumns: number;

	constructor(maxColumns = DEFAULT_ASSISTANT_READING_COLUMNS) {
		this.maxColumns = maxColumns;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = null;
	}

	render(width: number): string[] {
		if (this.cachedLines !== null && this.cachedWidth === width) {
			return this.cachedLines;
		}
		this.cachedWidth = width;
		const ruleWidth = this.maxColumns > 0 ? Math.min(width, this.maxColumns) : width;
		this.cachedLines = ["", theme.fg("borderMuted", "─".repeat(Math.max(1, ruleWidth)))];
		return this.cachedLines;
	}
}
