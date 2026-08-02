/**
 * Tests for the fail-closed CI preset (`permissions.allowlistOnly`).
 *
 * It is NOT a permission mode: it is an orthogonal settings/CLI flag that flips
 * auto's terminal from `allow` to `deny` for anything outside
 * `allowPaths` / `allowCommands` / `allowTools`. Reads stay free (after the deny
 * rules), and nothing ever prompts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { describeToolAction, PermissionChecker } from "../src/core/permissions/checker.ts";
import type { PermissionAction, PermissionSettings } from "../src/core/permissions/types.ts";

const cwd = process.platform === "win32" ? "C:/proj" : "/proj";

/** Globs are matched against ABSOLUTE paths, hence the leading `**\/`. */
const ALLOW_SRC = [{ glob: "**/src/**" }];
const ALLOW_NPM_TEST = [{ pattern: "^npm test" }];

function failClosed(extra: PermissionSettings = {}): PermissionChecker {
	return new PermissionChecker({
		cwd,
		mode: "auto",
		settings: { allowlistOnly: true, allowPaths: ALLOW_SRC, allowCommands: ALLOW_NPM_TEST, ...extra },
	});
}

function reasonOf(checker: PermissionChecker, action: PermissionAction): string {
	const decision = checker.check(action);
	return decision.decision === "deny" ? decision.reason : "";
}

describe("allowlistOnly — writes are gated by allowPaths", () => {
	it("allows a write whose path matches allowPaths", () => {
		expect(failClosed().check(describeToolAction("write", { path: "src/app.ts", content: "x" })).decision).toBe(
			"allow",
		);
	});

	it("denies a write outside allowPaths with an explicit fail-closed reason", () => {
		const c = failClosed();
		const action = describeToolAction("write", { path: "docs/readme.md", content: "x" });
		expect(c.check(action).decision).toBe("deny");
		expect(reasonOf(c, action)).toContain("Fail-closed (permissions.allowlistOnly)");
		expect(reasonOf(c, action)).toContain("does not match any allowPaths rule");
	});

	it("denies a multi-path action when only SOME paths match (all-or-nothing)", () => {
		const c = failClosed();
		const action = describeToolAction("edit", {
			path: "src/a.ts",
			edits: [{ path: "docs/b.md", oldText: "a", newText: "b" }],
		});
		expect(c.check(action).decision).toBe("deny");
		expect(reasonOf(c, action)).toContain("docs/b.md");
	});

	it("allows a multi-path action when EVERY path matches", () => {
		const action = describeToolAction("edit", {
			path: "src/a.ts",
			edits: [{ path: "src/b.ts", oldText: "a", newText: "b" }],
		});
		expect(failClosed().check(action).decision).toBe("allow");
	});

	it("denies a write action that exposes no path at all (unverifiable ≠ safe)", () => {
		const c = failClosed();
		const action = describeToolAction("chrome_devtools_navigate", { url: "http://example.test" });
		expect(action.type).toBe("write");
		expect(c.check(action).decision).toBe("deny");
		expect(reasonOf(c, action)).toContain("exposes no path");
	});

	it("denies every write when allowPaths is absent", () => {
		const c = new PermissionChecker({ cwd, mode: "auto", settings: { allowlistOnly: true } });
		expect(c.check(describeToolAction("write", { path: "src/app.ts", content: "x" })).decision).toBe("deny");
	});
});

describe("allowlistOnly — commands are gated by allowCommands", () => {
	it("allows a command matching an allowCommands rule", () => {
		expect(failClosed().check(describeToolAction("bash", { command: "npm test -- --run" })).decision).toBe("allow");
	});

	it("denies a command with no allowCommands match", () => {
		const c = failClosed();
		const action = describeToolAction("bash", { command: "npm run deploy" });
		expect(c.check(action).decision).toBe("deny");
		expect(reasonOf(c, action)).toContain("does not match any allowCommands rule");
	});

	it("denies exec-classified tools with an empty command body (eval/code/preview)", () => {
		const c = failClosed();
		expect(c.check(describeToolAction("eval", { code: "1+1" })).decision).toBe("deny");
		expect(c.check(describeToolAction("code", { code: "1+1" })).decision).toBe("deny");
	});

	it("denies when the allowCommands pattern is unsafe/invalid (rule never compiles)", () => {
		const c = failClosed({ allowCommands: [{ pattern: "(a+)+b" }] });
		expect(c.check(describeToolAction("bash", { command: "aaab" })).decision).toBe("deny");
	});

	it("denies when the allowlist regex pass blows the wall-clock budget", () => {
		// The permission budget is wall-clock, so the only way to force exhaustion
		// deterministically is to move the clock. The call sequence for an exec check
		// with an empty deny list is: [1] deny deadline, [2] deny budget probe,
		// [3] allowlist deadline, [4] regex-test budget probe, [5] allowlist budget
		// probe — so jumping from call 4 on expires the ALLOWLIST pass only.
		const base = Date.now();
		let calls = 0;
		const spy = vi.spyOn(Date, "now").mockImplementation(() => {
			calls += 1;
			return calls >= 4 ? base + 10_000 : base;
		});
		try {
			const c = failClosed({ disableBuiltinDefaults: true, denyCommands: [] });
			// Exactly ONE check() call — the mocked clock is consumed by call index.
			const decision = c.check(describeToolAction("bash", { command: "npm test" }));
			expect(decision.decision).toBe("deny");
			expect(decision.decision === "deny" ? decision.reason : "").toContain("regex time budget");
		} finally {
			spy.mockRestore();
		}
	});
});

