import { type Component, truncateToWidth, visibleWidth } from "@pit/tui";

interface ComposerCache {
	width: number;
	contentLines: string[];
	lowerLines: string[];
	footerLines: string[];
	gutterActive: boolean;
	gutterLines: string[];
	lines: string[];
}

/**
 * Unframed composer: stacks the editor content, optional lower widgets, and the
 * footer strip flush-left at the full requested width — no boxed border. The mode
 * signal the border used to carry (bash/plan/accent) now rides on the editor's own
 * `❯` prompt glyph and leading `!` bang-prefix (see custom-editor/interactive-mode's
 * `updateEditorBorderColor`), so there is nothing left for this component to color.
 */
export class ComposerChrome implements Component {
	private readonly content: Component;
	private readonly lowerContent: Component | undefined;
	private footer: Component;
	private cache: ComposerCache | undefined;
	// Optional decoration composited to the RIGHT of the input (the pet
	// companion). It only borrows columns from the content — never from the
	// footer strip below, which always spans the full width.
	private rightGutter: Component | undefined;
	private rightGutterFootprint = 0;
	private rightGutterVisible: ((width: number) => boolean) | undefined;

	constructor(content: Component, footer: Component, lowerContent?: Component) {
		this.content = content;
		this.lowerContent = lowerContent;
		this.footer = footer;
	}

	setFooter(footer: Component): void {
		if (footer === this.footer) return;
		this.footer = footer;
		this.cache = undefined;
	}

	/**
	 * Attach (or clear, with `component: undefined`) a decoration painted beside
	 * the input. `footprint` is the total columns reserved for it (glyph +
	 * breathing gap); `visible` gates it per-frame on the current width. Only the
	 * content narrows to make room — the footer keeps the full width.
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
		// The gutter only ever borrows from content wide enough to still leave the
		// editor a usable column after the reservation.
		const gutterActive =
			!!this.rightGutter &&
			this.rightGutterFootprint > 0 &&
			width - this.rightGutterFootprint >= 1 &&
			(this.rightGutterVisible?.(width) ?? true);
		const gutterFootprint = gutterActive ? this.rightGutterFootprint : 0;
		const contentWidth = Math.max(1, width - gutterFootprint);

		const contentLines = this.content.render(contentWidth);
		const lowerLines = this.lowerContent?.render(contentWidth) ?? [];
		const footerWidth = Math.max(1, width);
		const footerLines = this.footer.render(footerWidth);
		const gutterLines = gutterActive ? this.rightGutter!.render(gutterFootprint) : [];
		const cache = this.cache;
		if (
			cache &&
			cache.width === width &&
			cache.contentLines === contentLines &&
			cache.lowerLines === lowerLines &&
			cache.footerLines === footerLines &&
			cache.gutterActive === gutterActive &&
			cache.gutterLines === gutterLines
		) {
			return cache.lines;
		}

		const footerStrip = footerLines.map((line) => truncateToWidth(line, footerWidth));
		// Pad every content/lower row to the full content width — cosmetically
		// unnecessary alone, but required when the pet gutter rides alongside: rows
		// of differing length would otherwise shift the gutter's column per row.
		const padToContentWidth = (line: string): string => {
			const truncated = truncateToWidth(line, contentWidth);
			return `${truncated}${" ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)))}`;
		};
		let body = [...contentLines, ...lowerLines].map(padToContentWidth);

		// With no boxed frame, a single-line (or otherwise short) input no longer
		// gets 2 free border rows to lend the gutter. Center the real content
		// within the gutter's row span instead (blank content-width rows above
		// and below) so a fixed-height decoration like the pet companion still
		// has room and keeps its old vertical alignment (content on its middle row).
		if (gutterActive && gutterLines.length > body.length) {
			const blankRow = " ".repeat(contentWidth);
			const padCount = gutterLines.length - body.length;
			const topPad = Math.floor(padCount / 2);
			const bottomPad = padCount - topPad;
			body = [...Array(topPad).fill(blankRow), ...body, ...Array(bottomPad).fill(blankRow)];
		}

		const lines = gutterActive
			? body.map((bodyLine, i) => {
					const gutter =
						i < gutterLines.length
							? this.alignGutter(gutterLines[i]!, gutterFootprint)
							: " ".repeat(gutterFootprint);
					return `${bodyLine}${gutter}`;
				})
			: body;
		lines.push(...footerStrip);

		this.cache = { width, contentLines, lowerLines, footerLines, gutterActive, gutterLines, lines };
		return lines;
	}

	/** Right-align a gutter line within `footprint` columns (pad on the left). */
	private alignGutter(line: string, footprint: number): string {
		const w = visibleWidth(line);
		if (w >= footprint) return truncateToWidth(line, footprint);
		return `${" ".repeat(footprint - w)}${line}`;
	}
}
