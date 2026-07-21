import type { Component, TUI } from "@pit/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { ActivityStacker } from "../src/modes/interactive/activity-stacker.js";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { WorkGroupComponent } from "../src/modes/interactive/components/work-group.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function fakeTui(): TUI {
	return { requestRender: () => {}, addAnimationCallback: () => () => {} } as unknown as TUI;
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
	return makeExec({ getActivityFamily: () => "action", getToolName: () => "edit", getArgs: () => ({ path: "a.ts" }) });
}
function askExec() {
	return makeExec({ getActivityFamily: () => "action", getToolName: () => "ask" });
}
function bashExec(command: string) {
	return makeExec({ getActivityFamily: () => "action", getToolName: () => "bash", getArgs: () => ({ command }) });
}

describe("ActivityStacker", () => {
	beforeAll(() => initTheme("dark"));

	it("folds a whole burst — nav, bash, action, nav — into ONE work phase", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeCall(navExec());
		s.placeCall(bashExec("ls"));
		s.placeCall(actionExec());
		s.placeCall(navExec());
		expect(added).toHaveLength(1);
		expect(added[0]).toBeInstanceOf(WorkGroupComponent);
	});

	it("an action in the middle no longer fragments the phase into a separate block", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeCall(navExec());
		s.placeCall(navExec());
		s.placeCall(actionExec());
		s.placeCall(navExec());
		expect(added.filter((c) => c instanceof WorkGroupComponent)).toHaveLength(1);
	});

	it("divide() seals the phase; the next call opens a fresh one after a spacer", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeCall(navExec());
		s.divide();
		s.placeCall(navExec());
		expect(added.map((c) => c.constructor.name)).toEqual(["WorkGroupComponent", "Spacer", "WorkGroupComponent"]);
	});

	it("reset() also seals and opens a fresh phase (no leading spacer)", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeCall(navExec());
		s.reset();
		s.placeCall(navExec());
		expect(added.map((c) => c.constructor.name)).toEqual(["WorkGroupComponent", "WorkGroupComponent"]);
	});

	it("ask/resolve are turn exchanges — not placed in the activity stream", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		expect(s.placeCall(askExec())).toBe(false);
		expect(added).toEqual([]);
	});

	it("ask/resolve seal an open phase so the next call opens a fresh one", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeCall(navExec());
		expect(s.placeCall(askExec())).toBe(false);
		s.placeCall(navExec());
		expect(added.filter((c) => c instanceof WorkGroupComponent)).toHaveLength(2);
	});
});
