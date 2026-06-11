import type { Component } from "../tui.ts";

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	private lines: number;
	// Memoized render output. The lines are width-independent and always empty,
	// so the same array instance can be handed back every frame — parents detect
	// "child changed" by reference identity (see the Component render contract).
	// Reallocated when the line count changes and on invalidate().
	private cache: string[] | null = null;

	constructor(lines: number = 1) {
		this.lines = lines;
	}

	setLines(lines: number): void {
		if (lines !== this.lines) {
			this.lines = lines;
			this.cache = null;
		}
	}

	invalidate(): void {
		this.cache = null;
	}

	render(_width: number): string[] {
		this.cache ??= new Array<string>(this.lines).fill("");
		return this.cache;
	}
}
