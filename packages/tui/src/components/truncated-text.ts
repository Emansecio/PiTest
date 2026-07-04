import type { Component } from "../tui.ts";
import { truncateToWidth } from "../utils.ts";

/**
 * Text component that truncates to fit viewport width
 */
export class TruncatedText implements Component {
	private text: string;
	private paddingX: number;
	private paddingY: number;

	// Cache for rendered output, memoized by (text, width) — mirrors Text's
	// cache (see text.ts). TruncatedText re-renders every frame it's visible
	// (per the Component memoization contract in tui.ts), so without this the
	// indexOf/substring/truncateToWidth work (including grapheme segmentation
	// for non-ASCII text) reran and allocated a fresh array on every frame even
	// when nothing changed.
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(text: string, paddingX: number = 0, paddingY: number = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	/** Update the displayed text, reallocating the cache only when it actually changes. */
	setText(text: string): void {
		if (text === this.text) return;
		this.text = text;
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const result: string[] = [];

		// Add vertical padding above (blank lines — the renderer owns clearing,
		// so padding them to width would be dead bytes)
		for (let i = 0; i < this.paddingY; i++) {
			result.push("");
		}

		// Calculate available width after horizontal padding
		const availableWidth = Math.max(1, width - this.paddingX * 2);

		// Take only the first line (stop at newline)
		let singleLineText = this.text;
		const newlineIndex = this.text.indexOf("\n");
		if (newlineIndex !== -1) {
			singleLineText = this.text.substring(0, newlineIndex);
		}

		// Truncate text if needed (accounting for ANSI codes)
		const displayText = truncateToWidth(singleLineText, availableWidth);

		// Add horizontal padding. No pad-to-width: the renderer clears every
		// line it rewrites, and trailing spaces overflow shells that prefix
		// content (gutter + label) — see Text for the full rationale.
		const leftPadding = " ".repeat(this.paddingX);
		const rightPadding = " ".repeat(this.paddingX);
		result.push(leftPadding + displayText + rightPadding);

		// Add vertical padding below
		for (let i = 0; i < this.paddingY; i++) {
			result.push("");
		}

		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result;
	}
}
