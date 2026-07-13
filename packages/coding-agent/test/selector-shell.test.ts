/**
 * Behavioral tests for the shared SelectorShell and the selectors migrated onto
 * it (theme / thinking). Covers card+list rendering, the two-step Esc semantics,
 * live filtering, the current-value ✓ marker, and digit quick-select.
 */

import { SelectList } from "@pit/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { SelectorShell } from "../src/modes/interactive/components/selector-shell.js";
import { ThemeSelectorComponent } from "../src/modes/interactive/components/theme-selector.js";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.js";
import { getAvailableThemes, getSelectListTheme, initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const ESC = "\x1b";

function makeList(values: string[]): SelectList {
	const items = values.map((v) => ({ value: v, label: v }));
	return new SelectList(items, 10, getSelectListTheme(), { emptyText: "No matching options" });
}

const plainRender = (component: { render: (w: number) => string[] }, width = 60): string =>
	component.render(width).map(stripAnsi).join("\n");

describe("SelectorShell", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders the rounded card frame around the list", () => {
		const shell = new SelectorShell(makeList(["alpha", "bravo", "charlie"]), {
			title: "Picker",
			onCancel: () => {},
		});
		const lines = shell.render(60).map(stripAnsi);
		const joined = lines.join("\n");
		expect(lines[0]).toMatch(/^╭─+╮$/);
		expect(lines[lines.length - 1]).toMatch(/^╰─+╯$/);
		expect(joined).toContain("Picker");
		expect(joined).toContain("alpha");
		expect(joined).toContain("bravo");
		expect(joined).toContain("charlie");
	});

	it("filters the list as the user types into the search box", () => {
		const shell = new SelectorShell(makeList(["alpha", "bravo", "charlie"]), {
			search: true,
			onCancel: () => {},
		});

		shell.handleInput("b");
		expect(shell.getSearchInput()?.getValue()).toBe("b");
		const joined = plainRender(shell);
		expect(joined).toContain("bravo");
		expect(joined).not.toContain("alpha");
		expect(joined).not.toContain("charlie");
	});

	it("uses a two-step Esc when searching: first clears the filter, then closes", () => {
		let cancelled = 0;
		const shell = new SelectorShell(makeList(["alpha", "bravo", "charlie"]), {
			search: true,
			onCancel: () => {
				cancelled++;
			},
		});

		shell.handleInput("b");
		expect(plainRender(shell)).not.toContain("alpha");

		// First Esc: clears the filter, does NOT close.
		shell.handleInput(ESC);
		expect(cancelled).toBe(0);
		expect(shell.getSearchInput()?.getValue()).toBe("");
		expect(plainRender(shell)).toContain("alpha");

		// Second Esc (empty filter): closes.
		shell.handleInput(ESC);
		expect(cancelled).toBe(1);
	});

	it("closes immediately on Esc when search is disabled", () => {
		let cancelled = 0;
		const shell = new SelectorShell(makeList(["alpha", "bravo"]), {
			search: false,
			onCancel: () => {
				cancelled++;
			},
		});

		shell.handleInput(ESC);
		expect(cancelled).toBe(1);
	});
});

describe("ThemeSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("marks the current theme with a green ✓", () => {
		const current = getAvailableThemes()[0];
		const selector = new ThemeSelectorComponent(
			current,
			() => {},
			() => {},
			() => {},
		);
		expect(plainRender(selector)).toContain("✓");
	});

	it("previews the highlighted theme while filtering", () => {
		const themes = getAvailableThemes();
		const previews: string[] = [];
		const selector = new ThemeSelectorComponent(
			themes[0],
			() => {},
			() => {},
			(name) => previews.push(name),
		);
		// Type the first character of some theme name to trigger a filter + preview.
		selector.handleInput(themes[0].charAt(0));
		expect(previews.length).toBeGreaterThan(0);
	});
});

describe("ThinkingSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("marks the current level with a green ✓", () => {
		const selector = new ThinkingSelectorComponent(
			"off",
			["off", "low", "high"] as never,
			() => {},
			() => {},
		);
		expect(plainRender(selector)).toContain("✓");
	});

	it("confirms the second level via digit quick-select ('2')", () => {
		let selected: string | undefined;
		const selector = new ThinkingSelectorComponent(
			"off",
			["off", "low", "high"] as never,
			(level) => {
				selected = level;
			},
			() => {},
		);
		selector.handleInput("2");
		expect(selected).toBe("low");
	});
});