describe("allowlistOnly — tools are gated by side effect", () => {
	it("allows side-effect-free tools", () => {
		const c = failClosed();
		expect(c.check(describeToolAction("todo", { action: "list" })).decision).toBe("allow");
		expect(c.check(describeToolAction("lsp", { action: "diagnostics", file: "a.ts" })).decision).toBe("allow");
	});

	it("denies agent/workspace side effects (subagents, memory mutators)", () => {
		const c = failClosed();
		expect(c.check(describeToolAction("task", { prompt: "x" })).decision).toBe("deny");
		expect(c.check(describeToolAction("memory_append", { entry: "x" })).decision).toBe("deny");
	});

	it("denies MCP and unclassified (opaque) tools", () => {
		const c = failClosed();
		const mcp = describeToolAction("mcp__github__create_issue", { title: "x" });
		expect(c.check(mcp).decision).toBe("deny");
		expect(reasonOf(c, mcp)).toContain("opaque");
		expect(c.check({ type: "tool", toolName: "totally_unknown_ext", args: {} }).decision).toBe("deny");
	});

	it("lets allowTools bypass the allowlist terminal (including MCP globs)", () => {
		const c = failClosed({ allowTools: ["mcp__github__*", "bash", "write"] });
		expect(c.check(describeToolAction("mcp__github__create_issue", { title: "x" })).decision).toBe("allow");
		expect(c.check(describeToolAction("bash", { command: "npm run deploy" })).decision).toBe("allow");
		expect(c.check(describeToolAction("write", { path: "docs/readme.md", content: "x" })).decision).toBe("allow");
	});
});

describe("allowlistOnly — reads stay free, deny rules still win", () => {
	it("allows reads that match nothing in allowPaths", () => {
		expect(failClosed().check(describeToolAction("read", { path: "docs/readme.md" })).decision).toBe("allow");
	});

	it("still blocks sensitive reads through the built-in floor", () => {
		expect(failClosed().check(describeToolAction("read", { path: ".env" })).decision).toBe("deny");
	});

	it("denyPaths beats allowPaths (deny rules run first)", () => {
		const c = failClosed({ denyPaths: [{ glob: "**/src/generated/**", reason: "generated" }] });
		const action = describeToolAction("write", { path: "src/generated/api.ts", content: "x" });
		expect(c.check(action).decision).toBe("deny");
		// The deny RULE reason, not the fail-closed terminal.
		expect(reasonOf(c, action)).toContain("generated");
		expect(reasonOf(c, action)).not.toContain("Fail-closed");
	});

	it("denyCommands / the dangerous-command floor beat allowCommands", () => {
		const c = failClosed({ allowCommands: [{ pattern: "^rm" }, ...ALLOW_NPM_TEST] });
		const action = describeToolAction("bash", { command: "rm -rf /" });
		expect(c.check(action).decision).toBe("deny");
		expect(reasonOf(c, action)).not.toContain("Fail-closed");
	});

	it("denyTools beats everything", () => {
		const c = failClosed({ denyTools: ["write"], allowTools: ["write"] });
		expect(c.check(describeToolAction("write", { path: "src/app.ts", content: "x" })).decision).toBe("deny");
	});
});

