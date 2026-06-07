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

describe("ActivityLineComponent — agent labels", () => {
	const taskExec = (args: Record<string, unknown>) =>
		execStub({ getToolName: () => "task", getArgs: () => args, getResultDetails: () => undefined });

	it("labels a task agent with its delegated name", () => {
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(taskExec({ name: "find-dead-code", prompt: "Find unused exports" }), 1);
		const head = c.render(120).map(stripAnsi)[0];
		expect(head).toContain("find-dead-code");
		expect(head).not.toContain("Ran");
	});

	it("derives a label from the prompt when no name is given", () => {
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(taskExec({ prompt: "Refactor the auth module" }), 1);
		expect(c.render(120).map(stripAnsi)[0]).toContain("Refactor the auth module");
	});

	it("truncates a long derived prompt label", () => {
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(taskExec({ prompt: "x".repeat(120) }), 1);
		const head = c.render(120).map(stripAnsi)[0];
		expect(head).toContain("…");
		expect(head.length).toBeLessThan(60);
	});

	it("falls back to a per-turn 'Agent N' when neither name nor prompt help", () => {
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(taskExec({}), 3);
		expect(c.render(120).map(stripAnsi)[0]).toContain("Agent 3");
	});

	it("labels an unknown/MCP action with the tool name, not a bare 'Ran'", () => {
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(
			execStub({ getToolName: () => "some_mcp_tool", getArgs: () => ({}), getResultDetails: () => undefined }),
		);
		const head = c.render(120).map(stripAnsi)[0];
		expect(head).toContain("some_mcp_tool");
		expect(head).not.toContain("Ran");
	});
});
