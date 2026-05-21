/**
 * Tests for the declarative hook runner: command selection by matcher,
 * JSON stdout parsing, and PreToolUse fail-closed semantics.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHook, runHookChain, selectHooks } from "../src/core/hooks/runner.js";
import type { PreToolUsePayload } from "../src/core/hooks/types.js";

const tempFiles: string[] = [];

afterEach(() => {
	while (tempFiles.length > 0) {
		const p = tempFiles.pop();
		if (p) {
			try {
				fs.unlinkSync(p);
			} catch {
				/* ignore */
			}
		}
	}
});

function nodeCmd(stdoutJson: unknown, opts?: { exitCode?: number; useStderr?: boolean }): string {
	const exit = opts?.exitCode ?? 0;
	const target = opts?.useStderr ? "stderr" : "stdout";
	const script = `process.${target}.write(${JSON.stringify(JSON.stringify(stdoutJson))}); process.exit(${exit});`;
	const tempPath = path.join(os.tmpdir(), `pi-hook-test-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
	fs.writeFileSync(tempPath, script, "utf-8");
	tempFiles.push(tempPath);
	return `node ${JSON.stringify(tempPath)}`;
}

describe("hooks/selectHooks", () => {
	it("matches by tool-name regex", () => {
		const hooks = [{ command: "a", matcher: "bash" }, { command: "b", matcher: "edit|write" }, { command: "c" }];
		expect(selectHooks(hooks, "bash").map((h) => h.command)).toEqual(["a", "c"]);
		expect(selectHooks(hooks, "write").map((h) => h.command)).toEqual(["b", "c"]);
	});

	it("falls back to literal equality on invalid regex", () => {
		const hooks = [{ command: "a", matcher: "(broken" }];
		expect(selectHooks(hooks, "(broken").length).toBe(1);
		expect(selectHooks(hooks, "bash").length).toBe(0);
	});
});

describe("hooks/runHook (Node available)", () => {
	const payload: PreToolUsePayload = {
		event: "PreToolUse",
		toolName: "bash",
		toolCallId: "t1",
		input: { command: "ls" },
		cwd: process.cwd(),
	};

	it("parses JSON stdout into HookResult", async () => {
		const cmd = nodeCmd({ decision: "allow", reason: "ok" });
		const result = await runHook({ command: cmd }, payload, { cwd: process.cwd() });
		expect(result.exitCode).toBe(0);
		expect(result.parsed?.decision).toBe("allow");
		expect(result.parsed?.reason).toBe("ok");
	});

	it("returns no parsed when stdout is non-JSON", async () => {
		const tempPath = path.join(os.tmpdir(), `pi-hook-test-${Date.now()}-plain.js`);
		fs.writeFileSync(tempPath, `process.stdout.write("hello");`, "utf-8");
		tempFiles.push(tempPath);
		const result = await runHook({ command: `node ${JSON.stringify(tempPath)}` }, payload, { cwd: process.cwd() });
		expect(result.parsed).toBeUndefined();
	});

	it("reports non-zero exit", async () => {
		const cmd = nodeCmd({}, { exitCode: 2 });
		const result = await runHook({ command: cmd }, payload, { cwd: process.cwd() });
		expect(result.exitCode).toBe(2);
	});

	it("PreToolUse hook chain fails-closed on non-zero exit", async () => {
		const tempPath = path.join(os.tmpdir(), `pi-hook-test-${Date.now()}-fail.js`);
		fs.writeFileSync(tempPath, `process.stderr.write("boom"); process.exit(1);`, "utf-8");
		tempFiles.push(tempPath);
		const { blocked } = await runHookChain([{ command: `node ${JSON.stringify(tempPath)}` }], payload, {
			cwd: process.cwd(),
		});
		expect(blocked).toBeDefined();
		expect(blocked?.parsed?.decision).toBe("block");
		expect(blocked?.parsed?.reason).toContain("boom");
	});

	it("short-circuits the chain on first block decision", async () => {
		const blocker = nodeCmd({ decision: "block", reason: "stop" });
		const second = nodeCmd({ decision: "allow" });
		const { executions, blocked } = await runHookChain([{ command: blocker }, { command: second }], payload, {
			cwd: process.cwd(),
		});
		expect(executions.length).toBe(1);
		expect(blocked).toBeDefined();
	});
});
