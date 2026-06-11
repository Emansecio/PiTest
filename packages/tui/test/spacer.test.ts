import assert from "node:assert";
import { describe, it } from "node:test";
import { Spacer } from "../src/components/spacer.js";

describe("Spacer render memoization", () => {
	it("renders the requested number of empty lines", () => {
		assert.deepStrictEqual(new Spacer().render(80), [""]);
		assert.deepStrictEqual(new Spacer(3).render(80), ["", "", ""]);
		assert.deepStrictEqual(new Spacer(0).render(80), []);
	});

	it("returns the same array instance across frames when unchanged", () => {
		const spacer = new Spacer(2);
		const first = spacer.render(80);
		// Width is irrelevant to a spacer — identity must hold across widths too.
		assert.strictEqual(spacer.render(80), first);
		assert.strictEqual(spacer.render(40), first);
	});

	it("reallocates when the line count changes (parents key on identity)", () => {
		const spacer = new Spacer(1);
		const first = spacer.render(80);
		spacer.setLines(2);
		const second = spacer.render(80);
		assert.notStrictEqual(second, first);
		assert.deepStrictEqual(second, ["", ""]);
		// The previously returned array was not mutated.
		assert.deepStrictEqual(first, [""]);
	});

	it("keeps the cached instance when setLines is a no-op", () => {
		const spacer = new Spacer(2);
		const first = spacer.render(80);
		spacer.setLines(2);
		assert.strictEqual(spacer.render(80), first);
	});

	it("reallocates on invalidate() so parents see a fresh reference", () => {
		const spacer = new Spacer(2);
		const first = spacer.render(80);
		spacer.invalidate();
		const second = spacer.render(80);
		assert.notStrictEqual(second, first);
		assert.deepStrictEqual(second, first);
	});
});
