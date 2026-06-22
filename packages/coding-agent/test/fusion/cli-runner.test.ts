import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
	applyClaudeStreamLine,
	applyCodexStreamLine,
	buildClaudeArgs,
	buildCodexArgs,
	buildMemberEnv,
	type ClaudeStreamState,
	type CodexStreamState,
	detectCliAsync,
	inferCli,
	type MemberProgress,
	parseClaudeError,
	providerForCli,
	runPanelMember,
	toClaudeModel,
	toCodexModel,
} from "../../src/core/fusion/cli-runner.ts";

describe("fusion cli-runner pure helpers", () => {
	it("infers the CLI from the model provider", () => {
		expect(inferCli("anthropic")).toBe("claude");
		expect(inferCli("openai-codex")).toBe("codex");
		expect(inferCli("google")).toBeUndefined();
	});

	it("builds codex read-only exec args with tmpfile capture + json stream", () => {
		expect(buildCodexArgs("gpt-5.5", "C:/PiTest", "C:/tmp/a.txt", false)).toEqual([
			"exec",
			"-s",
			"read-only",
			"-m",
			"gpt-5.5",
			"-C",
			"C:/PiTest",
			"-o",
			"C:/tmp/a.txt",
			"--skip-git-repo-check",
			"--json",
		]);
	});

	it("appends only --color never to codex args when lean (NOT --ignore-user-config: it can drop ~/.codex/auth.json)", () => {
		expect(buildCodexArgs("gpt-5.5", "C:/PiTest", "C:/tmp/a.txt", true)).toEqual([
			"exec",
			"-s",
			"read-only",
			"-m",
			"gpt-5.5",
			"-C",
			"C:/PiTest",
			"-o",
			"C:/tmp/a.txt",
			"--skip-git-repo-check",
			"--json",
			"--color",
			"never",
		]);
	});

	it("normalizes registry model ids to what the CLI accepts (strips [variant] suffix)", () => {
		expect(toClaudeModel("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
		expect(toCodexModel("gpt-5.5-codex[xhigh]")).toBe("gpt-5.5-codex");
		// No suffix → unchanged; no family remapping.
		expect(toClaudeModel("opus")).toBe("opus");
		expect(toCodexModel("gpt-5.5-codex")).toBe("gpt-5.5-codex");
	});

	it("applies model normalization inside the arg builders", () => {
		expect(buildClaudeArgs("claude-opus-4-8[1m]", false)).toContain("claude-opus-4-8");
		expect(buildClaudeArgs("claude-opus-4-8[1m]", false)).not.toContain("claude-opus-4-8[1m]");
		const codexArgs = buildCodexArgs("gpt-5.5-codex[xhigh]", "C:/PiTest", "C:/tmp/a.txt", false);
		expect(codexArgs).toContain("gpt-5.5-codex");
		expect(codexArgs).not.toContain("gpt-5.5-codex[xhigh]");
	});

	it("builds claude plan-mode stream-json print args (stream-json needs --verbose)", () => {
		expect(buildClaudeArgs("opus", false)).toEqual([
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--permission-mode",
			"plan",
			"--model",
			"opus",
		]);
	});

	it("appends lean flags to claude args when lean (NOT --bare: it breaks env-injected auth)", () => {
		expect(buildClaudeArgs("opus", true)).toEqual([
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--permission-mode",
			"plan",
			"--model",
			"opus",
			"--strict-mcp-config",
			"--setting-sources",
			"project",
		]);
	});

	it("extracts the human cause from a claude error envelope", () => {
		expect(parseClaudeError(JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" }))).toBe(
			"Not logged in · Please run /login",
		);
		// Not an error envelope (is_error falsy) or not JSON → empty.
		expect(parseClaudeError(JSON.stringify({ is_error: false, result: "ok" }))).toBe("");
		expect(parseClaudeError("not json")).toBe("");
	});

	it("maps a Fusion CLI back to its registry provider", () => {
		expect(providerForCli("claude")).toBe("anthropic");
		expect(providerForCli("codex")).toBe("openai-codex");
	});

	it("folds claude stream-json lines into live activity + final result", () => {
		const state: ClaudeStreamState = { result: "", error: "", sawResult: false };
		const seen: MemberProgress[] = [];
		const on = (p: MemberProgress) => seen.push(p);
		applyClaudeStreamLine(JSON.stringify({ type: "system" }), state, on); // ignored
		applyClaudeStreamLine(
			JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking" }] } }),
			state,
			on,
		);
		applyClaudeStreamLine(
			JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
			state,
			on,
		);
		applyClaudeStreamLine(
			JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } }),
			state,
			on,
		);
		applyClaudeStreamLine(JSON.stringify({ type: "result", is_error: false, result: "final answer" }), state, on);
		expect(seen).toEqual([{ kind: "thinking" }, { kind: "tool", tool: "Bash" }, { kind: "tool_result" }]);
		expect(state.result).toBe("final answer");
		expect(state.sawResult).toBe(true);
		// A malformed/partial line is ignored, not thrown.
		expect(() => applyClaudeStreamLine('{"type":"assist', state, on)).not.toThrow();
	});

	it("captures the error cause from a claude stream-json is_error result", () => {
		const state: ClaudeStreamState = { result: "", error: "", sawResult: false };
		applyClaudeStreamLine(JSON.stringify({ type: "result", is_error: true, result: "Not logged in" }), state);
		expect(state.error).toBe("Not logged in");
		expect(state.result).toBe("");
	});

	it("folds codex --json item events into live activity", () => {
		const state: CodexStreamState = { error: "" };
		const seen: MemberProgress[] = [];
		const on = (p: MemberProgress) => seen.push(p);
		applyCodexStreamLine(JSON.stringify({ type: "thread.started" }), state, on); // ignored
		applyCodexStreamLine(JSON.stringify({ type: "item.started", item: { type: "reasoning" } }), state, on);
		applyCodexStreamLine(JSON.stringify({ type: "item.started", item: { type: "command_execution" } }), state, on);
		applyCodexStreamLine(JSON.stringify({ type: "item.started", item: { type: "agent_message" } }), state, on);
		applyCodexStreamLine(JSON.stringify({ type: "turn.completed" }), state, on); // ignored
		expect(seen).toEqual([{ kind: "thinking" }, { kind: "tool", tool: "Bash" }, { kind: "writing" }]);
	});

	it("digs the human cause out of a codex turn.failed envelope", () => {
		const state: CodexStreamState = { error: "" };
		const nested = JSON.stringify({
			type: "error",
			status: 400,
			error: { type: "invalid_request_error", message: "The 'gpt-5-codex' model is not supported." },
		});
		applyCodexStreamLine(JSON.stringify({ type: "turn.failed", error: { message: nested } }), state);
		expect(state.error).toBe("The 'gpt-5-codex' model is not supported.");
	});

	it("forwards the thinking/writing text snippet from claude stream-json", () => {
		const state: ClaudeStreamState = { result: "", error: "", sawResult: false };
		const seen: MemberProgress[] = [];
		const on = (p: MemberProgress) => seen.push(p);
		applyClaudeStreamLine(
			JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "thinking", thinking: "weighing the cache TTL" }] },
			}),
			state,
			on,
		);
		applyClaudeStreamLine(
			JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Here is my analysis" }] } }),
			state,
			on,
		);
		expect(seen).toContainEqual({ kind: "thinking", text: "weighing the cache TTL" });
		expect(seen).toContainEqual({ kind: "writing", text: "Here is my analysis" });
	});

	it("injects Pit's anthropic OAuth token as CLAUDE_CODE_OAUTH_TOKEN for claude members", () => {
		const base = { PATH: "/x", ANTHROPIC_API_KEY: "stray" };
		const env = buildMemberEnv("claude", "sk-ant-oat01-abc", base);
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-abc");
		// A stray API key must not shadow the injected OAuth token.
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.PATH).toBe("/x");
		// Never mutate the caller's base env.
		expect(base.ANTHROPIC_API_KEY).toBe("stray");
	});

	it("injects a plain anthropic API key as ANTHROPIC_API_KEY for claude members", () => {
		const env = buildMemberEnv("claude", "sk-ant-api03-xyz", { CLAUDE_CODE_OAUTH_TOKEN: "stale" });
		expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-xyz");
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
	});

	it("leaves the env untouched when no token is available", () => {
		const env = buildMemberEnv("claude", undefined, { PATH: "/x" });
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.PATH).toBe("/x");
	});
});

