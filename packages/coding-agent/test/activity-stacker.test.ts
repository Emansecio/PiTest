import type { Component, TUI } from "@pit/tui";
import { beforeAll, describe, expect, it, test } from "vitest";
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

function makeExec(overrides: Partial<ToolExecutionComponent>): ToolExecutionComponent {
	return {
		setActivityChild() {},
		setExpanded() {},
		getActivityState: () => "success",
		isAborted: () => false,
		getResultDetails: () => undefined,
		getArgs: () => ({}),
		render: () => [],
		...overrides,
	} as unknown as ToolExecutionComponent;
}

function navExec() {
	return makeExec({ getActivityFamily: () => "navigation", getToolName: () => "read" });
}
function actionExec() {
	return makeExec({ getActivityFamily: () => "action", getToolName: () => "edit" });
}
function askExec() {
	return makeExec({ getActivityFamily: () => "action", getToolName: () => "ask" });
}

describe("ActivityStacker", () => {
	beforeAll(() => initTheme("dark"));

	test("navigation calls fold into one group", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeCall(exec("read"));
		s.placeCall(exec("grep"));
		s.placeCall(exec("ls"));
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

	it("navigation folds into one group; an action breaks it into its own line", () => {
		const added: string[] = [];
		const ui = {
			requestRender() {},
			addAnimationCallback() {
				return () => {};
			},
		} as unknown as TUI;
		const stacker = new ActivityStacker(ui, (c) => added.push(c.constructor.name));
		stacker.placeCall(navExec());
		stacker.placeCall(navExec());
		stacker.placeCall(actionExec());
		stacker.placeCall(navExec());
		// A blank Spacer separates consecutive activity blocks (folded nav calls
		// stay tight inside their NavGroup).
		expect(added).toEqual(["NavGroupComponent", "Spacer", "ActivityLineComponent", "Spacer", "NavGroupComponent"]);
	});

	it("ask/resolve are not placed in the activity stream", () => {
		const added: string[] = [];
		const ui = {
			requestRender() {},
			addAnimationCallback() {
				return () => {};
			},
		} as unknown as TUI;
		const stacker = new ActivityStacker(ui, (c) => added.push(c.constructor.name));
		expect(stacker.placeCall(askExec())).toBe(false);
		expect(added).toEqual([]);
	});
});
