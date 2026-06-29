import { resetCapabilitiesCache, setCapabilities } from "@pit/tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActivityLineComponent } from "../src/modes/interactive/components/activity-line.ts";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => {
	initTheme("dark");
	// Pin capabilities: under a truecolor host (Windows Terminal sets
	// WT_SESSION) the icon ColorEase would arm against the fake TUI's no-op
	// animation callback and never settle, so the memoization paths under test
	// would never be reachable. Tests must not depend on the host terminal.
	setCapabilities({ images: null, trueColor: false, hyperlinks: false });
});
afterAll(() => resetCapabilitiesCache());

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
		setResultExpanded() {},
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
	it("auto-expands the exec body on a genuine error without full expand", () => {
		let resultExpanded = false;
		let fullyExpanded = false;
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(
			execStub({
				getActivityState: () => "error",
				isAborted: () => false,
				setExpanded: (v: boolean) => {
					fullyExpanded = v;
				},
				setResultExpanded: (v: boolean) => {
					resultExpanded = v;
				},
			}),
		);
		const out = c.render(120).map(stripAnsi);
		expect(out.some((l) => l.includes("<exec body>"))).toBe(true);
		expect(resultExpanded).toBe(true);
		expect(fullyExpanded).toBe(false);
	});
	it("caps the auto-shown error body and folds the rest into an expand hint", () => {
		const bodyLines = Array.from({ length: 25 }, (_, i) => `error line ${i + 1}`);
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(
			execStub({
				getActivityState: () => "error",
				isAborted: () => false,
				render: () => bodyLines,
			}),
		);
		const out = c.render(120).map(stripAnsi);
		// header + ERROR_PREVIEW_LINES + 1 hint line
		expect(out.length).toBe(1 + 10 + 1);
		expect(out.some((l) => l.includes("error line 10"))).toBe(true);
		expect(out.some((l) => l.includes("error line 11"))).toBe(false);
		expect(out[out.length - 1]).toContain("+15 more lines");
		expect(out[out.length - 1]).toContain("to expand");
	});
	it("renders the full error body when explicitly expanded", () => {
		const bodyLines = Array.from({ length: 25 }, (_, i) => `error line ${i + 1}`);
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(
			execStub({
				getActivityState: () => "error",
				isAborted: () => false,
				render: () => bodyLines,
			}),
		);
		c.setExpanded(true);
		const out = c.render(120).map(stripAnsi);
		expect(out.some((l) => l.includes("error line 25"))).toBe(true);
		expect(out.some((l) => l.includes("more lines"))).toBe(false);
	});
	it("folds identical repeated actions into a ×N counter", () => {
		const todoStub = () =>
			execStub({
				getToolName: () => "todo",
				getArgs: () => ({}),
				getResultDetails: () => undefined,
				render: () => [],
			});
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(todoStub());
		expect(c.render(120).map(stripAnsi)[0]).not.toContain("×");
		c.coalesce(todoStub());
		c.coalesce(todoStub());
		const out = c.render(120).map(stripAnsi);
		expect(out[0]).toContain("Updated todos");
		expect(out[0]).toContain("×3");
	});

	it("renders bash as `$ Ran <command>` without a redundant `$ ` sigil", () => {
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(
			execStub({
				getToolName: () => "bash",
				getArgs: () => ({ command: "npm test" }),
				getResultDetails: () => undefined,
			}),
		);
		const out = c.render(120).map(stripAnsi);
		// `$` family glyph + "Ran" verb, then the bare command (no second `$ `).
		expect(out[0]).toContain("Ran npm test");
		expect(out[0]).not.toContain("Ran $ npm test");
	});

	it("elides a leading `cd <path> &&` in the bash row", () => {
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(
			execStub({
				getToolName: () => "bash",
				getArgs: () => ({ command: "cd C:/PiTest && npm run check" }),
				getResultDetails: () => undefined,
			}),
		);
		const out = c.render(120).map(stripAnsi);
		expect(out[0]).toContain("Ran npm run check");
		expect(out[0]).not.toContain("cd ");
	});
});

