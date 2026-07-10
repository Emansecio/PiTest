import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";
import { Box } from "./box.ts";

type RenderCache = {
	width: number;
	/** Exact array reference returned by {@link Box.render} last time. */
	boxLinesRef: string[];
	lines: string[];
};

/**
 * Rounded card frame (`╭─╮` / `│` / `╰─╯`) with internal padding via {@link Box}.
 * Memo keys on width + the Box output array identity (Box itself memoizes by
 * child render refs), so nested mutations that change a child's output bust
 * this cache without requiring a direct addChild/clear on the Card.
 */
export class Card implements Component {
	private box: Box;
	private borderColor: (text: string) => string;
	private cache: RenderCache | undefined;

	constructor(
		paddingX = 1,
		paddingY = 0,
		bgFn?: (text: string) => string,
		borderColor: (text: string) => string = (text) => text,
	) {
		this.box = new Box(paddingX, paddingY, bgFn);
		this.borderColor = borderColor;
	}

	addChild(component: Component): void {
		this.box.addChild(component);
		this.invalidateCache();
	}

	removeChild(component: Component): void {
		this.box.removeChild(component);
		this.invalidateCache();
	}

	clear(): void {
		this.box.clear();
		this.invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.box.setBgFn(bgFn);
		this.invalidateCache();
	}

	setPadding(paddingX: number, paddingY: number): void {
		this.box.setPadding(paddingX, paddingY);
		this.invalidateCache();
	}

	setBorderColor(borderColor: (text: string) => string): void {
		this.borderColor = borderColor;
		this.invalidateCache();
	}

	private invalidateCache(): void {
		this.cache = undefined;
	}

	invalidate(): void {
		this.invalidateCache();
		this.box.invalidate();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		// Always ask Box first — its child-ref memo detects nested mutations
		// (e.g. a list Container that clear()+addChild()s). Keying only on
		// direct child *count* would keep a stale framed snapshot while the
		// list inside changed (model/oauth/extension selectors).
		const boxLines = this.box.render(innerWidth);
		const cache = this.cache;
		if (cache && cache.width === width && cache.boxLinesRef === boxLines) {
			return cache.lines;
		}

		const rule = "─".repeat(innerWidth);
		const top = truncateToWidth(this.borderColor(`╭${rule}╮`), width);
		const bottom = truncateToWidth(this.borderColor(`╰${rule}╯`), width);

		if (boxLines.length === 0) {
			const lines = [top, bottom];
			this.cache = { width, boxLinesRef: boxLines, lines };
			return lines;
		}

		const lines: string[] = [top];
		for (const rawLine of boxLines) {
			const inner = truncateToWidth(rawLine, innerWidth);
			const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(inner)));
			lines.push(truncateToWidth(`${this.borderColor("│")}${inner}${pad}${this.borderColor("│")}`, width));
		}
		lines.push(bottom);

		this.cache = { width, boxLinesRef: boxLines, lines };
		return lines;
	}
}
