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
});
