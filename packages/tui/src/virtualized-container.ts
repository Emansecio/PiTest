import type { Component } from "./tui.ts";

/** Default hot-zone: re-render this many trailing lines every frame. */
export const DEFAULT_VIRTUALIZED_TAIL_LINE_BUDGET = 200;

type ChildRenderCache = {
	component: Component;
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
	// Per-child starting offset into flattenLines from the last flatten (full
	// rebuild or prefix-reused — see render()/flattenFromIndex()). Always
	// resized/recomputed in lockstep with childCaches (both only change together,
	// in flattenCaches() or the structureChanged branch of render()), so its
	// length always matches children.length whenever the incremental path runs.
	private childOffsets: number[] = [];

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
			this.flattenLines = [];
			this.childOffsets = [];
			this.rebuildStaleIndicesAfterRemoval(index);
		}
	}

	clear(): void {
		this.children = [];
		this.childCaches = [];
		this.flattenLines = [];
		this.childOffsets = [];
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
		const grewByAppend =
			width === this.cacheWidth && children.length > this.childCaches.length && this.cachedPrefixMatches(children);
		const structureChanged =
			!grewByAppend && (width !== this.cacheWidth || this.childCaches.length !== children.length);
		if (structureChanged) {
			this.cacheWidth = width;
			this.childCaches = new Array(children.length);
			for (let i = 0; i < children.length; i++) {
				const lines = renderChild(children[i], width);
				this.childCaches[i] = { component: children[i], width, lines };
			}
			this.staleIndices.clear();
			return this.flattenCaches();
		}

		const hotStartIdx = this.findHotStartIndex(children);

		let reusable = this.flattenLines.length > 0;
		// First index whose rendered lines actually changed reference this frame
		// (among the children we bothered to re-render — cold, non-stale children
		// are skipped above and can't have changed). Left at -1 if nothing changed.
		let minChangedIndex = -1;
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
				if (minChangedIndex === -1) minChangedIndex = i;
			}
			this.childCaches[i] = { component: children[i], width, lines };
			this.staleIndices.delete(i);
		}

		if (reusable) {
			return this.flattenLines;
		}

		// Prefix reuse: every child before minChangedIndex is either untouched
		// (skipped above, still whatever it flattened to last frame) or was
		// re-rendered but produced the same array reference — either way its
		// contribution to flattenLines is byte-identical to last frame. Splice a
		// slice() of that unchanged prefix with the current lines of every child
		// from minChangedIndex onward instead of re-pushing the whole transcript.
		if (minChangedIndex !== -1 && this.flattenLines.length > 0 && this.childOffsets.length >= minChangedIndex) {
			return this.flattenFromIndex(minChangedIndex);
		}
		return this.flattenCaches();
	}

	/**
	 * True iff every already-cached child (index < this.childCaches.length)
	 * is still the same component instance at that index in `children`. Guards
	 * the append fast-path against a middle-insertion or external mutation of
	 * `children` masquerading as a pure length-grew-by-append.
	 */
	private cachedPrefixMatches(children: Component[]): boolean {
		for (let i = 0; i < this.childCaches.length; i++) {
			if (this.childCaches[i].component !== children[i]) {
				return false;
			}
		}
		return true;
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
		const offsets = new Array<number>(this.childCaches.length);
		for (let i = 0; i < this.childCaches.length; i++) {
			offsets[i] = lines.length;
			const childLines = this.childCaches[i].lines;
			for (let j = 0; j < childLines.length; j++) {
				lines.push(childLines[j]);
			}
		}
		this.childOffsets = offsets;
		this.flattenLines = lines;
		return lines;
	}

	/**
	 * Reuse the unchanged prefix of the last flatten (everything before
	 * `fromIndex`, via slice()) and append the current lines of every child from
	 * `fromIndex` onward. Always returns a new array, preserving the render()
	 * memoization contract (parents detect a change by array identity).
	 */
	private flattenFromIndex(fromIndex: number): string[] {
		const prefixLen =
			fromIndex < this.childOffsets.length ? (this.childOffsets[fromIndex] ?? 0) : this.flattenLines.length;
		const lines = this.flattenLines.slice(0, prefixLen);
		const offsets = this.childOffsets;
		let offset = prefixLen;
		for (let i = fromIndex; i < this.childCaches.length; i++) {
			offsets[i] = offset;
			const childLines = this.childCaches[i].lines;
			for (let j = 0; j < childLines.length; j++) {
				lines.push(childLines[j]);
			}
			offset += childLines.length;
		}
		this.flattenLines = lines;
		return lines;
	}
}