describe("allowlistOnly × disableBuiltinDefaults", () => {
	it("stays fail-closed with the floor dropped (no-rails does not mean no-gate)", () => {
		const c = failClosed({ disableBuiltinDefaults: true });
		expect(c.check(describeToolAction("write", { path: ".env", content: "x" })).decision).toBe("deny");
		expect(c.check(describeToolAction("bash", { command: "rm -rf /" })).decision).toBe("deny");
	});

	it("lets an explicit allowPaths entry reach a path the floor would block, once the floor is off", () => {
		const withFloor = failClosed({ allowPaths: [{ glob: "**/.env" }] });
		expect(withFloor.check(describeToolAction("write", { path: ".env", content: "x" })).decision).toBe("deny");
		const noFloor = failClosed({ allowPaths: [{ glob: "**/.env" }], disableBuiltinDefaults: true });
		expect(noFloor.check(describeToolAction("write", { path: ".env", content: "x" })).decision).toBe("allow");
	});

	it("exposes the flag as `failClosed` for the UI, independent of builtinsActive", () => {
		expect(failClosed().failClosed).toBe(true);
		expect(failClosed().builtinsActive).toBe(true);
		expect(new PermissionChecker({ cwd, mode: "auto", settings: {} }).failClosed).toBe(false);
	});
});

describe("allowlistOnly — read-only modes are untouched", () => {
	it("keeps plan/ask enforcement identical with the preset on or off", () => {
		const probes: PermissionAction[] = [
			describeToolAction("write", { path: "src/a.ts", content: "x" }),
			describeToolAction("bash", { command: "npm test" }),
			describeToolAction("read", { path: "src/a.ts" }),
			describeToolAction("read", { path: ".env" }),
			describeToolAction("todo", { action: "list" }),
			describeToolAction("task", { prompt: "x" }),
			describeToolAction("mcp__github__create_issue", { title: "x" }),
		];
		for (const mode of ["plan", "ask"] as const) {
			const off = new PermissionChecker({ cwd, mode, settings: { allowPaths: ALLOW_SRC } });
			const on = new PermissionChecker({
				cwd,
				mode,
				settings: { allowlistOnly: true, allowPaths: ALLOW_SRC, allowCommands: ALLOW_NPM_TEST },
			});
			for (const probe of probes) {
				expect(on.check(probe), `${mode}:${probe.type}:${probe.toolName}`).toEqual(off.check(probe));
			}
		}
	});
});

describe("allowlistOnly off — zero delta vs. today's behavior", () => {
	const probes: PermissionAction[] = [
		describeToolAction("write", { path: "src/app.ts", content: "x" }),
		describeToolAction("write", { path: "docs/readme.md", content: "x" }),
		describeToolAction("write", { path: ".env", content: "x" }),
		describeToolAction("edit", { path: "src/a.ts", edits: [{ path: "docs/b.md", oldText: "a", newText: "b" }] }),
		describeToolAction("bash", { command: "npm run deploy" }),
		describeToolAction("bash", { command: "rm -rf /" }),
		describeToolAction("eval", { code: "1+1" }),
		describeToolAction("read", { path: "docs/readme.md" }),
		describeToolAction("read", { path: ".env" }),
		describeToolAction("todo", { action: "list" }),
		describeToolAction("task", { prompt: "x" }),
		describeToolAction("memory_append", { entry: "x" }),
		describeToolAction("mcp__github__create_issue", { title: "x" }),
		describeToolAction("chrome_devtools_navigate", { url: "http://example.test" }),
		{ type: "tool", toolName: "totally_unknown_ext", args: {} },
	];

	const bases: PermissionSettings[] = [
		{},
		{ allowPaths: ALLOW_SRC },
		{ allowPaths: ALLOW_SRC, allowCommands: ALLOW_NPM_TEST },
		{ disableBuiltinDefaults: true },
		{ allowTools: ["bash"] },
		{ denyPaths: [{ glob: "**/src/generated/**" }] },
	];

	it("gives byte-identical decisions with the key absent, false, or false+allowlists", () => {
		for (const base of bases) {
			for (const mode of ["auto", "plan", "ask"] as const) {
				const absent = new PermissionChecker({ cwd, mode, settings: base });
				const explicitFalse = new PermissionChecker({ cwd, mode, settings: { ...base, allowlistOnly: false } });
				for (const probe of probes) {
					const expected = absent.check(probe);
					expect(explicitFalse.check(probe), `${mode}:${probe.toolName}`).toEqual(expected);
				}
			}
		}
	});

	it("snapshots the auto-mode terminal that must not move", () => {
		const c = new PermissionChecker({ cwd, mode: "auto", settings: { allowPaths: ALLOW_SRC, allowlistOnly: false } });
		expect(c.check(describeToolAction("write", { path: "docs/readme.md", content: "x" })).decision).toBe("allow");
		expect(c.check(describeToolAction("bash", { command: "npm run deploy" })).decision).toBe("allow");
		expect(c.check(describeToolAction("task", { prompt: "x" })).decision).toBe("allow");
		expect(c.check(describeToolAction("mcp__github__create_issue", { title: "x" })).decision).toBe("allow");
		expect(c.check(describeToolAction("write", { path: ".env", content: "x" })).decision).toBe("deny");
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});