function fakeChild(stdoutData: string, exitCode: number) {
	const child: any = new EventEmitter();
	child.pid = 1234;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = { write() {}, end() {}, on() {} };
	queueMicrotask(() => {
		if (stdoutData) child.stdout.emit("data", stdoutData);
		child.emit("close", exitCode);
	});
	return child;
}

describe("runPanelMember (injected spawn)", () => {
	it("returns ok with claude final text from the stream-json result event", async () => {
		const line = JSON.stringify({ type: "result", is_error: false, result: "claude says hi" });
		const spawnFn = (() => fakeChild(line, 0)) as never;
		const r = await runPanelMember(
			{ cli: "claude", model: "opus" },
			{ prompt: "x", cwd: ".", timeoutMs: 5000, spawnFn },
		);
		expect(r.ok).toBe(true);
		expect(r.text).toBe("claude says hi");
	});

	it("forwards live activity from claude stream-json to onProgress", async () => {
		const lines = [
			JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }),
			JSON.stringify({ type: "result", is_error: false, result: "done" }),
		].join("\n");
		const seen: MemberProgress[] = [];
		const spawnFn = (() => fakeChild(lines, 0)) as never;
		const r = await runPanelMember(
			{ cli: "claude", model: "opus" },
			{ prompt: "x", cwd: ".", timeoutMs: 5000, spawnFn, onProgress: (p) => seen.push(p) },
		);
		expect(r.ok).toBe(true);
		expect(seen).toContainEqual({ kind: "tool", tool: "Read" });
	});

	it("encodes a non-zero exit as a failed PanelResult", async () => {
		const spawnFn = (() => fakeChild("", 1)) as never;
		const r = await runPanelMember(
			{ cli: "claude", model: "opus" },
			{ prompt: "x", cwd: ".", timeoutMs: 5000, spawnFn },
		);
		expect(r.ok).toBe(false);
	});

	it("surfaces the claude error-envelope cause on a failed turn", async () => {
		const envelope = JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" });
		const spawnFn = (() => fakeChild(envelope, 1)) as never;
		const r = await runPanelMember(
			{ cli: "claude", model: "opus" },
			{ prompt: "x", cwd: ".", timeoutMs: 5000, spawnFn },
		);
		expect(r.ok).toBe(false);
		expect(r.error).toBe("Not logged in · Please run /login");
	});

	it("short-circuits an already-aborted signal without spawning", async () => {
		let spawnCalls = 0;
		const spawnFn = (() => {
			spawnCalls += 1;
			return fakeChild(JSON.stringify({ type: "result", is_error: false, result: "x" }), 0);
		}) as never;
		const ac = new AbortController();
		ac.abort();
		const r = await runPanelMember(
			{ cli: "claude", model: "opus" },
			{ prompt: "x", cwd: ".", timeoutMs: 5000, spawnFn, signal: ac.signal },
		);
		expect(r.ok).toBe(false);
		expect(r.error).toBe("aborted");
		expect(spawnCalls).toBe(0);
	});
});

describe("detectCliAsync (non-blocking probe)", () => {
	it("resolves true when --version exits 0", async () => {
		const spawnFn = (() => fakeChild("codex 1.0", 0)) as never;
		await expect(detectCliAsync("codex", spawnFn)).resolves.toBe(true);
	});

	it("resolves false when --version exits non-zero", async () => {
		const spawnFn = (() => fakeChild("", 1)) as never;
		await expect(detectCliAsync("claude", spawnFn)).resolves.toBe(false);
	});

	it("resolves false on a spawn error (ENOENT)", async () => {
		const spawnFn = (() => {
			const child: any = new EventEmitter();
			child.pid = 1;
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			queueMicrotask(() => child.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" })));
			return child;
		}) as never;
		await expect(detectCliAsync("claude", spawnFn)).resolves.toBe(false);
	});
});
