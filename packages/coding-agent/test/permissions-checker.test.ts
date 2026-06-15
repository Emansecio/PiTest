/**
 * Tests for PermissionChecker — plan / auto (guarded) / no-rails
 * (auto + disableBuiltinDefaults).
 */

import { describe, expect, it } from "vitest";
import { describeToolAction, PermissionChecker } from "../src/core/permissions/checker.js";

const cwd = process.platform === "win32" ? "C:/proj" : "/proj";

describe("PermissionChecker — auto mode (guarded default)", () => {
	it("allows ordinary writes", () => {
		const c = new PermissionChecker({ cwd, mode: "auto", settings: {} });
		expect(c.check({ type: "write", toolName: "write", paths: ["src/app.ts"] }).decision).toBe("allow");
	});

	it("blocks writes to builtin sensitive paths (.env)", () => {
		const c = new PermissionChecker({ cwd, mode: "auto", settings: {} });
		expect(c.check({ type: "write", toolName: "write", paths: [".env"] }).decision).toBe("deny");
	});

	it("blocks reads of builtin sensitive paths (~/.ssh)", () => {
		const c = new PermissionChecker({ cwd, mode: "auto", settings: {} });
		expect(c.check({ type: "read", toolName: "read", paths: [".ssh/id_rsa"] }).decision).toBe("deny");
	});

	it("blocks builtin dangerous commands (rm -rf /)", () => {
		const c = new PermissionChecker({ cwd, mode: "auto", settings: {} });
		expect(c.check({ type: "exec", toolName: "bash", command: "rm -rf /" }).decision).toBe("deny");
	});

	it("allows ordinary commands", () => {
		const c = new PermissionChecker({ cwd, mode: "auto", settings: {} });
		expect(c.check({ type: "exec", toolName: "bash", command: "npm test" }).decision).toBe("allow");
	});

	it("honors explicit denyCommands", () => {
		const c = new PermissionChecker({
			cwd,
			mode: "auto",
			settings: { denyCommands: [{ pattern: "git\\s+push\\s+--force" }] },
		});
		expect(c.check({ type: "exec", toolName: "bash", command: "git push --force" }).decision).toBe("deny");
	});

	it("honors explicit denyTools", () => {
		const c = new PermissionChecker({ cwd, mode: "auto", settings: { denyTools: ["write"] } });
		expect(c.check({ type: "write", toolName: "write", paths: ["x"] }).decision).toBe("deny");
	});

	it("allowTools skips checks entirely (even .env)", () => {
		const c = new PermissionChecker({ cwd, mode: "auto", settings: { allowTools: ["write"] } });
		expect(c.check({ type: "write", toolName: "write", paths: [".env"] }).decision).toBe("allow");
	});
});

describe("PermissionChecker — no-rails (auto + disableBuiltinDefaults)", () => {
	it("allows writes to .env (builtins off)", () => {
		const c = new PermissionChecker({ cwd, mode: "auto", settings: { disableBuiltinDefaults: true } });
		expect(c.check({ type: "write", toolName: "write", paths: [".env"] }).decision).toBe("allow");
	});

	it("allows dangerous commands (builtins off)", () => {
		const c = new PermissionChecker({ cwd, mode: "auto", settings: { disableBuiltinDefaults: true } });
		expect(c.check({ type: "exec", toolName: "bash", command: "rm -rf /" }).decision).toBe("allow");
	});

	it("still honors user-authored explicit deny rules", () => {
		const c = new PermissionChecker({
			cwd,
			mode: "auto",
			settings: {
				disableBuiltinDefaults: true,
				denyPaths: [{ glob: "**/secret.key" }],
				denyCommands: [{ pattern: "shutdown" }],
				denyTools: ["edit"],
			},
		});
		expect(c.check({ type: "write", toolName: "write", paths: ["secret.key"] }).decision).toBe("deny");
		expect(c.check({ type: "exec", toolName: "bash", command: "shutdown now" }).decision).toBe("deny");
		expect(c.check({ type: "tool", toolName: "edit", args: {} }).decision).toBe("deny");
	});
});

describe("PermissionChecker — plan mode", () => {
	it("blocks any write or shell tool", () => {
		const c = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		expect(c.check({ type: "write", toolName: "write", paths: ["x"] }).decision).toBe("deny");
		expect(c.check({ type: "exec", toolName: "bash", command: "ls" }).decision).toBe("deny");
		expect(c.check({ type: "tool", toolName: "edit", args: {} }).decision).toBe("deny");
		expect(c.check({ type: "tool", toolName: "bash", args: {} }).decision).toBe("deny");
	});

	it("does not let allowTools bypass read-only mode", () => {
		const c = new PermissionChecker({ cwd, mode: "plan", settings: { allowTools: ["bash"] } });
		expect(c.check({ type: "exec", toolName: "bash", command: "ls" }).decision).toBe("deny");
	});

	it("allows read tools", () => {
		const c = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		expect(c.check({ type: "read", toolName: "read", paths: ["index.ts"] }).decision).toBe("allow");
	});

	it("blocks built-in sensitive reads", () => {
		const c = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		expect(c.check({ type: "read", toolName: "read", paths: [".env"] }).decision).toBe("deny");
	});
});

