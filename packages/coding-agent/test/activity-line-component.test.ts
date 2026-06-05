import { beforeAll, describe, expect, it } from "vitest";
import { ActivityLineComponent } from "../src/modes/interactive/components/activity-line.ts";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
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

function execStub(over: Partial<ToolExecutionComponent>): ToolExecutionComponent {
	return {
		setActivityChild() {},
		setExpanded() {},
		getActivityState: () => "success",
		isAborted: () => false,
		getToolName: () => "edit",
		getArgs: () => ({ path: "server/foo.ts" }),
		getResultDetails: () => ({ diff: "+  1 a\n-  2 b\n-  3 c" }),
		render: () => ["<exec body>"],
		...over,
	} as unknown as ToolExecutionComponent;
}

describe("ActivityLineComponent", () => {
	it("renders a verb-led header with target and diffstat, no gutter", () => {
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(execStub({}));
		const out = c.render(120).map(stripAnsi);
		expect(out[0]).toContain("Edited");
		expect(out[0]).toContain("server/foo.ts");
		expect(out[0]).toContain("+1");
		expect(out[0]).toContain("-2");
		for (const l of out) expect(l).not.toContain("│");
	});
	it("renders bash as Ran $ command", () => {
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(
			execStub({
				getToolName: () => "bash",
				getArgs: () => ({ command: "npm test" }),
				getResultDetails: () => undefined,
			}),
		);
		const out = c.render(120).map(stripAnsi);
		expect(out[0]).toContain("Ran");
		expect(out[0]).toContain("$ npm test");
	});
	it("auto-expands the exec body on a genuine error", () => {
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(execStub({ getActivityState: () => "error", isAborted: () => false }));
		const out = c.render(120).map(stripAnsi);
		expect(out.some((l) => l.includes("<exec body>"))).toBe(true);
	});
});
