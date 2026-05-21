/**
 * Tests for PermissionChecker — mode behavior, allow/deny precedence,
 * built-in sensitive defaults.
 */

import { describe, expect, it } from "vitest";
import { describeToolAction, PermissionChecker } from "../src/core/permissions/checker.js";

const cwd = process.platform === "win32" ? "C:/proj" : "/proj";

describe("PermissionChecker — default mode", () => {
	it("blocks built-in sensitive paths", () => {
		const c = new PermissionChecker({ cwd, mode: "default", settings: {} });
		const decision = c.check({ type: "read", toolName: "read", paths: [".env"] });
		expect(decision.decision).toBe("deny");
	});

	it("asks on ask-path matches", () => {
		const c = new PermissionChecker({
			cwd,
			mode: "default",
			settings: {
				askPaths: [{ glob: "**/build/**", reason: "build dir" }],
				disableBuiltinDefaults: true,
			},
		});
		const decision = c.check({ type: "write", toolName: "write", paths: ["build/out.js"] });
		expect(decision.decision).toBe("ask");
		if (decision.decision === "ask") {
			expect(decision.reason).toContain("build dir");
		}
	});

	it("explicit allowPaths beats askPaths", () => {
		const c = new PermissionChecker({
			cwd,
			mode: "default",
			settings: {
				allowPaths: [{ glob: "build/**" }],
				askPaths: [{ glob: "build/**" }],
				disableBuiltinDefaults: true,
			},
		});
		expect(c.check({ type: "write", toolName: "write", paths: ["build/x"] }).decision).toBe("allow");
	});

	it("deny dangerous commands", () => {
		const c = new PermissionChecker({ cwd, mode: "default", settings: {} });
		expect(c.check({ type: "exec", toolName: "bash", command: "rm -rf /" }).decision).toBe("deny");
	});

	it("custom denyCommands trumps allow", () => {
		const c = new PermissionChecker({
			cwd,
			mode: "default",
			settings: {
				denyCommands: [{ pattern: "git\\s+push" }],
				disableBuiltinDefaults: true,
			},
		});
		expect(c.check({ type: "exec", toolName: "bash", command: "git push origin main" }).decision).toBe("deny");
	});
});

describe("PermissionChecker — auto mode", () => {
	it("skips ask prompts (returns allow)", () => {
		const c = new PermissionChecker({
			cwd,
			mode: "auto",
			settings: { askPaths: [{ glob: "**" }], disableBuiltinDefaults: true },
		});
		expect(c.check({ type: "write", toolName: "write", paths: ["x"] }).decision).toBe("allow");
	});

	it("still honors deny rules", () => {
		const c = new PermissionChecker({
			cwd,
			mode: "auto",
			settings: { denyPaths: [{ glob: "**/.env" }] },
		});
		expect(c.check({ type: "read", toolName: "read", paths: [".env"] }).decision).toBe("deny");
	});
});

describe("PermissionChecker — plan mode", () => {
	it("blocks any write tool", () => {
		const c = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		expect(c.check({ type: "write", toolName: "write", paths: ["x"] }).decision).toBe("deny");
		expect(c.check({ type: "tool", toolName: "edit", args: {} }).decision).toBe("deny");
		expect(c.check({ type: "tool", toolName: "bash", args: {} }).decision).toBe("deny");
	});

	it("allows read tools", () => {
		const c = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		expect(c.check({ type: "read", toolName: "read", paths: ["index.ts"] }).decision).toBe("allow");
	});
});

describe("PermissionChecker — tool-level allow/deny", () => {
	it("denyTools short-circuits everything", () => {
		const c = new PermissionChecker({
			cwd,
			mode: "default",
			settings: { denyTools: ["bash"] },
		});
		expect(c.check({ type: "exec", toolName: "bash", command: "ls" }).decision).toBe("deny");
	});

	it("allowTools short-circuits checks", () => {
		const c = new PermissionChecker({
			cwd,
			mode: "default",
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
