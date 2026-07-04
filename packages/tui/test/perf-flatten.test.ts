import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Terminal } from "../src/terminal.js";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.js";
import { type Component, Container, TUI } from "../src/tui.js";
import { VirtualizedContainer } from "../src/virtualized-container.js";

class NullTerminal implements Terminal {
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	get columns(): number {
		return 40;
	}
	get rows(): number {
		return 10;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

/**
 * Child whose render() returns a freshly-built array on every call, but only
 * reallocates a *different* one when its text actually changes (mirrors how
 * Text/Markdown memoize: same reference when unchanged, new reference on
 * setText()). Lets a test drive "only the last child changed" precisely.
 */
class MemoChild implements Component {
	private out: string[];
	private text: string;
	renders = 0;

	constructor(text: string) {
		this.text = text;
		this.out = [text];
	}

	setText(text: string): void {
		if (text === this.text) return;
		this.text = text;
		this.out = [text];
	}

	render(): string[] {
		this.renders += 1;
		return this.out;
	}

	/** Current text without invoking render() (so building an oracle doesn't perturb renders counters). */
	currentText(): string {
		return this.text;
	}

	invalidate(): void {}
}

/** Naive full-rebuild flatten (reads current state directly, no render() calls). */
function naiveFlatten(children: MemoChild[]): string[] {
	return children.map((c) => c.currentText());
}

describe("Container.render prefix reuse", () => {
	it("reuses the unchanged prefix (new array identity, byte-identical content) when only the last child changes", () => {
		const container = new Container();
		const children: MemoChild[] = [];
		for (let i = 0; i < 50; i++) {
			const child = new MemoChild(`line-${i}`);
			children.push(child);
			container.addChild(child);
		}

		const first = container.render(80);
		assert.deepEqual(first, naiveFlatten(children));

		children[49].setText("line-49-CHANGED");
		const second = container.render(80);

		assert.notStrictEqual(second, first, "output must be a new array when content changed");
		assert.deepEqual(second, naiveFlatten(children), "content must match a full rebuild");
		// Only the last child's setText should have produced new render() output;
		// nothing else needed to be re-flattened by content, just spliced.
		assert.equal(children[0].renders, 2, "unaffected children are still polled every frame");
	});

	it("reuses the unchanged prefix when a middle child changes, leaving the tail intact", () => {
		const container = new Container();
		const children: MemoChild[] = [];
		for (let i = 0; i < 10; i++) {
			const child = new MemoChild(`line-${i}`);
			children.push(child);
			container.addChild(child);
		}
		const first = container.render(40);

		children[4].setText("line-4-CHANGED");
		const second = container.render(40);

		assert.notStrictEqual(second, first);
		assert.deepEqual(second, naiveFlatten(children));
	});

	it("falls back to a full rebuild when the child count changes", () => {
		const container = new Container();
		const a = new MemoChild("a");
		container.addChild(a);
		const first = container.render(80);
		assert.deepEqual(first, ["a"]);

		const b = new MemoChild("b");
		container.addChild(b);
		const second = container.render(80);
		assert.deepEqual(second, ["a", "b"]);
	});
});

class CountingText implements Component {
	renderCount = 0;
	text: string;

	constructor(text: string) {
		this.text = text;
	}

	setText(text: string): void {
		this.text = text;
	}

	render(width: number): string[] {
		this.renderCount += 1;
		return [this.text.padEnd(Math.min(width, this.text.length + 1))];
	}

	invalidate(): void {}
}

function naiveFlattenVirtualized(children: CountingText[], width: number): string[] {
	const lines: string[] = [];
	for (const child of children) {
		for (const line of child.render(width)) lines.push(line);
	}
	return lines;
}

describe("VirtualizedContainer prefix reuse", () => {
	it("reuses the unchanged prefix (new array identity, byte-identical content) when only the tail child changes", () => {
		const container = new VirtualizedContainer(1);
		const cold: CountingText[] = [];
		for (let i = 0; i < 20; i++) {
			const child = new CountingText(`cold-${i}`);
			cold.push(child);
			container.addChild(child);
		}
		const hot = new CountingText("hot");
		container.addChild(hot);

		const first = container.render(40);
		assert.equal(first.length, cold.length + 1);

		hot.setText("hot-2");
		const second = container.render(40);

		assert.notStrictEqual(second, first, "output must be a new array when content changed");
		// Cold children were never re-rendered (still cached from frame 1), so
		// their contribution to `second` must be byte-identical to `first`'s.
		assert.deepEqual(second.slice(0, cold.length), first.slice(0, cold.length));
		assert.equal(second[second.length - 1], hot.render(40)[0]);
		for (const child of cold) {
			assert.equal(child.renderCount, 1, "cold children outside the hot zone must not be re-rendered");
		}
	});

	it("matches a naive full flatten after several tail-only updates", () => {
		const container = new VirtualizedContainer(2);
		const children: CountingText[] = [];
		for (let i = 0; i < 8; i++) {
			const child = new CountingText(`item-${i}`);
			children.push(child);
			container.addChild(child);
		}
		container.render(30);

		for (let tick = 0; tick < 5; tick++) {
			children[children.length - 1].setText(`item-last-tick-${tick}`);
			const rendered = container.render(30);
			assert.deepEqual(rendered, naiveFlattenVirtualized(children, 30));
		}
	});
});

describe("collectKittyImageIds Kitty capability gate", () => {
	it("returns the same shared empty-set instance on every frame for a non-Kitty terminal", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			// collectKittyImageIds is private; reach it the same way existing
			// perf-guard tests reach doRender() — a narrow cast for test-only access.
			const tui = new TUI(new NullTerminal());
			const collect = (
				tui as unknown as { collectKittyImageIds(lines: string[]): Set<number> }
			).collectKittyImageIds.bind(tui);
			const a = collect(["plain line"]);
			const b = collect(["another line"]);
			assert.equal(a.size, 0);
			assert.strictEqual(a, b, "non-Kitty frames should share one empty Set instance, not allocate a new one");
		} finally {
			resetCapabilitiesCache();
		}
	});
});
