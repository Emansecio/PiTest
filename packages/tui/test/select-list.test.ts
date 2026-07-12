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

// Legacy (non-Kitty) escape sequences understood by matchesKey; the test runner
// leaves Kitty protocol inactive, so these drive handleInput directly.
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";

// The SelectList only exposes the selected item, so recover the numeric index
// from the "item-<n>" fixtures used by the navigation tests.
const indexOf = (list: SelectList): number => {
	const value = list.getSelectedItem()?.value ?? "";
	const match = value.match(/item-(\d+)/);
	return match ? Number(match[1]) : -1;
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

	it("shows the default empty-state text when nothing matches", () => {
		const items = [
			{ value: "one", label: "one" },
			{ value: "two", label: "two" },
		];
		const list = new SelectList(items, 5, testTheme);
		list.setFilter("zzz-no-such-item");

		const rendered = list.render(80);
		assert.equal(rendered.length, 1);
		assert.equal(rendered[0], "  No matches");
	});

	it("renders an overridden empty-state text with the shared two-space indent", () => {
		const items = [{ value: "one", label: "one" }];
		const list = new SelectList(items, 5, testTheme, { emptyText: "No matching commands" });
		list.setFilter("zzz-no-such-item");

		const rendered = list.render(80);
		assert.equal(rendered.length, 1);
		assert.equal(rendered[0], "  No matching commands");
	});

	it("pages the selection by maxVisible and clamps without wrapping", () => {
		const items = Array.from({ length: 10 }, (_, i) => ({ value: `item-${i}`, label: `item-${i}` }));
		const list = new SelectList(items, 3, testTheme);
		list.onSelectionChange = () => {};

		// Down from top pages by 3.
		list.handleInput(PAGE_DOWN);
		assert.equal(indexOf(list), 3);
		list.handleInput(PAGE_DOWN);
		assert.equal(indexOf(list), 6);
		list.handleInput(PAGE_DOWN);
		assert.equal(indexOf(list), 9);
		// At the bottom it clamps rather than wrapping to the top.
		list.handleInput(PAGE_DOWN);
		assert.equal(indexOf(list), 9);

		// Up pages by 3 and clamps at the top.
		list.handleInput(PAGE_UP);
		assert.equal(indexOf(list), 6);
		list.handleInput(PAGE_UP);
		assert.equal(indexOf(list), 3);
		list.handleInput(PAGE_UP);
		assert.equal(indexOf(list), 0);
		list.handleInput(PAGE_UP);
		assert.equal(indexOf(list), 0);
	});

	it("fires onSelectionChange while paging", () => {
		const items = Array.from({ length: 10 }, (_, i) => ({ value: `item-${i}`, label: `item-${i}` }));
		const list = new SelectList(items, 3, testTheme);
		let last: string | undefined;
		list.onSelectionChange = (item) => {
			last = item.value;
		};

		list.handleInput(PAGE_DOWN);
		assert.equal(last, "item-3");
		list.handleInput(HOME);
		assert.equal(last, "item-0");
		list.handleInput(END);
		assert.equal(last, "item-9");
	});

	it("jumps to the first and last item with Home/End", () => {
		const items = Array.from({ length: 6 }, (_, i) => ({ value: `item-${i}`, label: `item-${i}` }));
		const list = new SelectList(items, 3, testTheme);

		list.handleInput(END);
		assert.equal(indexOf(list), 5);
		list.handleInput(HOME);
		assert.equal(indexOf(list), 0);
	});

	it("digitSelect jumps to and confirms item N", () => {
		const items = [
			{ value: "alpha", label: "alpha" },
			{ value: "bravo", label: "bravo" },
			{ value: "charlie", label: "charlie" },
		];
		const list = new SelectList(items, 5, testTheme, { digitSelect: true });
		const confirmed: string[] = [];
		list.onSelect = (item) => confirmed.push(item.value);

		list.handleInput("2");
		assert.deepEqual(confirmed, ["bravo"]);
		assert.equal(list.getSelectedItem()?.value, "bravo");
	});

	it("digitSelect is inert when the list has more than 9 items", () => {
		const items = Array.from({ length: 12 }, (_, i) => ({ value: `item-${i}`, label: `item-${i}` }));
		const list = new SelectList(items, 5, testTheme, { digitSelect: true });
		let confirmed = false;
		list.onSelect = () => {
			confirmed = true;
		};

		list.handleInput("3");
		assert.equal(confirmed, false);
		assert.equal(indexOf(list), 0);

		// And no ordinal prefixes are drawn in the >9 case.
		const rendered = list.render(80);
		assert.ok(
			!rendered.some((l) => /^\s*\d\s/.test(l.replace(/^→\s*/, ""))),
			"ordinals should not render with more than 9 items",
		);
	});

	it("renders dim ordinal prefixes only when digitSelect is enabled and list is short", () => {
		const items = [
			{ value: "one", label: "one" },
			{ value: "two", label: "two" },
			{ value: "three", label: "three" },
		];

		const withDigits = new SelectList(items, 5, testTheme, { digitSelect: true }).render(80);
		// Selected row 0 gets ordinal 1, row 1 gets ordinal 2, etc.
		assert.equal(withDigits[0], "→ 1 one");
		assert.equal(withDigits[1], "  2 two");
		assert.equal(withDigits[2], "  3 three");

		const withoutDigits = new SelectList(items, 5, testTheme).render(80);
		assert.equal(withoutDigits[0], "→ one");
		assert.equal(withoutDigits[1], "  two");
		assert.equal(withoutDigits[2], "  three");
	});

	it("renders a plain 3-item list unchanged (backward compatibility)", () => {
		const items = [
			{ value: "one", label: "one" },
			{ value: "two", label: "two" },
			{ value: "three", label: "three" },
		];
		const rendered = new SelectList(items, 5, testTheme).render(80);
		assert.deepEqual(rendered, ["→ one", "  two", "  three"]);
	});

	it("setMaxVisible clamps to a floor of 3 and resizes the visible window", () => {
		const items = Array.from({ length: 10 }, (_, i) => ({ value: `item-${i}`, label: `item-${i}` }));
		const list = new SelectList(items, 5, testTheme);

		// Grow the window: 8 item rows plus one scroll line.
		list.setMaxVisible(8);
		let rendered = list.render(80);
		assert.equal(rendered.filter((l) => l.includes("item-")).length, 8);

		// Clamp below the floor: still 3 item rows plus one scroll line.
		list.setMaxVisible(1);
		rendered = list.render(80);
		assert.equal(rendered.filter((l) => l.includes("item-")).length, 3);
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
