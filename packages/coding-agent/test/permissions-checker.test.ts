/**
 * Tests for PermissionChecker — plan / auto (guarded) / unsafe (no-rails).
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

describe("PermissionChecker — unsafe mode (no-rails)", () => {
	it("allows writes to .env (builtins off)", () => {
		const c = new PermissionChecker({ cwd, mode: "unsafe", settings: {} });
		expect(c.check({ type: "write", toolName: "write", paths: [".env"] }).decision).toBe("allow");
	});

	it("allows dangerous commands (builtins off)", () => {
		const c = new PermissionChecker({ cwd, mode: "unsafe", settings: {} });
		expect(c.check({ type: "exec", toolName: "bash", command: "rm -rf /" }).decision).toBe("allow");
	});

	it("still honors user-authored explicit deny rules", () => {
		const c = new PermissionChecker({
			cwd,
			mode: "unsafe",
			settings: {
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

describe("PermissionChecker — auto + disableBuiltinDefaults behaves like unsafe", () => {
	it("allows .env and rm -rf / when builtins disabled", () => {
		const c = new PermissionChecker({ cwd, mode: "auto", settings: { disableBuiltinDefaults: true } });
		expect(c.check({ type: "write", toolName: "write", paths: [".env"] }).decision).toBe("allow");
		expect(c.check({ type: "exec", toolName: "bash", command: "rm -rf /" }).decision).toBe("allow");
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
});
