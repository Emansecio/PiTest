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

	it("reuses context.lastComponent instead of allocating a new Text node", () => {
		const existing = new Text("", 0, 0);
		const component = renderToolOutput({ content: [{ type: "text", text: "hello" }] }, { expanded: false }, theme, {
			lastComponent: existing,
			showImages: false,
		});
		expect(component).toBe(existing);
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
