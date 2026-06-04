import type { TUI } from "@pit/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { ActivityLineComponent } from "../src/modes/interactive/components/activity-line.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

function fakeTui(): TUI {
	return { requestRender: () => {}, addAnimationCallback: () => () => {} } as unknown as TUI;
}

function exec(name: string, args: any): ToolExecutionComponent {
	return new ToolExecutionComponent(name, "x", args, {}, undefined, fakeTui(), process.cwd());
}

describe("ActivityLineComponent", () => {
	beforeAll(() => initTheme("dark"));

	test("edit shows Edited + path + diffstat, no gutter", () => {
		const e = exec("edit", { path: "server/+page.svx" });
		e.updateResult({ content: [], isError: false, details: { diff: "+  1 a\n-  2 b" } });
		const line = new ActivityLineComponent(e, fakeTui());
		const text = stripAnsi(line.render(120)[0]);
		expect(text).toContain("Edited");
		expect(text).toContain("server/+page.svx");
		expect(text).toContain("+1");
		expect(text).toContain("-1");
		expect(text).not.toContain("│");
	});

	test("write shows Wrote + path with no diffstat", () => {
		const e = exec("write", { file_path: "src/new.ts" });
		e.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		const text = stripAnsi(new ActivityLineComponent(e, fakeTui()).render(120)[0]);
		expect(text).toContain("Wrote");
		expect(text).toContain("src/new.ts");
	});

	test("bash shows Ran $ command", () => {
		const e = exec("bash", { command: "npm test" });
		e.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		expect(stripAnsi(new ActivityLineComponent(e, fakeTui()).render(120)[0])).toContain("Ran $ npm test");
	});

	test("an errored action marks ✗ and auto-expands its detail", () => {
		const e = exec("bash", { command: "npm run build" });
		e.updateResult({ content: [{ type: "text", text: "compile error xyz" }], isError: true });
		const lines = new ActivityLineComponent(e, fakeTui()).render(120);
		expect(stripAnsi(lines[0])).toContain("✗");
		expect(stripAnsi(lines.join("\n"))).toContain("compile error xyz");
	});

	test("pending action shows neither ✓ nor ✗ in the header", () => {
		const text = stripAnsi(new ActivityLineComponent(exec("bash", { command: "x" }), fakeTui()).render(120)[0]);
		expect(text).not.toContain("✓");
		expect(text).not.toContain("✗");
	});
});
