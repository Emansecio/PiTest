import { type Component, truncateToWidth, visibleWidth } from "@pit/tui";

interface ComposerCache {
	width: number;
	contentLines: string[];
	lowerLines: string[];
	footerLines: string[];
	borderSample: string;
	gutterActive: boolean;
	gutterLines: string[];
	lines: string[];
}

/** One rounded frame around the existing editor, lower widgets, and footer. */
export class ComposerChrome implements Component {
	private readonly content: Component;
	private readonly lowerContent: Component | undefined;
	private footer: Component;
	private borderColor: (text: string) => string;
	private cache: ComposerCache | undefined;
	// Optional decoration composited to the RIGHT of the input frame (the pet
	// companion). It only borrows columns from the frame — never from the footer
	// strip below, which always spans the full width.
	private rightGutter: Component | undefined;
	private rightGutterFootprint = 0;
	private rightGutterVisible: ((width: number) => boolean) | undefined;

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

	/**
	 * Attach (or clear, with `component: undefined`) a decoration painted beside
	 * the input frame. `footprint` is the total columns reserved for it (glyph +
	 * breathing gap); `visible` gates it per-frame on the current width. Only the
	 * frame narrows to make room — the footer keeps the full width.
	 */
	setRightGutter(component: Component | undefined, footprint = 0, visible?: (width: number) => boolean): void {
		this.rightGutter = component;
		this.rightGutterFootprint = Math.max(0, footprint);
		this.rightGutterVisible = visible;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
		this.content.invalidate?.();
		this.lowerContent?.invalidate?.();
		this.footer.invalidate?.();
		this.rightGutter?.invalidate?.();
	}

	render(width: number): string[] {
		const framed = width >= 3;
		// The gutter only ever borrows from a real (framed) input box wide enough
		// to still leave the editor room after the reservation.
		const gutterActive =
			framed &&
			!!this.rightGutter &&
			this.rightGutterFootprint > 0 &&
			width - this.rightGutterFootprint >= 3 &&
			(this.rightGutterVisible?.(width) ?? true);
		const gutterFootprint = gutterActive ? this.rightGutterFootprint : 0;
		const frameWidth = Math.max(1, width - gutterFootprint);
		const innerWidth = framed ? frameWidth - 2 : Math.max(1, frameWidth);

		const contentLines = this.content.render(innerWidth);
		const lowerLines = this.lowerContent?.render(innerWidth) ?? [];
		// The footer lives OUTSIDE the frame — a plain status strip below the bottom
		// border, not another boxed row. A 1-col indent (when framed) lines it up
		// with the framed content rather than the border, so the box reads as a
		// clean input surface and the metadata sits quietly underneath it. It always
		// spans the FULL width; the gutter reservation applies only to the frame.
		const footerIndent = framed ? 1 : 0;
		const footerWidth = Math.max(1, width - footerIndent);
		const footerLines = this.footer.render(footerWidth);
		const gutterLines = gutterActive ? this.rightGutter!.render(gutterFootprint) : [];
		const borderSample = this.borderColor("x");
		const cache = this.cache;
		if (
			cache &&
			cache.width === width &&
			cache.contentLines === contentLines &&
			cache.lowerLines === lowerLines &&
			cache.footerLines === footerLines &&
			cache.borderSample === borderSample &&
			cache.gutterActive === gutterActive &&
			cache.gutterLines === gutterLines
		) {
			return cache.lines;
		}

		const indent = " ".repeat(footerIndent);
		const footerStrip = footerLines.map((line) => `${indent}${truncateToWidth(line, footerWidth)}`);

		if (!framed) {
			const lines = [...contentLines, ...lowerLines, ...footerStrip].map((line) => truncateToWidth(line, width));
			this.cache = this.seed(
				width,
				contentLines,
				lowerLines,
				footerLines,
				borderSample,
				gutterActive,
				gutterLines,
				lines,
			);
			return lines;
		}

		const framedBody = [...contentLines, ...lowerLines];
		const frameLines = [this.borderColor(`╭${"─".repeat(innerWidth)}╮`)];
		for (const rawLine of framedBody) {
			const inner = truncateToWidth(rawLine, innerWidth);
			const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(inner)));
			frameLines.push(`${this.borderColor("│")}${inner}${padding}${this.borderColor("│")}`);
		}
		frameLines.push(this.borderColor(`╰${"─".repeat(innerWidth)}╯`));

		// Composite the gutter decoration beside the frame rows, right-aligned within
		// its reserved footprint (breathing gap lands between the border and the pet).
		const lines = gutterActive
			? frameLines.map((frameLine, i) => {
					const gutter =
						i < gutterLines.length
							? this.alignGutter(gutterLines[i]!, gutterFootprint)
							: " ".repeat(gutterFootprint);
					return `${frameLine}${gutter}`;
				})
			: frameLines;
		lines.push(...footerStrip);

		this.cache = this.seed(
			width,
			contentLines,
			lowerLines,
			footerLines,
			borderSample,
			gutterActive,
			gutterLines,
			lines,
		);
		return lines;
	}

	/** Right-align a gutter line within `footprint` columns (pad on the left). */
	private alignGutter(line: string, footprint: number): string {
		const w = visibleWidth(line);
		if (w >= footprint) return truncateToWidth(line, footprint);
		return `${" ".repeat(footprint - w)}${line}`;
	}

	private seed(
		width: number,
		contentLines: string[],
		lowerLines: string[],
		footerLines: string[],
		borderSample: string,
		gutterActive: boolean,
		gutterLines: string[],
		lines: string[],
	): ComposerCache {
		return { width, contentLines, lowerLines, footerLines, borderSample, gutterActive, gutterLines, lines };
	}
}
