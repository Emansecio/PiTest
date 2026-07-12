import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.js";
import type { Component } from "../src/tui.js";
import { VirtualizedContainer } from "../src/virtualized-container.js";

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

class StableText implements Component {
	private lines: string[] | undefined;
	private readonly text: string;

	constructor(text: string) {
		this.text = text;
	}

	render(width: number): string[] {
		if (!this.lines) {
			this.lines = [this.text.padEnd(Math.min(width, this.text.length + 1))];
		}
		return this.lines;
	}

	invalidate(): void {}
}

describe("VirtualizedContainer", () => {
	it("re-renders only the tail slice on steady-state frames", () => {
		const container = new VirtualizedContainer(1);
		const cold: CountingText[] = [];
		for (let i = 0; i < 10; i++) {
			const child = new CountingText(`cold-${i}`);
			cold.push(child);
			container.addChild(child);
		}
		const hot = new CountingText("hot");
		container.addChild(hot);

		container.render(40);
		for (const child of cold) {
			assert.equal(child.renderCount, 1);
		}
		assert.equal(hot.renderCount, 1);

		hot.setText("hot-2");
		container.render(40);

		for (const child of cold) {
			assert.equal(child.renderCount, 1, "cold children should stay cached");
		}
		assert.equal(hot.renderCount, 2, "hot child re-renders each frame");
	});

	it("appending a child does not re-render settled children outside the hot zone", () => {
		const container = new VirtualizedContainer(5);
		const settled: CountingText[] = [];
		for (let i = 0; i < 10; i++) {
			const child = new CountingText(`item-${i}-xxx`);
			settled.push(child);
			container.addChild(child);
		}
		container.render(40);
		for (const child of settled) {
			child.renderCount = 0;
		}

		const appended = new CountingText("new-child");
		container.addChild(appended);
		container.render(40);

		// Only children inside the tail budget (near the end of the list) may
		// have been re-rendered; children well above the hot zone must stay at 0.
		for (let i = 0; i < 5; i++) {
			assert.equal(settled[i].renderCount, 0, `child ${i} outside the hot zone must not re-render on append`);
		}
		assert.equal(appended.renderCount, 1, "newly appended child renders exactly once");
	});

	it("produces byte-identical output to a fresh full render after interleaved appends", () => {
		const width = 30;
		const virtual = new VirtualizedContainer(4);
		const texts: string[] = [];

		for (let i = 0; i < 3; i++) {
			const t = `seed-${i}`;
			texts.push(t);
			virtual.addChild(new CountingText(t));
		}
		virtual.render(width);

		for (let i = 0; i < 6; i++) {
			const t = `appended-${i}`;
			texts.push(t);
			virtual.addChild(new CountingText(t));
			virtual.render(width);
		}

		const fresh = new VirtualizedContainer(4);
		for (const t of texts) {
			fresh.addChild(new CountingText(t));
		}
		const expected = fresh.render(width);

		assert.equal(virtual.render(width).join("\n"), expected.join("\n"));
	});

	it("returns a new array reference after an append", () => {
		const container = new VirtualizedContainer(5);
		for (let i = 0; i < 5; i++) {
			container.addChild(new CountingText(`item-${i}`));
		}
		const first = container.render(40);

		container.addChild(new CountingText("newcomer"));
		const second = container.render(40);

		assert.notStrictEqual(second, first, "append must produce a new flattened array");
	});

	it("still does a full rebuild when the width changes after appends", () => {
		const container = new VirtualizedContainer(3);
		const texts = ["one", "two", "three", "four", "five"];
		for (const t of texts) {
			container.addChild(new CountingText(t));
		}
		container.render(20);
		container.addChild(new CountingText("six"));
		container.render(20);

		const children = container.children as CountingText[];
		for (const child of children) {
			child.renderCount = 0;
		}

		const rendered = container.render(80);

		for (const child of children) {
			assert.equal(child.renderCount, 1, "width change must re-render every child");
		}

		const fresh = new VirtualizedContainer(3);
		for (const t of [...texts, "six"]) {
			fresh.addChild(new CountingText(t));
		}
		assert.deepEqual(rendered, fresh.render(80));
	});

	it("external mutation of children combined with growth does not corrupt output (cachedPrefixMatches forces rebuild)", () => {
		const container = new VirtualizedContainer(3);
		const texts = ["a", "b", "c", "d", "e"];
		for (const t of texts) {
			container.addChild(new CountingText(t));
		}
		container.render(30);

		// Directly replace a slot without going through removeChild/addChild,
		// then grow the array so the append fast-path's length check fires.
		// cachedPrefixMatches must notice the prefix no longer matches the
		// cached components and force a full rebuild instead of reusing stale
		// cached lines for the replaced slot.
		const replacement = new CountingText("REPLACED");
		container.children[0] = replacement;
		container.addChild(new CountingText("f"));

		const rendered = container.render(30);

		const fresh = new VirtualizedContainer(3);
		fresh.addChild(replacement);
		for (const t of [...texts.slice(1), "f"]) {
			fresh.addChild(new CountingText(t));
		}
		assert.deepEqual(rendered, fresh.render(30));
	});

	it("matches Container output for a static transcript", () => {
		const width = 60;
		const lines = ["alpha", "bravo", "charlie"];
		const virtual = new VirtualizedContainer();
		for (const line of lines) {
			virtual.addChild(new Text(line, 0, 0));
		}
		const expected: string[] = [];
		for (const line of lines) {
			expected.push(...new Text(line, 0, 0).render(width));
		}
		assert.deepEqual(virtual.render(width), expected);
	});

	it("re-renders all children after invalidate", () => {
		const container = new VirtualizedContainer(2);
		const a = new CountingText("a");
		const b = new CountingText("b");
		const c = new CountingText("c");
		container.addChild(a);
		container.addChild(b);
		container.addChild(c);

		container.render(20);
		container.invalidate();
		container.render(20);

		assert.equal(a.renderCount, 2);
		assert.equal(b.renderCount, 2);
		assert.equal(c.renderCount, 2);
	});

	it("removes a child from the flattened output after the first render", () => {
		const container = new VirtualizedContainer();
		const a = new StableText("a");
		const b = new StableText("b");
		const c = new StableText("c");
		container.addChild(a);
		container.addChild(b);
		container.addChild(c);

		assert.deepEqual(container.render(20), ["a ", "b ", "c "]);
		container.removeChild(b);

		assert.deepEqual(container.render(20), ["a ", "c "]);
	});
});
