import type { TUI } from "@pit/tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { WorkGroupComponent } from "../src/modes/interactive/components/work-group.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

function fakeTui(): TUI {
	return { requestRender: () => {}, addAnimationCallback: () => () => {} } as unknown as TUI;
}

function makeExec(o: Partial<ToolExecutionComponent>): ToolExecutionComponent {
	return {
		setActivityChild() {},
		setExpanded() {},
		setResultExpanded() {},
		dispose() {},
		invalidate() {},
		getActivityState: () => "success",
		isAborted: () => false,
		getResultDetails: () => undefined,
		getArgs: () => ({}),
		getActivityFamily: () => "navigation",
		getToolName: () => "read",
		render: () => [],
		...o,
	} as unknown as ToolExecutionComponent;
}
const nav = (tool = "read") => makeExec({ getActivityFamily: () => "navigation", getToolName: () => tool });
const bash = (command = "ls") =>
	makeExec({ getActivityFamily: () => "action", getToolName: () => "bash", getArgs: () => ({ command }) });
const edit = (path = "a.ts") =>
	makeExec({ getActivityFamily: () => "action", getToolName: () => "edit", getArgs: () => ({ path }) });
const plan = () => makeExec({ getActivityFamily: () => "action", getToolName: () => "plan", getArgs: () => ({}) });
const task = (name: string) =>
	makeExec({ getActivityFamily: () => "action", getToolName: () => "task", getArgs: () => ({ name }) });

describe("WorkGroupComponent", () => {
	beforeAll(() => initTheme("dark"));

	it("folds navigation + bash into one dense cross-family counter", () => {
		const g = new WorkGroupComponent(fakeTui());
		g.addCall(nav("read"));
		g.addCall(nav("grep"));
		g.addCall(bash("npm test"));
		const header = stripAnsi(g.render(120)[0]!);
		expect(header).toContain("1 file");
		expect(header).toContain("1 search");
		expect(header).toContain("1 command");
		// Dense separator, no lateral padding.
		expect(header).not.toContain(" · ");
	});

	it("promotes an edit to its own line instead of the counter", () => {
		const g = new WorkGroupComponent(fakeTui());
		g.addCall(nav("read"));
		g.addCall(edit("compaction.ts"));
		const lines = g.render(120).map(stripAnsi);
		expect(lines[0]).toContain("1 file");
		expect(lines.some((l) => l.includes("Edited") && l.includes("compaction.ts"))).toBe(true);
	});

	it("coalesces repeated plan updates into one ×N promoted row", () => {
		const g = new WorkGroupComponent(fakeTui());
		g.addCall(plan());
		g.addCall(plan());
		g.addCall(plan());
		const joined = g.render(120).map(stripAnsi).join("\n");
		expect(joined).toContain("×3");
	});

	it("collapses a sealed phase to one summary line reabsorbing promoted calls", () => {
		const g = new WorkGroupComponent(fakeTui());
		g.addCall(nav("read"));
		g.addCall(nav("grep"));
		g.addCall(edit("a.ts"));
		g.addCall(edit("b.ts"));
		g.addCall(task("auth"));
		g.seal();
		const lines = g.render(120).map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("2 edits");
		expect(lines[0]).toContain("1 agent");
	});

	it("re-expands a sealed phase back to its live layout via setExpanded", () => {
		const g = new WorkGroupComponent(fakeTui());
		g.addCall(nav("read"));
		g.addCall(edit("a.ts"));
		g.seal();
		expect(g.render(120).map(stripAnsi)).toHaveLength(1); // collapsed to one summary
		g.setExpanded(true);
		const lines = g.render(120).map(stripAnsi);
		expect(lines.some((l) => l.includes("Edited") && l.includes("a.ts"))).toBe(true);
	});

	it("keeps a genuine counted error as header-only when collapsed (body via expand)", () => {
		const g = new WorkGroupComponent(fakeTui());
		g.addCall(nav("read"));
		g.addCall(
			makeExec({
				getActivityFamily: () => "action",
				getToolName: () => "bash",
				getArgs: () => ({ command: "npm test" }),
				getActivityState: () => "error",
				isAborted: () => false,
				setResultExpanded() {},
				render: () => ["boom: build failed"],
			}),
		);
		g.seal();
		const collapsed = g.render(120).map(stripAnsi);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("✗");
		expect(collapsed[0]).toContain("command");
		expect(collapsed.join("\n")).not.toContain("boom: build failed");
		g.setExpanded(true);
		expect(g.render(120).map(stripAnsi).join("\n")).toContain("boom: build failed");
	});

	it("caps settled promoted lines live and folds the rest into the header", () => {
		const g = new WorkGroupComponent(fakeTui());
		g.addCall(edit("a.ts"));
		g.addCall(edit("b.ts"));
		g.addCall(edit("c.ts"));
		g.addCall(edit("d.ts"));
		const lines = g.render(120).map(stripAnsi);
		const edited = lines.filter((l) => l.includes("Edited"));
		expect(edited.length).toBeLessThanOrEqual(2);
		expect(lines[0]).toMatch(/\d+ edits?/);
	});

	it("is empty until it holds a call", () => {
		const g = new WorkGroupComponent(fakeTui());
		expect(g.isEmpty()).toBe(true);
		expect(g.render(120)).toEqual([]);
		g.addCall(nav("read"));
		expect(g.isEmpty()).toBe(false);
	});

	it("expandLastChild opens only the newest promoted body", () => {
		const g = new WorkGroupComponent(fakeTui());
		const bodies: string[][] = [];
		g.addCall(
			makeExec({
				getActivityFamily: () => "action",
				getToolName: () => "edit",
				getArgs: () => ({ path: "a.ts" }),
				getActivityState: () => "success",
				setExpanded(expanded: boolean) {
					if (expanded) bodies.push(["diff-a"]);
				},
				render: () => ["diff-a"],
			}),
		);
		g.addCall(
			makeExec({
				getActivityFamily: () => "action",
				getToolName: () => "edit",
				getArgs: () => ({ path: "b.ts" }),
				getActivityState: () => "success",
				setExpanded(expanded: boolean) {
					if (expanded) bodies.push(["diff-b"]);
				},
				render: () => ["diff-b"],
			}),
		);
		g.seal();
		g.expandLastChild();
		expect(g.isLastChildExpanded()).toBe(true);
		const joined = g.render(120).map(stripAnsi).join("\n");
		expect(joined).toContain("diff-b");
		expect(joined).not.toContain("diff-a");
	});
});
