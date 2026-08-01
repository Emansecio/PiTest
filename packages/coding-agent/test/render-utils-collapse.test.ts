/**
 * `renderToolOutput` (render-utils.ts) must honor `options.expanded` and
 * collapse by default — the same safety net the TUI's no-custom-renderer
 * fallback already applies. Before this fix, `renderToolOutput` ignored
 * `options` entirely and always dumped the full (trimmed) output, so every
 * one of its ~12 adopters (recall, retain, reflect, forget, resolve, eval,
 * search_tool_bm25, recipe, inspect_image, render_mermaid,
 * recall_tool_output, goal_complete) flooded the TUI transcript and produced
 * an identical collapsed/expanded HTML export.
 */

import { Text } from "@pit/tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDeferredOutputStore, setCurrentDeferredOutputStore } from "../src/core/deferred-output-store.js";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.js";
import { createRecallToolOutputDefinition } from "../src/core/tools/recall-tool-output.js";
import { renderToolOutput } from "../src/core/tools/render-utils.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const CWD = process.cwd();

function renderContext() {
	return {
		lastComponent: undefined as unknown,
		showImages: false,
	};
}

function renderOutput(text: string, expanded: boolean): string {
	const component = renderToolOutput({ content: [{ type: "text", text }] }, { expanded }, theme, renderContext());
	return stripAnsi(component.render(120).join("\n"));
}

describe("renderToolOutput collapse", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("collapses a long multi-line result to a bounded preview with an expand hint", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
		const rendered = renderOutput(lines.join("\n"), false);
		const renderedLines = rendered.split("\n").filter((l) => l.length > 0);
		expect(renderedLines.length).toBeLessThan(20);
		expect(rendered).toContain("line 0");
		expect(rendered).not.toContain("line 199");
		expect(rendered).toMatch(/more lines/i);
	});

	it("shows the full result when expanded", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
		const rendered = renderOutput(lines.join("\n"), true);
		expect(rendered).toContain("line 0");
		expect(rendered).toContain("line 199");
		expect(rendered).not.toMatch(/more lines/i);
	});

	it("renders nothing for empty output", () => {
		const component = renderToolOutput({ content: [] }, { expanded: false }, theme, renderContext());
		expect(stripAnsi(component.render(120).join("\n")).trim()).toBe("");
	});

	it("reuses context.lastComponent instead of allocating a new component", () => {
		const existing = renderToolOutput(
			{ content: [{ type: "text", text: "hello" }] },
			{ expanded: false },
			theme,
			renderContext(),
		);
		const component = renderToolOutput(
			{ content: [{ type: "text", text: "hello again" }] },
			{ expanded: false },
			theme,
			{
				lastComponent: existing,
				showImages: false,
			},
		);
		expect(component).toBe(existing);
	});

	it("does not reuse a foreign Text as lastComponent (allocates its own component)", () => {
		const existing = new Text("", 0, 0);
		const component = renderToolOutput({ content: [{ type: "text", text: "hello" }] }, { expanded: false }, theme, {
			lastComponent: existing,
			showImages: false,
		});
		expect(component).not.toBe(existing);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("hello");
	});

	it("caps by VISUAL lines: a single 2000-char line cannot explode the collapsed preview after wrap", () => {
		const longLine = "x".repeat(2000);
		const rest = Array.from({ length: 30 }, (_, i) => `tail line ${String(i).padStart(2, "0")}`);
		const component = renderToolOutput(
			{ content: [{ type: "text", text: [longLine, ...rest].join("\n") }] },
			{ expanded: false },
			theme,
			renderContext(),
		);
		const lines = component.render(80);
		// Preview budget (15 visual rows) + optional leading blank + one trailer line.
		// Before the visual cap, the 2000-char logical line alone wrapped to ~25
		// visual rows at width 80, blowing way past the cap.
		expect(lines.length).toBeLessThanOrEqual(17);
		expect(stripAnsi(lines.join("\n"))).toMatch(/more lines/i);
		// Every emitted row fits the render width (no line wider than 80 cells).
		for (const line of lines) {
			expect(stripAnsi(line).length).toBeLessThanOrEqual(80);
		}
	});

	it("an errored result keeps the TAIL (the useful end) behind a leading earlier-lines trailer", () => {
		const lines = Array.from({ length: 40 }, (_, i) => `err line ${String(i).padStart(2, "0")}`);
		const component = renderToolOutput(
			{ content: [{ type: "text", text: lines.join("\n") }], isError: true },
			{ expanded: false },
			theme,
			{ ...renderContext(), isError: true },
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("err line 39"); // the end survives
		expect(rendered).not.toContain("err line 00"); // the preamble is what folds away
		expect(rendered).toMatch(/earlier lines/i);
		// The trailer leads (hidden lines are ABOVE the kept tail), same dialect as
		// capErrorPreview in tool-activity.ts.
		const renderedLines = component.render(120).map((l) => stripAnsi(l));
		const trailerIdx = renderedLines.findIndex((l) => /earlier lines/i.test(l));
		const tailIdx = renderedLines.findIndex((l) => l.includes("err line 39"));
		expect(trailerIdx).toBeGreaterThanOrEqual(0);
		expect(trailerIdx).toBeLessThan(tailIdx);
	});

	it("a NON-error result still keeps the HEAD when collapsed", () => {
		const lines = Array.from({ length: 40 }, (_, i) => `ok line ${String(i).padStart(2, "0")}`);
		const component = renderToolOutput(
			{ content: [{ type: "text", text: lines.join("\n") }] },
			{ expanded: false },
			theme,
			renderContext(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("ok line 00");
		expect(rendered).not.toContain("ok line 39");
		expect(rendered).toMatch(/more lines/i);
	});
});

describe("recall_tool_output renders collapsed by default", () => {
	afterEach(() => {
		setCurrentDeferredOutputStore(undefined);
	});

	it("a 256KB deferred output renders as a bounded collapsed preview, not a full dump", async () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		const bigOutput = Array.from({ length: 20000 }, (_, i) => `deferred line ${i}`).join("\n");
		expect(Buffer.byteLength(bigOutput, "utf-8")).toBeGreaterThan(256 * 1024 - 4096);
		const id = store.put(bigOutput);

		const def = createRecallToolOutputDefinition(CWD);
		const result = (await def.execute("tc1", { id }, undefined, undefined, undefined as any)) as any;
		expect(result.isError).toBeFalsy();

		const renderResult = def.renderResult;
		expect(renderResult).toBeTruthy();
		const component = renderResult!(result, { expanded: false, isPartial: false }, theme, {
			args: { id },
			toolCallId: "tc1",
			invalidate: () => {},
			lastComponent: undefined,
			state: {},
			cwd: CWD,
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
			activityChild: false,
		} as any);
		const rendered = stripAnsi(component.render(120).join("\n"));
		const renderedLines = rendered.split("\n").filter((l) => l.length > 0);
		expect(renderedLines.length).toBeLessThanOrEqual(16);
		store.dispose();
	});
});