function bashStub() {
	return execStub({
		getToolName: () => "bash",
		getArgs: () => ({ command: "npm test" }),
		getResultDetails: () => undefined,
	});
}

describe("ActivityLineComponent — edit preview", () => {
	it("auto-shows up to five diff lines on a settled edit without expanding", () => {
		const bodyLines = Array.from({ length: 12 }, (_, i) => `diff line ${i + 1}`);
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(
			execStub({
				getResultDetails: () => ({ diff: "+1 a\n-1 b" }),
				render: () => bodyLines,
			}),
		);
		const out = c.render(120).map(stripAnsi);
		expect(out[0]).toContain("Edited");
		expect(out.length).toBe(1 + 5 + 1);
		expect(out[1]).toContain("diff line 1");
		expect(out[5]).toContain("diff line 5");
		expect(out[6]).toContain("+7 more lines");
	});

	it("shows live diff body while an edit is still pending", () => {
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(
			execStub({
				getActivityState: () => "pending",
				render: () => ["+  1 streaming"],
			}),
		);
		const out = c.render(120).map(stripAnsi);
		expect(out[0]).toContain("Editing");
		expect(out.some((l) => l.includes("streaming"))).toBe(true);
	});

	it("accumulates diffstat across coalesced edits", () => {
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(execStub({ getResultDetails: () => ({ diff: "+  1 a\n-  2 b" }) }));
		c.coalesce(execStub({ getResultDetails: () => ({ diff: "+  3 c" }) }));
		const head = c.render(120).map(stripAnsi)[0];
		expect(head).toContain("×2");
		expect(head).toContain("+2");
		expect(head).toContain("-1");
	});
});

describe("ActivityLineComponent — settled-line memoization", () => {
	it("returns the same array instance across frames once settled and collapsed", () => {
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(bashStub());
		const first = c.render(120);
		const second = c.render(120);
		expect(second).toBe(first);
		expect(second.map(stripAnsi)[0]).toContain("Ran");
	});

	it("recomputes when the width changes", () => {
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(bashStub());
		const w120 = c.render(120);
		const w80 = c.render(80);
		expect(w80).not.toBe(w120);
		expect(c.render(80)).toBe(w80);
	});

	it("never serves the memo while pending (spinner is live)", () => {
		let state = "pending";
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(execStub({ getActivityState: () => state as "pending" | "success" }));
		const p1 = c.render(120);
		const p2 = c.render(120);
		// Each pending frame reassembles — the spinner glyph may change between
		// any two frames without any other state changing.
		expect(p2).not.toBe(p1);

		// Settling busts the line and the settled bytes are then memoized.
		state = "success";
		const s1 = c.render(120);
		expect(s1.map(stripAnsi)[0]).toContain("Edited");
		// Success with diff auto-preview keeps recomputing — no memo.
		expect(c.render(120)).not.toBe(s1);
	});

	it("setExpanded busts the memo and the body recomputes every frame", () => {
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(bashStub());
		const collapsed = c.render(120);
		expect(c.render(120)).toBe(collapsed);

		c.setExpanded(true);
		const e1 = c.render(120);
		expect(e1).not.toBe(collapsed);
		expect(e1.map(stripAnsi).some((l) => l.includes("<exec body>"))).toBe(true);
		// Expanded body may stream/animate → no memo while expanded.
		expect(c.render(120)).not.toBe(e1);

		c.setExpanded(false);
		const back = c.render(120);
		expect(back.map(stripAnsi)).toEqual(collapsed.map(stripAnsi));
	});

	it("invalidate() drops the memo and reassembles byte-identically", () => {
		const c = new ActivityLineComponent(fakeTui());
		c.setExec(
			execStub({
				getToolName: () => "bash",
				getArgs: () => ({ command: "npm test" }),
				getResultDetails: () => undefined,
				invalidate() {},
			}),
		);
		const first = c.render(120);
		c.invalidate();
		const second = c.render(120);
		expect(second).not.toBe(first);
		expect(second).toEqual(first);
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
