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

function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(filePath) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	if (!fs.existsSync(filePath)) throw new Error(`Timed out waiting for ${filePath}`);
}

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

	it("reaps a shell hook's grandchild before returning from a timeout", async () => {
		const pidPath = path.join(
			os.tmpdir(),
			`pi-hook-grandchild-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`,
		);
		const wrapperPidPath = `${pidPath}.wrapper`;
		const wrapperPath = path.join(
			os.tmpdir(),
			`pi-hook-wrapper-${Date.now()}-${Math.random().toString(36).slice(2)}.js`,
		);
		const grandchild = `require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1_000);`;
		const wrapper = `const fs = require("node:fs"); const { spawn } = require("node:child_process"); fs.writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.pid)); spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}, ${JSON.stringify(pidPath)}], { stdio: "ignore" }); setInterval(() => {}, 1_000);`;
		fs.writeFileSync(wrapperPath, wrapper, "utf-8");
		tempFiles.push(wrapperPath, pidPath, wrapperPidPath);

		let grandchildPid: number | undefined;
		let wrapperPid: number | undefined;
		try {
			const result = await runHook({ command: `node ${JSON.stringify(wrapperPath)}`, timeoutMs: 500 }, payload, {
				cwd: process.cwd(),
			});
			await waitForFile(pidPath);
			grandchildPid = Number(fs.readFileSync(pidPath, "utf-8"));
			if (fs.existsSync(wrapperPidPath)) wrapperPid = Number(fs.readFileSync(wrapperPidPath, "utf-8"));
			expect(result.timedOut).toBe(true);
			expect(pidExists(grandchildPid)).toBe(false);
		} finally {
			for (const pid of [wrapperPid, grandchildPid]) {
				if (!pid || !pidExists(pid)) continue;
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* already exited */
				}
			}
		}
	});
});
