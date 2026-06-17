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

	it("denyTools/allowTools support globs for whole MCP servers (mcp__github__*)", () => {
		const deny = new PermissionChecker({ cwd, mode: "auto", settings: { denyTools: ["mcp__github__*"] } });
		expect(deny.check({ type: "tool", toolName: "mcp__github__create_issue", args: {} }).decision).toBe("deny");
		// A different server is unaffected by the github glob.
		expect(deny.check({ type: "tool", toolName: "mcp__slack__post", args: {} }).decision).toBe("allow");

		const allow = new PermissionChecker({ cwd, mode: "auto", settings: { allowTools: ["mcp__fs__*"] } });
		expect(allow.check({ type: "tool", toolName: "mcp__fs__read", args: {} }).decision).toBe("allow");
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

describe("PermissionChecker — deny-floor path aliases (security)", () => {
	const auto = () => new PermissionChecker({ cwd, mode: "auto", settings: {} });

	it("denies edit when path is sent via the file_path alias (.env)", () => {
		expect(auto().check(describeToolAction("edit", { file_path: ".env", oldText: "a", newText: "b" })).decision).toBe(
			"deny",
		);
	});

	it("denies write when path is sent via the filepath alias (.env)", () => {
		expect(auto().check(describeToolAction("write", { filepath: ".env", content: "x" })).decision).toBe("deny");
	});

	it("denies edit when the alias is buried inside an edits[] element (.env)", () => {
		expect(
			auto().check(describeToolAction("edit", { edits: [{ file_path: ".env", oldText: "a", newText: "b" }] }))
				.decision,
		).toBe("deny");
	});

	it("denies read when path is sent via the file_path alias (.ssh/id_rsa)", () => {
		expect(auto().check(describeToolAction("read", { file_path: ".ssh/id_rsa" })).decision).toBe("deny");
	});

	it("still allows a legitimate edit sent via the file_path alias (src/app.ts)", () => {
		expect(
			auto().check(describeToolAction("edit", { file_path: "src/app.ts", oldText: "a", newText: "b" })).decision,
		).toBe("allow");
	});

	it("still collects the `directory` field for ls (regression guard)", () => {
		const a = describeToolAction("ls", { directory: "src" });
		expect((a as { paths: string[] }).paths).toEqual(["src"]);
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
