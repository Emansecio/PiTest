import { type Component, truncateToWidth, visibleWidth } from "@pit/tui";

interface ComposerCache {
	width: number;
	contentLines: string[];
	lowerLines: string[];
	footerLines: string[];
	borderSample: string;
	lines: string[];
}

/** One rounded frame around the existing editor, lower widgets, and footer. */
export class ComposerChrome implements Component {
	private readonly content: Component;
	private readonly lowerContent: Component | undefined;
	private footer: Component;
	private borderColor: (text: string) => string;
	private cache: ComposerCache | undefined;

	constructor(
		content: Component,
		footer: Component,
		lowerContent?: Component,
		borderColor: (text: string) => string = (text) => text,
	) {
		this.content = content;
		this.lowerContent = lowerContent;
		this.footer = footer;
		this.borderColor = borderColor;
	}

	setFooter(footer: Component): void {
		if (footer === this.footer) return;
		this.footer = footer;
		this.cache = undefined;
	}

	setBorderColor(borderColor: (text: string) => string): void {
		this.borderColor = borderColor;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
		this.content.invalidate?.();
		this.lowerContent?.invalidate?.();
		this.footer.invalidate?.();
	}

	render(width: number): string[] {
		const framed = width >= 3;
		const innerWidth = framed ? width - 2 : Math.max(1, width);
		const contentLines = this.content.render(innerWidth);
		const lowerLines = this.lowerContent?.render(innerWidth) ?? [];
		// The footer lives OUTSIDE the frame — a plain status strip below the bottom
		// border, not another boxed row. A 1-col indent (when framed) lines it up
		// with the framed content rather than the border, so the box reads as a
		// clean input surface and the metadata sits quietly underneath it.
		const footerIndent = framed ? 1 : 0;
		const footerWidth = Math.max(1, width - footerIndent);
		const footerLines = this.footer.render(footerWidth);
		const borderSample = this.borderColor("x");
		const cache = this.cache;
		if (
			cache &&
			cache.width === width &&
			cache.contentLines === contentLines &&
			cache.lowerLines === lowerLines &&
			cache.footerLines === footerLines &&
			cache.borderSample === borderSample
		) {
			return cache.lines;
		}

		const indent = " ".repeat(footerIndent);
		const footerStrip = footerLines.map((line) => `${indent}${truncateToWidth(line, footerWidth)}`);

		if (!framed) {
			const lines = [...contentLines, ...lowerLines, ...footerStrip].map((line) => truncateToWidth(line, width));
			this.cache = { width, contentLines, lowerLines, footerLines, borderSample, lines };
			return lines;
		}

		const framedBody = [...contentLines, ...lowerLines];
		const lines = [this.borderColor(`╭${"─".repeat(innerWidth)}╮`)];
		for (const rawLine of framedBody) {
			const inner = truncateToWidth(rawLine, innerWidth);
			const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(inner)));
			lines.push(`${this.borderColor("│")}${inner}${padding}${this.borderColor("│")}`);
		}
		lines.push(this.borderColor(`╰${"─".repeat(innerWidth)}╯`));
		lines.push(...footerStrip);

		this.cache = { width, contentLines, lowerLines, footerLines, borderSample, lines };
		return lines;
	}
}
