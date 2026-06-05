import { beforeAll, describe, expect, it } from "vitest";
import { ActivityLineComponent } from "../src/modes/interactive/components/activity-line.ts";
import { NavGroupComponent } from "../src/modes/interactive/components/nav-group.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

function fakeTui() {
	return {
		requestRender() {},
		addAnimationCallback() {
			return () => {};
		},
	} as any;
}

function navExec(name: string): ToolExecutionComponent {
	const e = new ToolExecutionComponent(name, "1", {}, {}, undefined, fakeTui(), process.cwd());
	e.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
	return e;
}

function editExecStub(): ToolExecutionComponent {
	return {
		setActivityChild() {},
		setExpanded() {},
		getActivityState: () => "success",
		isAborted: () => false,
		getToolName: () => "edit",
		getArgs: () => ({ path: "a.ts" }),
		getResultDetails: () => ({ diff: "+  1 x" }),
		render: () => [],
	} as unknown as ToolExecutionComponent;
}

describe("activity spacing invariant", () => {
	it("NavGroup emits no leading or trailing blank line", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(navExec("read"));
		const lines = g.render(120).map(stripAnsi);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines[0].trim()).not.toBe("");
		expect(lines[lines.length - 1].trim()).not.toBe("");
	});

	it("ActivityLine emits no leading or trailing blank line", () => {
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(editExecStub());
		const lines = c.render(120).map(stripAnsi);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines[0].trim()).not.toBe("");
		expect(lines[lines.length - 1].trim()).not.toBe("");
	});
});
