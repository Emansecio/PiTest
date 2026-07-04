import type { Component } from "../tui.ts";
import { applyBackgroundToLine, visibleWidth } from "../utils.ts";

type RenderCache = {
	// One entry per child, holding the exact array reference that child
	// returned last render — NOT the left-padded/materialized lines. Compared
	// by reference identity (see matchCache), per the Component memoization
	// contract: a child returns the same array instance when its output is
	// unchanged, so this lets us detect "nothing changed" before paying for the
	// leftPad concat (and the rest of materialization) below.
	childRefs: string[][];
	width: number;
	bgSample: string | undefined;
	lines: string[];
};

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements Component {
	children: Component[] = [];
	private paddingX: number;
	private paddingY: number;
	private bgFn?: (text: string) => string;

	// Cache for rendered output
	private cache?: RenderCache;

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.invalidateCache();
		}
	}

	clear(): void {
		this.children = [];
		this.invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	setPadding(paddingX: number, paddingY: number): void {
		if (paddingX === this.paddingX && paddingY === this.paddingY) return;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.invalidateCache();
	}

	private invalidateCache(): void {
		this.cache = undefined;
	}

	private matchCache(width: number, childRefs: string[][], bgSample: string | undefined): boolean {
		const cache = this.cache;
		if (
			!cache ||
			cache.width !== width ||
			cache.bgSample !== bgSample ||
			cache.childRefs.length !== childRefs.length
		) {
			return false;
		}
		for (let i = 0; i < childRefs.length; i++) {
			if (cache.childRefs[i] !== childRefs[i]) return false;
		}
		return true;
	}

	invalidate(): void {
		this.invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		if (this.children.length === 0) {
			return [];
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);

		// Render all children, but hold onto their returned array *references*
		// only — don't materialize the left-padded lines yet. The cache check
		// below (matchCache) compares these by identity, so on a hit we skip the
		// leftPad concat (and everything after it) entirely.
		const childRefs: string[][] = [];
		for (const child of this.children) {
			childRefs.push(child.render(contentWidth));
		}

		// Check if bgFn output changed by sampling
		const bgSample = this.bgFn ? this.bgFn("test") : undefined;

		// Check cache validity
		if (this.matchCache(width, childRefs, bgSample)) {
			return this.cache!.lines;
		}

		// Cache miss: materialize the left-padded content lines now.
		const leftPad = " ".repeat(this.paddingX);
		const childLines: string[] = [];
		for (const lines of childRefs) {
			for (const line of lines) {
				childLines.push(leftPad + line);
			}
		}

		if (childLines.length === 0) {
			return [];
		}

		// Apply background and padding
		const result: string[] = [];

		// Top padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		// Content
		for (const line of childLines) {
			result.push(this.applyBg(line, width));
		}

		// Bottom padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		// Update cache
		this.cache = { childRefs, width, bgSample, lines: result };

		return result;
	}

	private applyBg(line: string, width: number): string {
		if (this.bgFn) {
			const visLen = visibleWidth(line);
			const padNeeded = Math.max(0, width - visLen);
			const padded = line + " ".repeat(padNeeded);
			return applyBackgroundToLine(padded, width, this.bgFn);
		}
		// No background: return the line without trailing-space padding,
		// mirroring Text/TruncatedText (padding serves no purpose without bgFn).
		return line;
	}
}
