import type { Component } from "../tui.ts";
import { truncateToWidth } from "../utils.ts";

/**
 * Text component that truncates to fit viewport width
 */
export class TruncatedText implements Component {
	private text: string;
	private paddingX: number;
	private paddingY: number;

	constructor(text: string, paddingX: number = 0, paddingY: number = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
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

		return result;
	}
}
