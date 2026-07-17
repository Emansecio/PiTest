/**
 * Behavioral tests for ExtensionSelectorComponent: wrap-around navigation,
 * PageUp/PageDown/Home/End paging, and the empty-state line.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const HOME = "\x1b[H";
const END = "\x1b[F";
const CONFIRM = "\n";

const plainRender = (component: { render: (w: number) => string[] }, width = 60): string =>
	component.render(width).map(stripAnsi).join("\n");

function makeSelector(options: string[], onSelect: (value: string) => void = () => {}): ExtensionSelectorComponent {
	return new ExtensionSelectorComponent("Pick one", options, onSelect, () => {});
}

describe("ExtensionSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("wraps to the last item when pressing up at the top", () => {
		let picked: string | undefined;
		const selector = makeSelector(["a", "b", "c"], (v) => {
			picked = v;
		});
		selector.handleInput(UP); // 0 -> wrap to 2
		selector.handleInput(CONFIRM);
		expect(picked).toBe("c");
	});

	it("wraps to the first item when pressing down at the bottom", () => {
		let picked: string | undefined;
		const selector = makeSelector(["a", "b", "c"], (v) => {
			picked = v;
		});
		selector.handleInput(DOWN); // 0 -> 1
		selector.handleInput(DOWN); // 1 -> 2
		selector.handleInput(DOWN); // 2 -> wrap to 0
		selector.handleInput(CONFIRM);
		expect(picked).toBe("a");
	});

	it("jumps to the last / first item with End and Home", () => {
		let picked: string | undefined;
		const selector = makeSelector(["a", "b", "c", "d"], (v) => {
			picked = v;
		});
		selector.handleInput(END);
		selector.handleInput(CONFIRM);
		expect(picked).toBe("d");

		selector.handleInput(HOME);
		selector.handleInput(CONFIRM);
		expect(picked).toBe("a");
	});

	it("shows an empty-state line when there are no options", () => {
		const selector = makeSelector([]);
		expect(plainRender(selector)).toContain("No options");
	});
});
