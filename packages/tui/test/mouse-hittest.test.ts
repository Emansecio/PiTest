/**
 * Hit-test for Container / VirtualizedContainer: mapping a local row to the child
 * that rendered it via the per-child offset caches render() maintains.
 *
 * The three offset-write paths (mirroring perf-flatten.test.ts) each get covered:
 *   1. full rebuild   (first render / child-count change)
 *   2. prefix-reuse    with only the LAST child changing
 *   3. prefix-reuse    with a MIDDLE child changing
 * plus the stale-cache guard: a child added since the last render (offsets no
 * longer in lockstep with the child list) must yield null, never a wrong child.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Component, Container } from "../src/tui.js";
import { VirtualizedContainer } from "../src/virtualized-container.js";

/**
 * Component that renders a fixed block of lines. Reallocates its output array on
 * setBlock (mirrors Text/Markdown memoization: a new reference signals a change),
 * so a Container/VirtualizedContainer treats it as changed only when reallocated.
 */
class Block implements Component {
	private out: string[];
	constructor(id: string, lineCount: number) {
		this.out = Block.build(id, lineCount);
	}
	private static build(id: string, n: number): string[] {
		return Array.from({ length: n }, (_, i) => `${id}:${i}`);
	}
	setBlock(id: string, n: number): void {
		this.out = Block.build(id, n);
	}
	render(): string[] {
		return this.out;
	}
	invalidate(): void {}
}

/** Assert hitTestChild(row) resolves to the expected child + childStart. */
function assertHit(
	container: Container | VirtualizedContainer,
	row: number,
	child: Component,
	childStart: number,
): void {
	const hit = container.hitTestChild(row);
	assert.ok(hit, `expected a hit at row ${row}, got null`);
	assert.strictEqual(hit.child, child, `wrong child at row ${row}`);
	assert.equal(hit.childStart, childStart, `wrong childStart at row ${row}`);
}

describe("Container.hitTestChild", () => {
	it("resolves every row after a full rebuild (first render)", () => {
		const a = new Block("A", 2);
		const b = new Block("B", 3);
		const c = new Block("C", 2);
		const container = new Container();
		for (const child of [a, b, c]) container.addChild(child);

		container.render(40); // offsets: A@0, B@2, C@5, total 7

		assertHit(container, 0, a, 0);
		assertHit(container, 1, a, 0);
		assertHit(container, 2, b, 2);
		assertHit(container, 4, b, 2);
		assertHit(container, 5, c, 5);
		assertHit(container, 6, c, 5);
		assert.equal(container.hitTestChild(7), null, "row past content is null");
		assert.equal(container.hitTestChild(-1), null, "negative row is null");
	});

	it("stays correct after the LAST child changes (prefix-reuse path)", () => {
		const a = new Block("A", 2);
		const b = new Block("B", 3);
		const c = new Block("C", 2);
		const container = new Container();
		for (const child of [a, b, c]) container.addChild(child);
		container.render(40);

		// Last child grows 2 -> 3 lines: sameShape holds, minChangedIndex = 2, so
		// render() takes the prefix-reuse branch and recomputes offsets from C.
		c.setBlock("C2", 3);
		container.render(40); // offsets: A@0, B@2, C@5, total 8

		assertHit(container, 1, a, 0);
		assertHit(container, 4, b, 2);
		assertHit(container, 5, c, 5);
		assertHit(container, 7, c, 5);
		assert.equal(container.hitTestChild(8), null);
	});

	it("stays correct after a MIDDLE child changes (prefix-reuse path)", () => {
		const a = new Block("A", 2);
		const b = new Block("B", 3);
		const c = new Block("C", 2);
		const container = new Container();
		for (const child of [a, b, c]) container.addChild(child);
		container.render(40);

		// Middle child shrinks 3 -> 1 line: minChangedIndex = 1, prefix-reuse from B.
		b.setBlock("B2", 1);
		container.render(40); // offsets: A@0, B@2, C@3, total 5 (2+1+2)

		assertHit(container, 0, a, 0);
		assertHit(container, 1, a, 0);
		assertHit(container, 2, b, 2);
		assertHit(container, 3, c, 3);
		assertHit(container, 4, c, 3);
		assert.equal(container.hitTestChild(5), null);
	});

	it("returns null when the offset cache is stale (child added since last render)", () => {
		const a = new Block("A", 2);
		const container = new Container();
		container.addChild(a);
		container.render(40);
		assertHit(container, 1, a, 0);

		// A child added but not yet rendered: flattenCacheChildOutputs.length no
		// longer equals children.length, so the offsets can't be trusted.
		const b = new Block("B", 2);
		container.addChild(b);
		assert.equal(container.hitTestChild(0), null, "stale cache must refuse rather than index a wrong child");
	});

	it("returns null before the first render", () => {
		const container = new Container();
		container.addChild(new Block("A", 1));
		assert.equal(container.hitTestChild(0), null);
	});
});

describe("VirtualizedContainer.hitTestChild", () => {
	it("resolves every row after a full rebuild (first render)", () => {
		const a = new Block("A", 2);
		const b = new Block("B", 3);
		const c = new Block("C", 2);
		const container = new VirtualizedContainer();
		for (const child of [a, b, c]) container.addChild(child);

		container.render(40); // offsets: A@0, B@2, C@5

		assertHit(container, 0, a, 0);
		assertHit(container, 2, b, 2);
		assertHit(container, 4, b, 2);
		assertHit(container, 5, c, 5);
		assertHit(container, 6, c, 5);
		assert.equal(container.hitTestChild(7), null);
		assert.equal(container.hitTestChild(-1), null);
	});

	it("stays correct after the LAST child changes (flattenFromIndex path)", () => {
		const a = new Block("A", 2);
		const b = new Block("B", 3);
		const c = new Block("C", 2);
		const container = new VirtualizedContainer();
		for (const child of [a, b, c]) container.addChild(child);
		container.render(40);

		c.setBlock("C2", 3);
		container.render(40); // offsets: A@0, B@2, C@5, total 8

		assertHit(container, 4, b, 2);
		assertHit(container, 5, c, 5);
		assertHit(container, 7, c, 5);
		assert.equal(container.hitTestChild(8), null);
	});

	it("stays correct after a MIDDLE child changes (flattenFromIndex path)", () => {
		const a = new Block("A", 2);
		const b = new Block("B", 3);
		const c = new Block("C", 2);
		const container = new VirtualizedContainer();
		for (const child of [a, b, c]) container.addChild(child);
		container.render(40);

		b.setBlock("B2", 1);
		container.render(40); // offsets: A@0, B@2, C@3, total 5 (2+1+2)

		assertHit(container, 1, a, 0);
		assertHit(container, 2, b, 2);
		assertHit(container, 3, c, 3);
		assertHit(container, 4, c, 3);
		assert.equal(container.hitTestChild(5), null);
	});

	it("returns null when the offset cache is stale (child added since last render)", () => {
		const a = new Block("A", 2);
		const container = new VirtualizedContainer();
		container.addChild(a);
		container.render(40);
		assertHit(container, 1, a, 0);

		container.addChild(new Block("B", 2));
		assert.equal(container.hitTestChild(0), null);
	});
});
