import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";
import { Box } from "./box.ts";

type RenderCache = {
	width: number;
	childSig: string;
	lines: string[];
};

/**
 * Rounded card frame (`╭─╮` / `│` / `╰─╯`) with internal padding via {@link Box}.
 * Width-keyed memo matches {@link DynamicBorder} in coding-agent.
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

	private childSignature(): string {
		// Box has no stable child-id API; width-only memo is enough when children
		// call invalidate() on mutation (same contract as Box.render).
		return String(this.box.children.length);
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const childSig = this.childSignature();
		const cache = this.cache;
		if (cache && cache.width === width && cache.childSig === childSig) {
			return cache.lines;
		}

		const rule = "─".repeat(innerWidth);
		const top = truncateToWidth(this.borderColor(`╭${rule}╮`), width);
		const bottom = truncateToWidth(this.borderColor(`╰${rule}╯`), width);
		const boxLines = this.box.render(innerWidth);

		if (boxLines.length === 0) {
			const lines = [top, bottom];
			this.cache = { width, childSig, lines };
			return lines;
		}

		const lines: string[] = [top];
		for (const rawLine of boxLines) {
			const inner = truncateToWidth(rawLine, innerWidth);
			const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(inner)));
			lines.push(truncateToWidth(`${this.borderColor("│")}${inner}${pad}${this.borderColor("│")}`, width));
		}
		lines.push(bottom);

		this.cache = { width, childSig, lines };
		return lines;
	}
}
