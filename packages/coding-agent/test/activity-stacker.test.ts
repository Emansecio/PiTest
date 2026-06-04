import type { Component, TUI } from "@pit/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { ActivityStacker } from "../src/modes/interactive/activity-stacker.js";
import { ActivityLineComponent } from "../src/modes/interactive/components/activity-line.js";
import { NavGroupComponent } from "../src/modes/interactive/components/nav-group.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function fakeTui(): TUI {
	return { requestRender: () => {}, addAnimationCallback: () => () => {} } as unknown as TUI;
}

function exec(name: string): ToolExecutionComponent {
	return new ToolExecutionComponent(name, name, {}, {}, undefined, fakeTui(), process.cwd());
}

describe("ActivityStacker", () => {
	beforeAll(() => initTheme("dark"));

	test("contiguous navigation calls land in one NavGroup", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeNavigation(exec("read"));
		s.placeNavigation(exec("grep"));
		expect(added.length).toBe(1);
		expect(added[0]).toBeInstanceOf(NavGroupComponent);
	});

	test("an action closes the open NavGroup and starts its own line", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeNavigation(exec("read"));
		s.placeAction(exec("edit"));
		s.placeNavigation(exec("ls"));
		expect(added.length).toBe(3); // nav-group, action-line, NEW nav-group
		expect(added[0]).toBeInstanceOf(NavGroupComponent);
		expect(added[1]).toBeInstanceOf(ActivityLineComponent);
		expect(added[2]).toBeInstanceOf(NavGroupComponent);
		expect(added[2]).not.toBe(added[0]);
	});

	test("divide() closes the burst so the next nav opens a fresh group", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeNavigation(exec("read"));
		s.divide();
		s.placeNavigation(exec("grep"));
		expect(added.length).toBe(2);
		expect(added[0]).not.toBe(added[1]);
	});

	test("reset() also closes the burst", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeNavigation(exec("read"));
		s.reset();
		s.placeNavigation(exec("grep"));
		expect(added.length).toBe(2);
	});
});
