import type { TUI } from "@pit/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { NavGroupComponent } from "../src/modes/interactive/components/nav-group.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

function fakeTui(): TUI {
	return { requestRender: () => {}, addAnimationCallback: () => () => {} } as unknown as TUI;
}

function navExec(name: string, id: string, args: any): ToolExecutionComponent {
	return new ToolExecutionComponent(name, id, args, {}, undefined, fakeTui(), process.cwd());
}

function resolved(c: ToolExecutionComponent): ToolExecutionComponent {
	c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
	return c;
}

describe("NavGroupComponent", () => {
	beforeAll(() => initTheme("dark"));

	// Task 8 tests
	test("aggregates counters per noun once all resolve", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a" })));
		g.addCall(resolved(navExec("read", "2", { file_path: "b" })));
		g.addCall(resolved(navExec("read", "3", { file_path: "c" })));
		g.addCall(resolved(navExec("grep", "4", { pattern: "x" })));
		g.addCall(resolved(navExec("ls", "5", { path: "." })));
		const header = stripAnsi(g.render(120)[0]);
		expect(header).toContain("Explored");
		expect(header).toContain("3 files");
		expect(header).toContain("1 search");
		expect(header).toContain("1 list");
		expect(header).toContain("·");
	});

	test("uses Exploring while a call is still pending", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a" })));
		g.addCall(navExec("read", "2", { file_path: "b" })); // still partial
		expect(stripAnsi(g.render(120)[0])).toContain("Exploring");
	});

	test("collapsed render is a single line with no gutter", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a" })));
		const lines = g.render(120);
		expect(lines.length).toBe(1);
		expect(stripAnsi(lines[0])).not.toContain("│");
	});

	test("empty group renders nothing", () => {
		expect(new NavGroupComponent(fakeTui()).render(120)).toEqual([]);
	});

	// Task 9 tests
	test("setExpanded(true) renders all children indented under the header", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a.ts" })));
		g.addCall(resolved(navExec("read", "2", { file_path: "b.ts" })));
		g.setExpanded(true);
		const lines = g.render(120);
		expect(lines.length).toBeGreaterThan(1);
		for (const l of lines) expect(stripAnsi(l)).not.toContain("│");
	});

	test("a failed child marks the group ✗ and auto-expands only that child", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a.ts" })));
		const bad = navExec("read", "2", { file_path: "missing.ts" });
		bad.updateResult({ content: [{ type: "text", text: "ENOENT" }], isError: true });
		g.addCall(bad);
		const lines = g.render(120);
		expect(stripAnsi(lines[0])).toContain("✗");
		expect(lines.length).toBeGreaterThan(1);
		expect(stripAnsi(lines.join("\n"))).toContain("ENOENT");
	});

	// Task 4 tests
	test("always uses Explored/Exploring (never Did/Working)", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a" })));
		g.addCall(resolved(navExec("grep", "2", { pattern: "x" })));
		const out = g.render(120).map(stripAnsi);
		expect(out[0]).toContain("Explored");
		expect(out[0]).not.toContain("Did");
	});

	test("uses a heavy check glyph", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a" })));
		expect(g.render(120)[0]).toContain("✔");
	});
});
