import type { Component } from "./tui.ts";

/** Default hot-zone: re-render this many trailing lines every frame. */
export const DEFAULT_VIRTUALIZED_TAIL_LINE_BUDGET = 200;

type ChildRenderCache = {
	width: number;
	lines: string[];
};

function renderChild(child: Component, width: number): string[] {
	return child.render(width);
}

/**
 * Container that skips re-rendering transcript children far above the tail.
 * Chat history components are mostly immutable once settled; only the bottom
 * slice (spinner, streaming, latest blocks) changes each frame.
 */
export class VirtualizedContainer implements Component {
	children: Component[] = [];
	private tailLineBudget: number;
	private cacheWidth = -1;
	private childCaches: ChildRenderCache[] = [];
	private flattenLines: string[] = [];
	private staleIndices = new Set<number>();

	constructor(tailLineBudget = DEFAULT_VIRTUALIZED_TAIL_LINE_BUDGET) {
		this.tailLineBudget = tailLineBudget;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.staleIndices.add(this.children.length - 1);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.childCaches.splice(index, 1);
			this.rebuildStaleIndicesAfterRemoval(index);
		}
	}

	clear(): void {
		this.children = [];
		this.childCaches = [];
		this.flattenLines = [];
		this.cacheWidth = -1;
		this.staleIndices.clear();
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
		for (let i = 0; i < this.children.length; i++) {
			this.staleIndices.add(i);
		}
	}

	/** Mark one child for re-render on the next frame without invalidating the full tree. */
	markChildStale(child: Component): void {
		const index = this.children.indexOf(child);
		if (index !== -1) {
			this.staleIndices.add(index);
		}
	}

	render(width: number): string[] {
		const children = this.children;
		const structureChanged = width !== this.cacheWidth || this.childCaches.length !== children.length;
		if (structureChanged) {
			this.cacheWidth = width;
			this.childCaches = new Array(children.length);
			for (let i = 0; i < children.length; i++) {
				const lines = renderChild(children[i], width);
				this.childCaches[i] = { width, lines };
			}
			this.staleIndices.clear();
			return this.flattenCaches();
		}

		const hotStartIdx = this.findHotStartIndex(children);

		let reusable = this.flattenLines.length > 0;
		for (let i = 0; i < children.length; i++) {
			const inHotZone = i >= hotStartIdx;
			const isStale = this.staleIndices.has(i);
			if (!inHotZone && !isStale) {
				continue;
			}
			const lines = renderChild(children[i], width);
			const prev = this.childCaches[i];
			if (!prev || lines !== prev.lines) {
				reusable = false;
			}
			this.childCaches[i] = { width, lines };
			this.staleIndices.delete(i);
		}

		if (reusable) {
			return this.flattenLines;
		}
		return this.flattenCaches();
	}

	private findHotStartIndex(children: Component[]): number {
		let linesFromBottom = 0;
		let hotStartIdx = 0;
		for (let i = children.length - 1; i >= 0; i--) {
			const cached = this.childCaches[i];
			linesFromBottom += cached?.lines.length ?? 0;
			hotStartIdx = i;
			if (linesFromBottom >= this.tailLineBudget) {
				break;
			}
		}
		return hotStartIdx;
	}

	private rebuildStaleIndicesAfterRemoval(removedIndex: number): void {
		const next = new Set<number>();
		for (const idx of this.staleIndices) {
			if (idx < removedIndex) {
				next.add(idx);
			} else if (idx > removedIndex) {
				next.add(idx - 1);
			}
		}
		this.staleIndices = next;
	}

	private flattenCaches(): string[] {
		const lines: string[] = [];
		for (const cache of this.childCaches) {
			const childLines = cache.lines;
			for (let j = 0; j < childLines.length; j++) {
				lines.push(childLines[j]);
			}
		}
		this.flattenLines = lines;
		return lines;
	}
}
