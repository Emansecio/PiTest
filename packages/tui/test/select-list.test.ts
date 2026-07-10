import assert from "node:assert";
import { describe, it } from "node:test";
import { SelectList } from "../src/components/select-list.js";
import { visibleWidth } from "../src/utils.js";

const testTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

const visibleIndexOf = (line: string, text: string): number => {
	const index = line.indexOf(text);
	assert.notEqual(index, -1);
	return visibleWidth(line.slice(0, index));
};

describe("SelectList", () => {
	it("normalizes multiline descriptions to single line", () => {
		const items = [
			{
				value: "test",
				label: "test",
				description: "Line one\nLine two\nLine three",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(100);

		assert.ok(rendered.length > 0);
		assert.ok(!rendered[0].includes("\n"));
		assert.ok(rendered[0].includes("Line one Line two Line three"));
	});

	it("keeps descriptions aligned when the primary text is truncated", () => {
		const items = [
			{ value: "short", label: "short", description: "short description" },
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "long description",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "short description"), visibleIndexOf(rendered[1], "long description"));
	});

	it("uses the configured minimum primary column width", () => {
		const items = [
			{ value: "a", label: "a", description: "first" },
			{ value: "bb", label: "bb", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(rendered[0].indexOf("first"), 14);
		assert.equal(rendered[1].indexOf("second"), 14);
	});

	it("uses the configured maximum primary column width", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "first"), 22);
		assert.equal(visibleIndexOf(rendered[1], "second"), 22);
	});

	it("fuzzy-filters items (non-contiguous characters match)", () => {
		const items = [
			{ value: "aXbXc", label: "aXbXc" },
			{ value: "zzz", label: "zzz" },
			{ value: "abc", label: "abc" },
		];

		const list = new SelectList(items, 10, testTheme);
		list.setFilter("abc");

		// Both "abc" (exact) and "aXbXc" (subsequence) match; "zzz" does not.
		// Exact match ranks first.
		assert.strictEqual(list.getSelectedItem()?.value, "abc");

		const rendered = list.render(80).map((l) => l.trim());
		assert.ok(
			rendered.some((l) => l.includes("abc")),
			"abc should be visible",
		);
		assert.ok(
			rendered.some((l) => l.includes("aXbXc")),
			"aXbXc should be visible (fuzzy subsequence match)",
		);
		assert.ok(!rendered.some((l) => l.includes("zzz")), "zzz should be filtered out");
	});

	it("restores original order for an empty filter", () => {
		const items = [
			{ value: "one", label: "one" },
			{ value: "two", label: "two" },
			{ value: "three", label: "three" },
		];

		const list = new SelectList(items, 10, testTheme);
		list.setFilter("t");
		list.setFilter("");

		// First item is the original first item, in original order.
		assert.strictEqual(list.getSelectedItem()?.value, "one");
		const rendered = list.render(80).map((l) => l.trim());
		assert.ok(rendered.some((l) => l.includes("one")));
		assert.ok(rendered.some((l) => l.includes("two")));
		assert.ok(rendered.some((l) => l.includes("three")));
	});

	it("shows ↑ and ↓ scroll arrows alongside the count when items overflow", () => {
		const items = Array.from({ length: 10 }, (_, i) => ({ value: `item-${i}`, label: `item-${i}` }));

		const list = new SelectList(items, 3, testTheme);

		// At the top: only a down arrow (nothing above the window).
		let rendered = list.render(80);
		let scrollLine = rendered.find((l) => l.includes("(1/10)"));
		assert.ok(scrollLine, "scroll info line should be present");
		assert.ok(scrollLine.includes("↓"), "down arrow expected at top");
		assert.ok(!scrollLine.includes("↑"), "no up arrow at top");

		// Move to the middle: both arrows present.
		list.setSelectedIndex(5);
		rendered = list.render(80);
		scrollLine = rendered.find((l) => l.includes("(6/10)"));
		assert.ok(scrollLine, "scroll info line should be present in the middle");
		assert.ok(scrollLine.includes("↑"), "up arrow expected in the middle");
		assert.ok(scrollLine.includes("↓"), "down arrow expected in the middle");

		// Move to the bottom: only an up arrow.
		list.setSelectedIndex(9);
		rendered = list.render(80);
		scrollLine = rendered.find((l) => l.includes("(10/10)"));
		assert.ok(scrollLine, "scroll info line should be present at bottom");
		assert.ok(scrollLine.includes("↑"), "up arrow expected at bottom");
		assert.ok(!scrollLine.includes("↓"), "no down arrow at bottom");
	});

	it("allows overriding primary truncation while preserving description alignment", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 12,
			truncatePrimary: ({ text, maxWidth }) => {
				if (text.length <= maxWidth) {
					return text;
				}

				return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
			},
		});
		const rendered = list.render(80);

		assert.ok(rendered[0].includes("…"));
		assert.equal(visibleIndexOf(rendered[0], "first"), visibleIndexOf(rendered[1], "second"));
	});

	it("pads the selected row and applies selectedBg when provided", () => {
		const items = [
			{ value: "one", label: "one" },
			{ value: "two", label: "two" },
		];
		const marker = "\x1b[48;2;1;2;3m";
		const themeWithBg = {
			...testTheme,
			selectedBg: (text: string) => `${marker}${text}\x1b[49m`,
		};

		const list = new SelectList(items, 5, themeWithBg);
		const rendered = list.render(40);
		const selected = rendered[0];

		assert.ok(selected.includes(marker), "selected row should use selectedBg");
		assert.equal(visibleWidth(selected.replace(/\x1b\[[0-9;]*m/g, "")), 40);
		assert.ok(!rendered[1].includes(marker), "unselected row should not use selectedBg");
	});
});
