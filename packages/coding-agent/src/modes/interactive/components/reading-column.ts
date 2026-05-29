import type { Component } from "@earendil-works/pi-tui";

/**
 * Width-capping wrapper.
 *
 * Renders its child at `min(width, maxColumns)` so long prose forms a fixed
 * reading column on wide terminals instead of stretching edge to edge. The
 * child pads its own lines to the (capped) width; the unused space to the right
 * is left blank, so the column stays left-aligned against whatever framing the
 * parent adds (e.g. the message-shell gutter) rather than floating centered and
 * detached from it.
 *
 * No-op when the available width is already `<= maxColumns` (narrow terminals),
 * and the child's own width-keyed caches stay valid because the capped width is
 * constant across resizes that keep the terminal wider than the cap.
 */
export class ReadingColumn implements Component {
	private readonly child: Component;
	private readonly maxColumns: number;

	constructor(child: Component, maxColumns: number) {
		this.child = child;
		this.maxColumns = maxColumns;
	}

	invalidate(): void {
		this.child.invalidate?.();
	}

	render(width: number): string[] {
		const capped = this.maxColumns > 0 ? Math.min(width, this.maxColumns) : width;
		return this.child.render(capped);
	}
}
