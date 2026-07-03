/**
 * A hairline rule between conversation turns. Rendered before a new user prompt
 * when prior messages already exist (never before the first), so the transcript
 * reads as discrete turns instead of one unbroken column.
 *
 * Renders exactly two lines: a leading blank, then a full-width `─` rule in the
 * muted border color. The trailing gap is intentionally left to the following
 * user message's own leading padding — emitting one here too would double it.
 */

import type { Component } from "@pit/tui";
import { theme } from "../theme/theme.ts";

export class TurnRule implements Component {
	// Memoized by width; the color fn is fixed, and theme changes cascade an
	// `ui.invalidate()` that clears this cache (see DynamicBorder for the same
	// contract). Reallocated on width change and on invalidate().
	private cachedWidth = -1;
	private cachedLines: string[] | null = null;

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = null;
	}

	render(width: number): string[] {
		if (this.cachedLines !== null && this.cachedWidth === width) {
			return this.cachedLines;
		}
		this.cachedWidth = width;
		this.cachedLines = ["", theme.fg("borderMuted", "─".repeat(Math.max(1, width)))];
		return this.cachedLines;
	}
}