describe("PermissionChecker — plan mode tool-level rules", () => {
	it("denyTools applies to read-only tools", () => {
		const c = new PermissionChecker({
			cwd,
			mode: "plan",
			settings: { denyTools: ["read"] },
		});
		expect(c.check({ type: "read", toolName: "read", paths: ["index.ts"] }).decision).toBe("deny");
	});

	it("allowTools short-circuits read checks", () => {
		const c = new PermissionChecker({
			cwd,
			mode: "plan",
			settings: { allowTools: ["read"] },
		});
		expect(c.check({ type: "read", toolName: "read", paths: [".env"] }).decision).toBe("allow");
	});
});

describe("PermissionChecker — plan mode blocks side-effecting tools", () => {
	it("blocks eval (arbitrary code execution)", () => {
		const c = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		expect(c.check(describeToolAction("eval", { lang: "javascript", code: "1+1" })).decision).toBe("deny");
	});

	it("blocks debug (program execution)", () => {
		const c = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		expect(c.check(describeToolAction("debug", { action: "launch", program: "a.out" })).decision).toBe("deny");
	});

	it("blocks lsp rename and applied code_actions (workspace mutation)", () => {
		const c = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		expect(c.check(describeToolAction("lsp", { action: "rename", file: "a.ts", new_name: "B" })).decision).toBe(
			"deny",
		);
		expect(
			c.check(describeToolAction("lsp", { action: "rename_file", file: "a.ts", new_name: "b.ts" })).decision,
		).toBe("deny");
		expect(c.check(describeToolAction("lsp", { action: "code_actions", file: "a.ts", apply: true })).decision).toBe(
			"deny",
		);
	});

	it("allows read-only lsp actions", () => {
		const c = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		expect(c.check(describeToolAction("lsp", { action: "diagnostics", file: "a.ts" })).decision).toBe("allow");
		expect(c.check(describeToolAction("lsp", { action: "code_actions", file: "a.ts" })).decision).toBe("allow");
	});

	it("blocks chrome evaluate and interaction, allows read ops", () => {
		const c = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		expect(c.check(describeToolAction("chrome_devtools_evaluate", { function: "()=>1" })).decision).toBe("deny");
		expect(c.check(describeToolAction("chrome_devtools_click", { uid: "x" })).decision).toBe("deny");
		expect(c.check(describeToolAction("chrome_devtools_navigate", { url: "http://x" })).decision).toBe("deny");
		expect(c.check(describeToolAction("chrome_devtools_screenshot", {})).decision).toBe("allow");
	});
});

describe("PermissionChecker — auto mode unchanged for side-effecting tools", () => {
	it("allows eval/debug/lsp-write/chrome on non-denied targets", () => {
		const c = new PermissionChecker({ cwd, mode: "auto", settings: {} });
		expect(c.check(describeToolAction("eval", { code: "1+1" })).decision).toBe("allow");
		expect(c.check(describeToolAction("debug", { action: "launch" })).decision).toBe("allow");
		expect(c.check(describeToolAction("lsp", { action: "rename", file: "a.ts" })).decision).toBe("allow");
		expect(c.check(describeToolAction("chrome_devtools_navigate", { url: "http://x" })).decision).toBe("allow");
	});

	it("denies an lsp write to a builtin-sensitive path", () => {
		const c = new PermissionChecker({ cwd, mode: "auto", settings: {} });
		expect(
			c.check(describeToolAction("lsp", { action: "rename_file", file: ".env", new_name: ".env.bak" })).decision,
		).toBe("deny");
	});
});

describe("describeToolAction", () => {
	it("maps bash to exec action", () => {
		const a = describeToolAction("bash", { command: "ls" });
		expect(a.type).toBe("exec");
		expect((a as { command: string }).command).toBe("ls");
	});

	it("maps write tool to write paths", () => {
		const a = describeToolAction("write", { path: "out.txt", content: "x" });
		expect(a.type).toBe("write");
		expect((a as { paths: string[] }).paths).toEqual(["out.txt"]);
	});

	it("collects edit[].file paths", () => {
		const a = describeToolAction("edit", { file: "a.ts", edits: [{ file: "b.ts" }] });
		expect((a as { paths: string[] }).paths).toEqual(["a.ts", "b.ts"]);
	});

	it("maps eval and debug to exec", () => {
		expect(describeToolAction("eval", { code: "x" }).type).toBe("exec");
		expect(describeToolAction("debug", { action: "continue" }).type).toBe("exec");
	});

	it("maps lsp write actions to write and read actions to tool", () => {
		expect(describeToolAction("lsp", { action: "rename", file: "a.ts" }).type).toBe("write");
		expect(describeToolAction("lsp", { action: "code_actions", file: "a.ts", apply: true }).type).toBe("write");
		expect(describeToolAction("lsp", { action: "code_actions", file: "a.ts" }).type).toBe("tool");
		expect(describeToolAction("lsp", { action: "diagnostics", file: "a.ts" }).type).toBe("tool");
	});

	it("maps chrome side effects to exec/write and read ops to tool", () => {
		expect(describeToolAction("chrome_devtools_evaluate", {}).type).toBe("exec");
		expect(describeToolAction("chrome_devtools_click", {}).type).toBe("write");
		expect(describeToolAction("chrome_devtools_screenshot", {}).type).toBe("tool");
	});
});
