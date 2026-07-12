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

	constructor(private readonly text: string) {}

	render(width: number): string[] {
		if (!this.lines) {
			this.lines = [this.text.padEnd(Math.min(width, this.text.length + 1))];
		}
		return this.lines;
	}
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
