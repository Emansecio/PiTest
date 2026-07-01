import assert from "node:assert";
import { describe, it } from "node:test";
import { Card } from "../src/components/card.js";
import { Text } from "../src/components/text.js";
import { visibleWidth } from "../src/utils.js";

describe("Card", () => {
	it("renders a rounded frame with padded content at 60 and 140 cols", () => {
		for (const width of [60, 140]) {
			const card = new Card(1, 0);
			card.addChild(new Text("hello"));
			const lines = card.render(width);
			assert.ok(lines.length >= 3);
			assert.strictEqual(visibleWidth(lines[0]!), width);
			assert.match(lines[0]!, /^╭─+╮$/);
			assert.match(lines[lines.length - 1]!, /^╰─+╯$/);
			for (let i = 1; i < lines.length - 1; i++) {
				assert.strictEqual(visibleWidth(lines[i]!), width);
				assert.match(lines[i]!, /^│.+│$/);
			}
		}
	});

	it("memoizes output for the same width until invalidate()", () => {
		const card = new Card();
		card.addChild(new Text("x"));
		const first = card.render(40);
		assert.strictEqual(card.render(40), first);
		card.invalidate();
		assert.notStrictEqual(card.render(40), first);
	});

	it("returns top and bottom only when empty", () => {
		const lines = new Card().render(20);
		assert.deepStrictEqual(lines.length, 2);
		assert.match(lines[0]!, /^╭─+╮$/);
		assert.match(lines[1]!, /^╰─+╯$/);
	});

	it("never exceeds viewport width at narrow widths", () => {
		for (const width of [0, 1, 2]) {
			const card = new Card(1, 0);
			card.addChild(new Text("x"));
			const lines = card.render(width);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= Math.max(0, width));
			}
		}
	});
});
