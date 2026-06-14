import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
	buildClaudeArgs,
	buildCodexArgs,
	inferCli,
	parseClaudeResult,
	runPanelMember,
} from "../../src/core/fusion/cli-runner.ts";

describe("fusion cli-runner pure helpers", () => {
	it("infers the CLI from the model provider", () => {
		expect(inferCli("anthropic")).toBe("claude");
		expect(inferCli("openai-codex")).toBe("codex");
		expect(inferCli("google")).toBeUndefined();
	});

	it("builds codex read-only exec args with tmpfile capture", () => {
		expect(buildCodexArgs("gpt-5.5-codex", "C:/PiTest", "C:/tmp/a.txt", false)).toEqual([
			"exec",
			"-s",
			"read-only",
			"-m",
			"gpt-5.5-codex",
			"-C",
			"C:/PiTest",
			"-o",
			"C:/tmp/a.txt",
			"--skip-git-repo-check",
		]);
	});

	it("appends lean flags to codex args when lean", () => {
		expect(buildCodexArgs("gpt-5.5-codex", "C:/PiTest", "C:/tmp/a.txt", true)).toEqual([
			"exec",
			"-s",
			"read-only",
			"-m",
			"gpt-5.5-codex",
			"-C",
			"C:/PiTest",
			"-o",
			"C:/tmp/a.txt",
			"--skip-git-repo-check",
			"--ignore-user-config",
			"--color",
			"never",
		]);
	});

	it("builds claude plan-mode print args", () => {
		expect(buildClaudeArgs("opus", false)).toEqual([
			"-p",
			"--output-format",
			"json",
			"--permission-mode",
			"plan",
			"--model",
			"opus",
		]);
	});

	it("appends lean flags to claude args when lean", () => {
		expect(buildClaudeArgs("opus", true)).toEqual([
			"-p",
			"--output-format",
			"json",
			"--permission-mode",
			"plan",
			"--model",
			"opus",
			"--bare",
			"--strict-mcp-config",
			"--setting-sources",
			"project",
		]);
	});

	it("parses the claude json result, empty on garbage", () => {
		expect(parseClaudeResult(JSON.stringify({ result: "hello" }))).toBe("hello");
		expect(parseClaudeResult("not json")).toBe("");
	});
});

function fakeChild(stdoutData: string, exitCode: number) {
	const child: any = new EventEmitter();
	child.pid = 1234;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = { write() {}, end() {} };
	queueMicrotask(() => {
		if (stdoutData) child.stdout.emit("data", stdoutData);
		child.emit("close", exitCode);
	});
	return child;
}

describe("runPanelMember (injected spawn)", () => {
	it("returns ok with claude .result text", async () => {
		const spawnFn = (() => fakeChild(JSON.stringify({ result: "claude says hi" }), 0)) as never;
		const r = await runPanelMember(
			{ cli: "claude", model: "opus" },
			{ prompt: "x", cwd: ".", timeoutMs: 5000, spawnFn },
		);
		expect(r.ok).toBe(true);
		expect(r.text).toBe("claude says hi");
	});

	it("encodes a non-zero exit as a failed PanelResult", async () => {
		const spawnFn = (() => fakeChild("", 1)) as never;
		const r = await runPanelMember(
			{ cli: "claude", model: "opus" },
			{ prompt: "x", cwd: ".", timeoutMs: 5000, spawnFn },
		);
		expect(r.ok).toBe(false);
	});
});
