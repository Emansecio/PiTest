import { join, resolve } from "node:path";
import { Text, type TUI } from "@pit/tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import { getReadmePath } from "../src/config.js";
import type { ToolDefinition } from "../src/core/extensions/types.js";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.js";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.js";
import { createTodoToolDefinition } from "../src/core/tools/todo.js";
import { createWriteToolDefinition } from "../src/core/tools/write.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
		// No-op ticker: tool-gutter animation (P4 spinner / P5 fade) is not exercised
		// by these parity tests, but the component subscribes via this on the TUI.
		addAnimationCallback: () => () => {},
	} as unknown as TUI;
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: Array<{ type: string; text?: string }>; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bread\b/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "notes.txt" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("falls back when custom renderers are absent", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom_tool");
		expect(rendered).toContain("done");
	});

	test("renders write calls compactly until expanded", () => {
		const content = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n";
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("write");
		expect(collapsed).toContain("README.md");
		expect(collapsed).not.toContain("one");
		expect(collapsed).not.toContain("eleven");
		expect(collapsed).not.toContain("more lines");
		expect(collapsed).not.toContain("to expand");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("one");
		expect(expanded).toContain("eleven");
		expect(expanded).not.toContain("eleven\n\n");
		expect(expanded).not.toContain("more lines");
	});

	test("collapses task subagent result to a single preview line", () => {
		const component = new ToolExecutionComponent(
			"task",
			"tool-task-1",
			{ name: "finder", prompt: "find things" },
			{},
			createBaseToolDefinition("task"),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "first line\nsecond line\nthird line\nfourth line" }],
				details: {},
				isError: false,
			},
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("first line");
		expect(collapsed).not.toContain("second line");
		expect(collapsed).toContain("3 more lines");
		expect(collapsed).toContain("to expand");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("first line");
		expect(expanded).toContain("fourth line");
		expect(expanded).not.toContain("more lines");
	});

	test("non-task fallback tools keep the multi-line preview", () => {
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-fallback-multi",
			{ foo: "bar" },
			{},
			createBaseToolDefinition("custom_tool"),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "alpha\nbeta\ngamma" }], details: {}, isError: false },
			false,
		);
		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("alpha");
		expect(collapsed).toContain("beta");
		expect(collapsed).toContain("gamma");
		expect(collapsed).not.toContain("more lines");
	});

	test("todo result sits directly under the call with no blank line", () => {
		const component = new ToolExecutionComponent(
			"todo",
			"tool-todo-1",
			{ action: "create", subject: "do the thing" },
			{},
			createTodoToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "Created #1: do the thing" }],
				details: { action: "create", tasks: [] },
				isError: false,
			},
			false,
		);
		const renderedLines = stripAnsi(component.render(120).join("\n")).split("\n");
		const headerIdx = renderedLines.findIndex((l) => l.includes("todo") && l.includes("create"));
		const resultIdx = renderedLines.findIndex((l) => l.includes("Created #1"));
		expect(headerIdx).toBeGreaterThanOrEqual(0);
		expect(resultIdx).toBe(headerIdx + 1);
	});

	test("trims trailing blank display lines from read results", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	for (const scenario of [
		{
			title: "SKILL.md",
			path: join(process.cwd(), "attio", "SKILL.md"),
			content: "---\nname: attio\ndescription: CRM helper\n---\n\n# Hidden skill instructions",
			compact: "[skill] attio",
			hidden: "Hidden skill instructions",
			absent: "read skill attio",
		},
		{
			title: "AGENTS.md",
			path: join(process.cwd(), ".pit", "AGENTS.md"),
			content: "Hidden resource instructions",
			compact: "read resource .pit/AGENTS.md",
			hidden: "Hidden resource instructions",
			absent: undefined,
		},
		{
			title: "outside AGENTS.md",
			path: resolve(process.cwd(), "..", "AGENTS.md"),
			content: "Hidden outside resource instructions",
			compact: `read resource ${resolve(process.cwd(), "..", "AGENTS.md").replace(/\\/g, "/")}`,
			hidden: "Hidden outside resource instructions",
			absent: undefined,
		},
		{
			title: "Pi documentation",
			path: getReadmePath(),
			content: "Hidden docs content",
			compact: "read docs README.md",
			hidden: "Hidden docs content",
			absent: undefined,
		},
	] as const) {
		test(`renders ${scenario.title} read results compactly until expanded`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-${scenario.title}`,
				{ path: scenario.path },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: scenario.content }], details: undefined, isError: false },
				false,
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed).not.toContain(scenario.hidden);
			if (scenario.absent) {
				expect(collapsed).not.toContain(scenario.absent);
			}

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(120).join("\n"));
			expect(expanded).toContain(scenario.hidden);
		});
	}

	for (const scenario of [
		{ title: "SKILL.md", path: join(process.cwd(), "attio", "SKILL.md"), compact: "[skill] attio:120-329" },
		{ title: "Pi documentation", path: getReadmePath(), compact: "read docs README.md:120-329" },
	] as const) {
		test(`shows the read line range in compact ${scenario.title} reads before the expand hint`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-range-${scenario.title}`,
				{ path: scenario.path, offset: 120, limit: 210 },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed.indexOf(":120-329")).toBeLessThan(collapsed.indexOf("to expand"));
		});
	}

	test("renders generic file read results compactly until expanded", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-compact-generic-file",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "hidden body" }], details: undefined, isError: false },
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("read notes.txt");
		expect(collapsed).toContain("to expand");
		expect(collapsed).not.toContain("hidden body");
		// "file" is an internal kind, never surface it.
		expect(collapsed).not.toContain("read file");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("hidden body");
	});

	test("keeps generic file read errors visible while collapsed", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-compact-generic-error",
			{ path: "missing.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "ENOENT: no such file" }], details: undefined, isError: true },
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("ENOENT: no such file");
	});

	test("folds bash failure with empty output into a single muted footer line", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-fold-empty",
			{ command: "dir missing\\path" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{
				content: [{ type: "text", text: "(no output)\n\nCommand exited with code 2" }],
				details: undefined,
				isError: true,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		// Verbatim "Command exited with code 2" must be peeled off the body;
		// the chip surfaces it instead.
		expect(rendered).not.toContain("Command exited with code 2");
		expect(rendered).toContain("(no output)");
		expect(rendered).toContain("exit 2");
		expect(rendered).toMatch(/\(no output\) · exit 2 · Took \d+\.\ds/);
	});

	test("collapses output but appends exit chip to Took line on bash failure", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-fold-output",
			{ command: "node missing.js" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{
				content: [{ type: "text", text: "Error: Cannot find module 'missing.js'\n\nCommand exited with code 1" }],
				details: undefined,
				isError: true,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		// Body is collapsed behind the inline hint; raw error text only surfaces on expand.
		expect(rendered).not.toContain("Error: Cannot find module 'missing.js'");
		expect(rendered).toContain("earlier lines");
		expect(rendered).not.toContain("Command exited with code 1");
		expect(rendered).toMatch(/Took \d+\.\ds · exit 1|exit 1 · Took/);
	});

	test("surfaces aborted and timed-out bash status as muted chip", () => {
		const aborted = new ToolExecutionComponent(
			"bash",
			"tool-bash-fold-aborted",
			{ command: "sleep 10" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		aborted.markExecutionStarted();
		aborted.updateResult(
			{ content: [{ type: "text", text: "(no output)\n\nCommand aborted" }], details: undefined, isError: true },
			false,
		);
		const abortedOut = stripAnsi(aborted.render(120).join("\n"));
		expect(abortedOut).not.toContain("Command aborted");
		expect(abortedOut).toContain("aborted");

		const timedOut = new ToolExecutionComponent(
			"bash",
			"tool-bash-fold-timeout",
			{ command: "sleep 60", timeout: 5 },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		timedOut.markExecutionStarted();
		timedOut.updateResult(
			{
				content: [{ type: "text", text: "(no output)\n\nCommand timed out after 5 seconds" }],
				details: undefined,
				isError: true,
			},
			false,
		);
		const timedOutTxt = stripAnsi(timedOut.render(120).join("\n"));
		expect(timedOutTxt).not.toContain("Command timed out after 5 seconds");
		expect(timedOutTxt).toContain("timed out 5s");
	});

	test("drops the duration footer for a fast successful bash command", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-success",
			{ command: "echo hi" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "hi" }], details: undefined, isError: false }, false);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("hi");
		// Fast + successful + no warnings → `Took Xs` is noise and is suppressed.
		expect(rendered).not.toMatch(/Took \d+\.\ds/);
		expect(rendered).not.toContain("exit ");
		expect(rendered).not.toContain("·");
	});

	test("rides the collapsed-output hint on the command line and previews only the tail", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-collapsed",
			{ command: "seq 8" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{ content: [{ type: "text", text: "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8" }], details: undefined, isError: false },
			false,
		);

		const lines = stripAnsi(component.render(120).join("\n")).split("\n");
		// Hint shares the command line (8 lines, preview keeps 0 → all 8 hidden).
		const commandLine = lines.find((l) => l.includes("$ seq 8"));
		expect(commandLine).toBeDefined();
		expect(commandLine).toContain("8 earlier lines");
		expect(commandLine).toContain("to expand");
		// No tail preview; output lines are not rendered inline.
		// (Each rendered line carries the message-shell gutter prefix, so match the tail.)
		expect(lines.some((l) => l.trimEnd().endsWith("l8"))).toBe(false);
		expect(lines.some((l) => l.trimEnd().endsWith("l7"))).toBe(false);
		expect(lines.some((l) => l.trimEnd().endsWith("l1"))).toBe(false);
	});

	test("footer hugs the command header with no orphan blank line when output is collapsed", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-footer-hug",
			{ command: "node missing.js" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{
				content: [{ type: "text", text: "l1\nl2\nl3\nl4\nl5\nl6\n\nCommand exited with code 1" }],
				details: undefined,
				isError: true,
			},
			false,
		);

		const lines = stripAnsi(component.render(120).join("\n")).split("\n");
		const commandIdx = lines.findIndex((l) => l.includes("$ node missing.js"));
		const footerIdx = lines.findIndex((l) => /Took \d+\.\ds/.test(l));
		expect(commandIdx).toBeGreaterThanOrEqual(0);
		expect(footerIdx).toBeGreaterThan(commandIdx);
		// Output is fully collapsed (BASH_PREVIEW_LINES === 0); the muted footer must
		// hug the command line — no orphan blank line between command and footer.
		const blankBetween = lines.slice(commandIdx + 1, footerIdx).filter((l) => l.trim() === "");
		expect(blankBetween).toHaveLength(0);
	});

	test("clamps a long single-line command to one visual row with an expand hint", () => {
		const longCommand = `grep -rIn "github" --exclude-dir=.git --exclude-dir=.claude . | grep -v "CHANGELOG.md" | grep -v "/tests/" | grep -v "/docs/" | wc -l`;
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-longcmd",
			{ command: longCommand },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();

		const width = 80;
		const lines = stripAnsi(component.render(width).join("\n")).split("\n");
		// Collapsed: the command occupies exactly one visual row (no word-wrap).
		const commandRows = lines.filter((l) => l.includes("$ grep"));
		expect(commandRows.length).toBe(1);
		expect(commandRows[0].length).toBeLessThanOrEqual(width);
		// Truncated horizontally → ellipsis + bare expand affordance, no line count.
		expect(commandRows[0]).toContain("…");
		expect(commandRows[0]).toContain("to expand");
		expect(commandRows[0]).not.toContain("earlier lines");
		// The tail of the command (clipped off) is not visible anywhere.
		expect(lines.some((l) => l.includes("wc -l"))).toBe(false);

		// Expanded shows the full command (may wrap across rows).
		component.setExpanded(true);
		const full = stripAnsi(component.render(width).join("\n"));
		expect(full).toContain("wc -l");
	});

	test("clamps a multi-line command to one row and folds extra lines into the hint", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-multiline",
			{ command: "line1\nline2\nline3\nline4" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();

		const lines = stripAnsi(component.render(120).join("\n")).split("\n");
		// Only the first command line is shown, on a single visual row.
		const commandRows = lines.filter((l) => l.includes("$ line1"));
		expect(commandRows.length).toBe(1);
		// 3 extra command lines hidden → "3 earlier lines".
		expect(commandRows[0]).toContain("3 earlier lines");
		expect(commandRows[0]).toContain("to expand");
		expect(lines.some((l) => l.includes("line2"))).toBe(false);
	});
});
