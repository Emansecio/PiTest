/**
 * Centered text block: each wrapped line is padded to the horizontal center of
 * the viewport. Companion to the welcome hero (welcome-box.ts) — `Text`
 * (@pit/tui) is deliberately left-aligned, and the hero's hint line is the
 * only flow content that wants centering.
 */

import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@pit/tui";

export class CenteredText implements Component {
	private text: string;
	private readonly paddingY: number;
	private cachedWidth = -1;
	private cachedText: string | null = null;
	private cachedLines: string[] | null = null;

	constructor(text: string, paddingY = 0) {
		this.text = text;
		this.paddingY = paddingY;
	}

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedText = null;
		this.cachedLines = null;
	}

	render(width: number): string[] {
		if (this.cachedLines !== null && this.cachedWidth === width && this.cachedText === this.text) {
			return this.cachedLines;
		}
		const blank: string[] = Array.from({ length: this.paddingY }, () => "");
		const body = wrapTextWithAnsi(this.text, Math.max(1, width)).map((line) => {
			const fit = visibleWidth(line) > width ? truncateToWidth(line, width) : line;
			return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(fit)) / 2))) + fit;
		});
		const lines = [...blank, ...body, ...blank];
		this.cachedWidth = width;
		this.cachedText = this.text;
		this.cachedLines = lines;
		return lines;
	}
}
