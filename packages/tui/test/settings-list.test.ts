import assert from "node:assert";
import { describe, it } from "node:test";
import { type SettingItem, SettingsList, type SettingsListTheme } from "../src/components/settings-list.js";

const testTheme: SettingsListTheme = {
	label: (text: string) => text,
	value: (text: string) => text,
	description: (text: string) => text,
	cursor: "→ ",
	hint: (text: string) => text,
};

function makeItems(n: number): SettingItem[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `item-${i}`,
		label: `item-${i}`,
		currentValue: `val-${i}`,
	}));
}

describe("SettingsList", () => {
	it("shows ↑ and ↓ scroll arrows alongside the count when items overflow", () => {
		const list = new SettingsList(
			makeItems(10),
			3,
			testTheme,
			() => {},
			() => {},
		);

		// At the top: only a down arrow (nothing above the window).
		let rendered = list.render(80);
		let scrollLine = rendered.find((l) => l.includes("(1/10)"));
		assert.ok(scrollLine, "scroll info line should be present");
		assert.ok(scrollLine.includes("↓"), "down arrow expected at top");
		assert.ok(!scrollLine.includes("↑"), "no up arrow at top");

		// Move to the middle: both arrows present.
		for (let i = 0; i < 5; i++) list.handleInput("\x1b[B");
		rendered = list.render(80);
		scrollLine = rendered.find((l) => l.includes("(6/10)"));
		assert.ok(scrollLine, "scroll info line should be present in the middle");
		assert.ok(scrollLine.includes("↑"), "up arrow expected in the middle");
		assert.ok(scrollLine.includes("↓"), "down arrow expected in the middle");

		// Move to the bottom: only an up arrow.
		for (let i = 0; i < 4; i++) list.handleInput("\x1b[B");
		rendered = list.render(80);
		scrollLine = rendered.find((l) => l.includes("(10/10)"));
		assert.ok(scrollLine, "scroll info line should be present at bottom");
		assert.ok(scrollLine.includes("↑"), "up arrow expected at bottom");
		assert.ok(!scrollLine.includes("↓"), "no down arrow at bottom");
	});

	it("supports PageDown/PageUp/Home/End paging (clamped, no wrap)", () => {
		const list = new SettingsList(
			makeItems(20),
			5,
			testTheme,
			() => {},
			() => {},
		);

		const posLine = (): string | undefined => list.render(80).find((l) => /\(\d+\/20\)/.test(l));

		// PageDown jumps by maxVisible (5): 1 -> 6.
		list.handleInput("\x1b[6~");
		assert.ok(posLine()?.includes("(6/20)"), "PageDown should jump one window down");

		// End jumps to the last item; PageDown at the bottom is clamped (no wrap).
		list.handleInput("\x1b[F");
		assert.ok(posLine()?.includes("(20/20)"), "End should jump to the last item");
		list.handleInput("\x1b[6~");
		assert.ok(posLine()?.includes("(20/20)"), "PageDown at bottom stays clamped");

		// Home jumps to the first; PageUp at the top is clamped (no wrap).
		list.handleInput("\x1b[H");
		assert.ok(posLine()?.includes("(1/20)"), "Home should jump to the first item");
		list.handleInput("\x1b[5~");
		assert.ok(posLine()?.includes("(1/20)"), "PageUp at top stays clamped");
	});

	it("renders a section header per contiguous group", () => {
		const items: SettingItem[] = [
			{ id: "a", label: "a", group: "Appearance", currentValue: "1" },
			{ id: "b", label: "b", group: "Appearance", currentValue: "2" },
			{ id: "c", label: "c", group: "Behavior", currentValue: "3" },
		];
		const list = new SettingsList(
			items,
			10,
			testTheme,
			() => {},
			() => {},
		);
		const rendered = list.render(80);
		const joined = rendered.join("\n");
		assert.ok(joined.includes("Appearance"), "Appearance header should render");
		assert.ok(joined.includes("Behavior"), "Behavior header should render");
		// Only one Appearance header despite two items in the group.
		assert.equal(rendered.filter((l) => l.includes("Appearance")).length, 1, "one header per group");
	});

	it("uses a two-step Esc when searching: first clears the filter, second cancels", () => {
		let cancelled = 0;
		const list = new SettingsList(
			[
				{ id: "alpha", label: "alpha", currentValue: "1" },
				{ id: "bravo", label: "bravo", currentValue: "2" },
			],
			10,
			testTheme,
			() => {},
			() => {
				cancelled++;
			},
			{ enableSearch: true },
		);

		list.handleInput("b");
		assert.ok(!list.render(80).join("\n").includes("alpha"), "filter should hide alpha");

		// First Esc clears the filter (alpha reappears), does NOT cancel.
		list.handleInput("\x1b");
		assert.equal(cancelled, 0, "first Esc should not cancel");
		assert.ok(list.render(80).join("\n").includes("alpha"), "filter cleared, alpha back");

		// Second Esc (empty filter) cancels.
		list.handleInput("\x1b");
		assert.equal(cancelled, 1, "second Esc should cancel");
	});

	it("keeps spaces in the search query (multi-word filters work) and does not cycle values", () => {
		let changes = 0;
		const list = new SettingsList(
			[
				{ id: "ab", label: "alpha beta", currentValue: "x", values: ["x", "y"] },
				{ id: "gd", label: "gamma delta", currentValue: "x", values: ["x", "y"] },
			],
			10,
			testTheme,
			() => {
				changes++;
			},
			() => {},
			{ enableSearch: true },
		);

		// Reordered multi-word query: only works if the space survives and splits
		// into two tokens ("beta"+"alpha"). If spaces were stripped to "betaalpha"
		// the query would match nothing.
		for (const ch of "beta alpha") list.handleInput(ch);
		const joined = list.render(80).join("\n");
		assert.ok(joined.includes("alpha beta"), "reordered multi-word query still matches its item");
		assert.ok(!joined.includes("gamma delta"), "non-matching item is filtered out");
		assert.equal(changes, 0, "space must type into search, never cycle a value");
	});

	it("cycles the selected value on Space only when search is disabled", () => {
		const changed: string[] = [];
		const list = new SettingsList(
			[{ id: "toggle", label: "toggle", currentValue: "off", values: ["off", "on"] }],
			10,
			testTheme,
			(_id, v) => {
				changed.push(v);
			},
			() => {},
		);
		list.handleInput(" ");
		assert.deepEqual(changed, ["on"], "Space cycles the value when search is off");
	});
});
