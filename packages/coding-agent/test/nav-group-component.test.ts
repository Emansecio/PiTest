import { resetCapabilitiesCache, setCapabilities, type TUI } from "@pit/tui";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { NavGroupComponent } from "../src/modes/interactive/components/nav-group.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

// Pin capabilities: under a truecolor host (Windows Terminal sets WT_SESSION)
// gutter/icon ColorEases arm against the fake TUI's no-op animation callback
// and never settle, making the memoization paths under test unreachable.
beforeAll(() => setCapabilities({ images: null, trueColor: false, hyperlinks: false }));
afterAll(() => resetCapabilitiesCache());

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

	test("shows pending read target in header", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "src/other.ts" })));
		g.addCall(navExec("read", "2", { file_path: "src/footer.ts" }));
		expect(stripAnsi(g.render(120)[0])).toContain("footer.ts");
	});

	test("leaves transient elapsed telemetry to the working loader", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(navExec("read", "1", { file_path: "a.ts" }));
		expect(stripAnsi(g.render(120)[0])).not.toMatch(/· \d+s/);
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

	test("caps a failed child's auto-shown error body with an expand hint", () => {
		const g = new NavGroupComponent(fakeTui());
		const bad = navExec("read", "1", { file_path: "missing.ts" });
		const bigError = Array.from({ length: 30 }, (_, i) => `error line ${i + 1}`).join("\n");
		bad.updateResult({ content: [{ type: "text", text: bigError }], isError: true });
		g.addCall(bad);
		const out = g.render(120).map(stripAnsi);
		// header + at most ERROR_PREVIEW_LINES body lines + 1 hint line
		expect(out.length).toBeLessThanOrEqual(1 + 10 + 1);
		expect(out[out.length - 1]).toContain("more lines");
		expect(out[out.length - 1]).toContain("to expand");
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

	test("uses a check glyph", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a" })));
		expect(g.render(120)[0]).toContain("✓");
	});
});

describe("NavGroupComponent — settled-header memoization", () => {
	beforeAll(() => initTheme("dark"));

	test("returns the same array instance across frames once settled and collapsed", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a.ts" })));
		g.addCall(resolved(navExec("grep", "2", { pattern: "x" })));
		const first = g.render(120);
		const second = g.render(120);
		expect(second).toBe(first);
		expect(stripAnsi(second[0])).toContain("Explored");
	});

	test("recomputes when the width changes, then memoizes at the new width", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a.ts" })));
		const w120 = g.render(120);
		const w80 = g.render(80);
		expect(w80).not.toBe(w120);
		expect(g.render(80)).toBe(w80);
	});

	test("never serves the memo while any call is pending", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a.ts" })));
		g.addCall(navExec("read", "2", { file_path: "b.ts" })); // still pending
		const p1 = g.render(120);
		const p2 = g.render(120);
		// Each pending frame reassembles — the spinner glyph may change between
		// any two frames without any other state changing.
		expect(p2).not.toBe(p1);
		expect(stripAnsi(p1[0])).toContain("Exploring");
	});

	test("never serves the memo for an errored group (auto-shown child body)", () => {
		const g = new NavGroupComponent(fakeTui());
		const bad = navExec("read", "1", { file_path: "missing.ts" });
		bad.updateResult({ content: [{ type: "text", text: "ENOENT" }], isError: true });
		g.addCall(bad);
		const e1 = g.render(120);
		const e2 = g.render(120);
		expect(e2).not.toBe(e1);
	});

	test("addCall busts the memo and the header reflects the new call", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a.ts" })));
		const before = g.render(120);
		expect(g.render(120)).toBe(before);
		g.addCall(resolved(navExec("read", "2", { file_path: "b.ts" })));
		const after = g.render(120);
		expect(after).not.toBe(before);
		expect(stripAnsi(after[0])).toContain("b.ts");
	});

	test("setExpanded busts the memo and expanded bodies recompute every frame", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a.ts" })));
		const collapsed = g.render(120);
		expect(g.render(120)).toBe(collapsed);
		g.setExpanded(true);
		const e1 = g.render(120);
		expect(e1).not.toBe(collapsed);
		expect(e1.length).toBeGreaterThan(1);
		// Expanded children may stream/animate → no memo while expanded.
		expect(g.render(120)).not.toBe(e1);
		g.setExpanded(false);
		const back = g.render(120);
		expect(back.map(stripAnsi)).toEqual(collapsed.map(stripAnsi));
	});

	test("invalidate() drops the memo and reassembles byte-identically", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a.ts" })));
		g.addCall(resolved(navExec("grep", "2", { pattern: "x" })));
		const first = g.render(120);
		g.invalidate();
		const second = g.render(120);
		expect(second).not.toBe(first);
		expect(second).toEqual(first);
	});
});
