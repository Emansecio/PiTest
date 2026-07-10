/**
 * Test that BashExecutionComponent's collapsed output respects the render-time width,
 * not a stale captured width. Regression test for #2569.
 */
import { visibleWidth } from "@pit/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

/** Minimal TUI stub that only exposes terminal.columns */
function createTuiStub(columns: number): { columns: number; stub: any } {
	const state = { columns };
	const stub = {
		terminal: {
			get columns() {
				return state.columns;
			},
			get rows() {
				return 24;
			},
		},
		// Loader drives its spinner off the shared animation ticker.
		addAnimationCallback: (_cb: (now: number) => boolean) => () => {},
		addInterval: (_cb: () => void, _ms: number) => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestRender: () => {},
	};
	return { columns: state.columns, stub };
}

describe("BashExecutionComponent width handling (#2569)", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("collapsed preview lines respect render-time width, not construction-time width", () => {
		const wideWidth = 200;
		const narrowWidth = 80;

		const { stub } = createTuiStub(wideWidth);
		const component = new BashExecutionComponent("pwd", stub);

		// Add output with long lines that will wrap differently at different widths
		const longLine = "x".repeat(150);
		component.appendOutput(`${longLine}\n${longLine}\n`);

		// Complete the command so it enters collapsed mode
		component.setComplete(0, false);

		// Render at the narrow width (simulating a resize or split pane)
		const lines = component.render(narrowWidth);

		// Every rendered line must fit within the narrow width
		for (let i = 0; i < lines.length; i++) {
			const w = visibleWidth(lines[i]);
			expect(w, `Line ${i} visibleWidth=${w} > ${narrowWidth}`).toBeLessThanOrEqual(narrowWidth);
		}
	});

	it("reuses output children across streaming chunks", () => {
		const { stub } = createTuiStub(100);
		const component = new BashExecutionComponent("echo test", stub);
		component.appendOutput("line one\n");
		const container = (component as unknown as { contentContainer: { children: unknown[] } }).contentContainer;
		const childCount = container.children.length;

		component.appendOutput("line two\n");
		expect(container.children.length).toBe(childCount);
	});

	it("re-computes lines when width changes between renders", () => {
		const { stub } = createTuiStub(200);
		const component = new BashExecutionComponent("echo hello", stub);

		const longLine = "abcdefghij".repeat(20); // 200 chars
		component.appendOutput(`${longLine}\n`);
		component.setComplete(0, false);

		// First render at width 200
		const lines200 = component.render(200);
		for (const line of lines200) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(200);
		}

		// Second render at width 60 (split pane scenario)
		const lines60 = component.render(60);
		for (let i = 0; i < lines60.length; i++) {
			const w = visibleWidth(lines60[i]);
			expect(w, `Line ${i} visibleWidth=${w} > 60`).toBeLessThanOrEqual(60);
		}
	});

	it("clamps a long command header to a single visual row when collapsed", () => {
		const { stub } = createTuiStub(80);
		const longCommand = `cd /d/hermes-webui && grep -rIn "github" --exclude-dir=.git --exclude-dir=.claude . | grep -v "CHANGELOG.md" | wc -l`;
		const component = new BashExecutionComponent(longCommand, stub);
		component.setComplete(0, false);

		const width = 80;
		const lines = stripAnsi(component.render(width).join("\n")).split("\n");
		const headerRows = lines.filter((l) => l.includes("$ cd /d/hermes-webui"));
		// Header occupies exactly one row and fits the width, with an expand hint.
		expect(headerRows.length).toBe(1);
		expect(visibleWidth(headerRows[0])).toBeLessThanOrEqual(width);
		expect(headerRows[0]).toContain("…");
		expect(headerRows[0]).toContain("to expand");
		// The clipped tail of the command is not visible anywhere collapsed.
		expect(lines.some((l) => l.includes("wc -l"))).toBe(false);

		// Expanding reveals the full command.
		component.setExpanded(true);
		const expanded = stripAnsi(component.render(width).join("\n"));
		expect(expanded).toContain("wc -l");
	});

	it("puts cancel hint in trailing suffix, not the loader message body (U02)", () => {
		const { stub } = createTuiStub(100);
		const component = new BashExecutionComponent("echo hi", stub);
		const loader = (component as unknown as { loader: { message: string; coloredTrailingSuffix: string } }).loader;

		// Raw message stays a clean status label.
		expect(loader.message).toBe("Running…");
		expect(loader.message).not.toContain("cancel");

		// Cancel hint is applied via setTrailingSuffix (messageColorFn wraps it).
		const suffixPlain = stripAnsi(loader.coloredTrailingSuffix);
		expect(suffixPlain).toContain("to cancel");
		expect(suffixPlain).toMatch(/·/);
	});
});
