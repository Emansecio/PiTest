import type { TUI } from "@pit/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

function fakeTui(): TUI {
	return { requestRender: () => {}, addAnimationCallback: () => () => {} } as unknown as TUI;
}

describe("ToolExecutionComponent activity API", () => {
	beforeAll(() => initTheme("dark"));

	test("getActivityFamily reads built-in metadata", () => {
		const read = new ToolExecutionComponent(
			"read",
			"t1",
			{ file_path: "a" },
			{},
			undefined,
			fakeTui(),
			process.cwd(),
		);
		expect(read.getActivityFamily()).toBe("navigation");
		// bash is dynamic: classified by its command (read-only -> navigation).
		const bashRead = new ToolExecutionComponent(
			"bash",
			"t2",
			{ command: "ls -la" },
			{},
			undefined,
			fakeTui(),
			process.cwd(),
		);
		expect(bashRead.getActivityFamily()).toBe("navigation");
		const bashAction = new ToolExecutionComponent(
			"bash",
			"t2b",
			{ command: "npm test" },
			{},
			undefined,
			fakeTui(),
			process.cwd(),
		);
		expect(bashAction.getActivityFamily()).toBe("action");
	});

	test("getActivityState tracks partial → success/error", () => {
		const c = new ToolExecutionComponent("read", "t3", { file_path: "a" }, {}, undefined, fakeTui(), process.cwd());
		expect(c.getActivityState()).toBe("pending");
		c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		expect(c.getActivityState()).toBe("success");
		const e = new ToolExecutionComponent("read", "t4", { file_path: "a" }, {}, undefined, fakeTui(), process.cwd());
		e.updateResult({ content: [{ type: "text", text: "boom" }], isError: true });
		expect(e.getActivityState()).toBe("error");
	});

	test("getToolName / getArgs / getResultDetails expose inputs", () => {
		const c = new ToolExecutionComponent("edit", "t5", { path: "x.ts" }, {}, undefined, fakeTui(), process.cwd());
		c.updateResult({ content: [], isError: false, details: { diff: "+  1 a" } });
		expect(c.getToolName()).toBe("edit");
		expect(c.getArgs()).toEqual({ path: "x.ts" });
		expect(c.getResultDetails()).toEqual({ diff: "+  1 a" });
	});

	test("resultExpanded shows error output without dumping the full bash command", () => {
		const longTail = "npm run check";
		const longCmd = `cd ${"x".repeat(120)} && ${longTail}`;
		const c = new ToolExecutionComponent("bash", "t7", { command: longCmd }, {}, undefined, fakeTui(), process.cwd());
		c.setActivityChild(true);
		c.updateResult({
			content: [{ type: "text", text: "ENOENT: missing file\n\nCommand exited with code 1" }],
			isError: true,
		});
		c.setResultExpanded(true);
		const plain = c.render(100).map(stripAnsi).join("\n");
		expect(plain).toContain("ENOENT");
		expect(plain).not.toContain(longCmd);
		expect(plain).not.toContain("$ cd");
	});

	test("activityChild edit renders diff body without the duplicate edit header", async () => {
		const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = await mkdtemp(join(tmpdir(), "pit-edit-activity-"));
		const filePath = join(dir, "sample.txt");
		await writeFile(filePath, "alpha\nbeta\n", "utf8");
		try {
			const c = new ToolExecutionComponent(
				"edit",
				"t-edit-activity",
				{ path: filePath, edits: [{ oldText: "beta", newText: "beta2" }] },
				{},
				createEditToolDefinition(process.cwd()),
				fakeTui(),
				process.cwd(),
			);
			c.setArgsComplete();
			c.setActivityChild(true);
			await new Promise((resolve) => setTimeout(resolve, 0));
			c.updateResult({
				content: [{ type: "text", text: `Successfully replaced 1 block(s) in ${filePath}.` }],
				details: { diff: "-  2 beta\n+  2 beta2" },
				isError: false,
			});
			const plain = c.render(100).map(stripAnsi).join("\n");
			expect(plain).toContain("beta2");
			expect(plain).not.toMatch(/\bedit\b.*sample\.txt/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("setActivityChild removes the gutter from rendered lines", () => {
		const c = new ToolExecutionComponent(
			"read",
			"t6",
			{ file_path: "a.ts" },
			{},
			undefined,
			fakeTui(),
			process.cwd(),
		);
		c.updateResult({ content: [{ type: "text", text: "data" }], isError: false });
		c.setActivityChild(true);
		for (const line of c.render(120)) {
			expect(stripAnsi(line)).not.toContain("│");
		}
	});
});
