import type { Component, TUI } from "@pit/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { ActivityStacker } from "../src/modes/interactive/activity-stacker.js";
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

	test("all calls fold into one group (navigation and action alike)", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeCall(exec("read"));
		s.placeCall(exec("edit"));
		s.placeCall(exec("bash"));
		expect(added.length).toBe(1);
		expect(added[0]).toBeInstanceOf(NavGroupComponent);
	});

	test("divide() closes the group so the next call opens a fresh one", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeCall(exec("read"));
		s.divide();
		s.placeCall(exec("grep"));
		expect(added.length).toBe(2);
		expect(added[0]).not.toBe(added[1]);
	});

	test("reset() also closes the group", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeCall(exec("read"));
		s.reset();
		s.placeCall(exec("grep"));
		expect(added.length).toBe(2);
	});
});
