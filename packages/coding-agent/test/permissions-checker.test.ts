/**
 * Tests for PermissionChecker — auto/yolo and plan mode behavior.
 */

import { describe, expect, it } from "vitest";
import { describeToolAction, PermissionChecker } from "../src/core/permissions/checker.js";

const cwd = process.platform === "win32" ? "C:/proj" : "/proj";

describe("PermissionChecker — auto/yolo mode", () => {
	it("allows writes that match ask and deny rules", () => {
		const c = new PermissionChecker({
			cwd,
			mode: "auto",
			settings: {
				askPaths: [{ glob: "**" }],
				denyPaths: [{ glob: "**/.env" }],
				denyTools: ["write"],
			},
		});
		expect(c.check({ type: "write", toolName: "write", paths: [".env"] }).decision).toBe("allow");
	});

	it("allows dangerous commands", () => {
		const c = new PermissionChecker({ cwd, mode: "auto", settings: {} });
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
		const decision = c.check({ type: "read", toolName: "read", paths: [".env"] });
		expect(decision.decision).toBe("deny");
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
