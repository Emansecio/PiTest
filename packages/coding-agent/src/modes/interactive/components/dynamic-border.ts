import type { Component } from "@pit/tui";
import { theme } from "../theme/theme.ts";

/**
 * Dynamic border component that adjusts to viewport width.
 *
 * Note: When used from extensions loaded via jiti, the global `theme` may be undefined
 * because jiti creates a separate module cache. Always pass an explicit color
 * function when using DynamicBorder in components exported for extension use.
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;
	// Memoized rule line, keyed by width. The color fn is fixed per instance, so
	// width is the only render input; theme changes are covered because they call
	// `ui.invalidate()`, which cascades through Container/overlay children down to
	// every in-tree border (tui.ts Container.invalidate), clearing this cache.
	// Inline throwaway instances (`new DynamicBorder().render(w)`) are constructed
	// fresh per frame and can never hold a stale theme.
	private cachedWidth = -1;
	private cachedLines: string[] | null = null;

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
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
		this.cachedLines = [this.color("─".repeat(Math.max(1, width)))];
		return this.cachedLines;
	}
}