describe("export HTML renders distinct collapsed/expanded output for renderToolOutput tools", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("collapsed differs from expanded for a long result, and each is internally consistent", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
		const tool = {
			name: "custom_long",
			label: "custom_long",
			description: "custom",
			renderResult: renderToolOutput,
		} as any;
		const renderer = createToolHtmlRenderer({
			getToolDefinition: () => tool,
			theme,
			cwd: CWD,
		});
		const rendered = renderer.renderResult(
			"id1",
			"custom_long",
			[{ type: "text", text: lines.join("\n") }],
			undefined,
			false,
		);
		expect(rendered).toBeTruthy();
		expect(rendered!.expanded).toContain("line 199");
		expect(rendered!.collapsed).toBeTruthy();
		expect(rendered!.collapsed).not.toContain("line 199");
		expect(rendered!.collapsed).not.toBe(rendered!.expanded);
	});

	it("short output has no separate collapsed field (collapsed === expanded)", () => {
		const tool = {
			name: "custom_short",
			label: "custom_short",
			description: "custom",
			renderResult: renderToolOutput,
		} as any;
		const renderer = createToolHtmlRenderer({
			getToolDefinition: () => tool,
			theme,
			cwd: CWD,
		});
		const rendered = renderer.renderResult(
			"id2",
			"custom_short",
			[{ type: "text", text: "one\ntwo\nthree" }],
			undefined,
			false,
		);
		expect(rendered).toBeTruthy();
		expect(rendered!.expanded).toContain("one");
		expect(rendered!.collapsed).toBeUndefined();
	});
});
