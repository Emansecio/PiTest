import { type Component, truncateToWidth, visibleWidth } from "@pit/tui";

interface ComposerCache {
	width: number;
	contentLines: string[];
	lowerLines: string[];
	footerLines: string[];
	perchActive: boolean;
	perchLines: string[];
	lines: string[];
}

/**
 * Unframed composer: stacks an optional perch decoration (the pet companion),
 * the editor content, optional lower widgets, and the footer strip flush-left at
 * the full requested width — no boxed border. The mode signal the border used to
 * carry (bash/plan/accent) now rides on the editor's own `❯` prompt glyph and
 * leading `!` bang-prefix (see custom-editor/interactive-mode's
 * `updateEditorBorderColor`), so there is nothing left for this component to color.
 */
export class ComposerChrome implements Component {
	private readonly content: Component;
	private readonly lowerContent: Component | undefined;
	private footer: Component;
	private cache: ComposerCache | undefined;
	// Optional decoration painted ABOVE the input on its own rows — the pet
	// companion, "perched" on top of the composer box. Unlike a side gutter it
	// borrows no columns from the editor: it spans the full width and
	// right-aligns its sprite. Its rows pass through VERBATIM (no truncate/pad)
	// so a sixel image line survives — the pet decides sixel vs. half-block cells.
	private perch: Component | undefined;
	private perchVisible: ((width: number) => boolean) | undefined;

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
	 * Attach (or clear, with `component: undefined`) a decoration painted on its
	 * own rows directly above the input. `visible` gates it per-frame on the
	 * current width (so the pet hides on narrow terminals / while a modal is up).
	 * The editor keeps its full width — the perch never narrows the content.
	 */
	setPerch(component: Component | undefined, visible?: (width: number) => boolean): void {
		this.perch = component;
		this.perchVisible = visible;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
		this.content.invalidate?.();
		this.lowerContent?.invalidate?.();
		this.footer.invalidate?.();
		this.perch?.invalidate?.();
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width);
		const contentLines = this.content.render(contentWidth);
		const lowerLines = this.lowerContent?.render(contentWidth) ?? [];
		const footerWidth = Math.max(1, width);
		const footerLines = this.footer.render(footerWidth);
		const perchActive = !!this.perch && (this.perchVisible?.(width) ?? true);
		const perchLines = perchActive ? this.perch!.render(width) : [];
		const cache = this.cache;
		if (
			cache &&
			cache.width === width &&
			cache.contentLines === contentLines &&
			cache.lowerLines === lowerLines &&
			cache.footerLines === footerLines &&
			cache.perchActive === perchActive &&
			cache.perchLines === perchLines
		) {
			return cache.lines;
		}

		const footerStrip = footerLines.map((line) => truncateToWidth(line, footerWidth));
		// Pad every content/lower row to the full width — the editor rows read as a
		// filled surface and, when the perch rides above, keep a stable width so the
		// pet's right edge does not appear to jitter between frames of differing text.
		const padToContentWidth = (line: string): string => {
			const truncated = truncateToWidth(line, contentWidth);
			return `${truncated}${" ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)))}`;
		};
		const body = [...contentLines, ...lowerLines].map(padToContentWidth);

		// Perch rows sit ABOVE the input, verbatim — a sixel image line (or an
		// already right-aligned cell block) must not be truncated or re-padded.
		const lines = [...perchLines, ...body, ...footerStrip];

		this.cache = { width, contentLines, lowerLines, footerLines, perchActive, perchLines, lines };
		return lines;
	}
}
