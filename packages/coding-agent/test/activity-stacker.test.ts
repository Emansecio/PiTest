import type { Component, TUI } from "@pit/tui";
import { beforeAll, describe, expect, it, test } from "vitest";
import { ActivityStacker } from "../src/modes/interactive/activity-stacker.js";
import { ActivityLineComponent } from "../src/modes/interactive/components/activity-line.js";
import { BashGroupComponent } from "../src/modes/interactive/components/bash-group.js";
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
function todoExec() {
	return makeExec({ getActivityFamily: () => "action", getToolName: () => "todo", getArgs: () => ({}) });
}
function taskExec() {
	return makeExec({ getActivityFamily: () => "action", getToolName: () => "task", getArgs: () => ({}) });
}
function bashExec(command: string) {
	return makeExec({
		getActivityFamily: () => "action",
		getToolName: () => "bash",
		getArgs: () => ({ command }),
	});
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
		// Activity blocks stack tight — no Spacer between them (folded nav calls also
		// stay tight inside their NavGroup). Breathing room comes from agent text.
		expect(added).toEqual(["NavGroupComponent", "ActivityLineComponent", "NavGroupComponent"]);
	});

	it("folds identical consecutive actions into one line (×N)", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeCall(todoExec());
		s.placeCall(todoExec());
		s.placeCall(todoExec());
		expect(added.length).toBe(1);
		expect(added[0]).toBeInstanceOf(ActivityLineComponent);
	});

	it("does not fold actions separated by a navigation call", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeCall(todoExec());
		s.placeCall(navExec());
		s.placeCall(todoExec());
		expect(added.map((c) => c.constructor.name)).toEqual([
			"ActivityLineComponent",
			"NavGroupComponent",
			"ActivityLineComponent",
		]);
	});

	it("does not fold actions separated by agent text (divide)", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeCall(todoExec());
		s.divide();
		s.placeCall(todoExec());
		expect(added.length).toBe(2);
		expect(added[0]).not.toBe(added[1]);
	});

	it("never folds task agents — each gets its own line", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeCall(taskExec());
		s.placeCall(taskExec());
		expect(added.filter((c) => c instanceof ActivityLineComponent).length).toBe(2);
	});

	it("consecutive bash calls fold into one BashGroup", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeCall(bashExec("git status"));
		s.placeCall(bashExec("grep foo ."));
		s.placeCall(bashExec("npm test"));
		expect(added.length).toBe(1);
		expect(added[0]).toBeInstanceOf(BashGroupComponent);
	});

	it("keeps failed grouped bash output hidden until explicitly expanded", () => {
		const group = new BashGroupComponent(fakeTui());
		group.addCall(
			makeExec({
				getToolName: () => "bash",
				getArgs: () => ({ command: "echo broken" }),
				getActivityState: () => "error",
				isAborted: () => false,
				setResultExpanded() {},
				render: () => ["command failed"],
			}),
		);

		expect(group.render(120)).toHaveLength(1);
		group.setExpanded(true);
		expect(group.render(120).some((line) => line.includes("command failed"))).toBe(true);
	});

	it("a non-bash action closes the open BashGroup", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeCall(bashExec("git status"));
		s.placeCall(actionExec());
		s.placeCall(bashExec("npm test"));
		expect(added.map((c) => c.constructor.name)).toEqual([
			"BashGroupComponent",
			"ActivityLineComponent",
			"BashGroupComponent",
		]);
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
