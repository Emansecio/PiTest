/**
 * Worktree isolation — a `worktree: true` subagent must actually WORK in the
 * worktree, not merely create-and-clean it while mutating the parent tree.
 *
 * Pins the three legs that make the isolation real:
 *  1. `retargetToolsForCwd` is invoked with the worktree path and its rebound
 *     tools are the ones the agent executes (a marker write lands in the
 *     worktree, NOT the parent checkout).
 *  2. The subagent's system prompt carries the worktree preamble + path.
 *  3. The grounding-guard chain and result plumbing keep working (record
 *     completes, worktreePath surfaces).
 * Plus a unit check of `retargetToolsForWorktree`'s swap-by-name behavior.
 */

import { execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Agent, AgentMessage, AgentTool } from "@pit/agent-core";
import { type FauxProviderRegistration, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@pit/ai";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { runWithAcceptance } from "../src/core/coordinator/acceptance.js";
import { SubagentRegistry } from "../src/core/coordinator/registry.js";
import { slotStats } from "../src/core/coordinator/slots.js";
import { type SpawnSubagentDependencies, spawnSubagent } from "../src/core/coordinator/spawn.js";
import { retargetToolsForWorktree } from "../src/core/coordinator/worktree-tools.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";

const execFileP = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
	await execFileP("git", args, { cwd });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function killTestProcess(pid: number): Promise<void> {
	if (!processIsAlive(pid)) return;
	if (process.platform === "win32") {
		await execFileP("taskkill", ["/pid", String(pid), "/T", "/F"]).catch(() => {});
		return;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// The process may have exited between the liveness check and kill.
	}
}

function shellQuote(path: string): string {
	return `'${path.replace(/\\/g, "/").replace(/'/g, `'"'"'`)}'`;
}

/**
 * A single committed git repo is built once (7 git spawns) and then cloned per
 * test with a plain recursive filesystem copy — git repos are relocatable, so a
 * fresh copy has an identical HEAD without paying the spawn cost again. This
 * turns 6× initRepo (≈42 git spawns) into 1 template + 6 fast fs copies.
 */
let templateRepo: string | undefined;

async function buildTemplateRepo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "pit-wt-template-"));
	await git(dir, "init");
	await git(dir, "config", "user.email", "test@test");
	await git(dir, "config", "user.name", "test");
	await git(dir, "config", "commit.gpgsign", "false");
	writeFileSync(join(dir, "README.md"), "hello");
	await git(dir, "add", ".");
	await git(dir, "commit", "-m", "init");
	return dir;
}

beforeAll(async () => {
	templateRepo = await buildTemplateRepo();
});

afterAll(() => {
	if (templateRepo) {
		rmSync(templateRepo, { recursive: true, force: true });
		templateRepo = undefined;
	}
});

/** Fresh temp git repo with one commit, so `git worktree add` has a HEAD. */
async function initRepo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "pit-wt-test-"));
	if (!templateRepo) throw new Error("template repo not initialized");
	cpSync(templateRepo, dir, { recursive: true });
	return dir;
}

interface Rig {
	faux: FauxProviderRegistration;
	deps: SpawnSubagentDependencies;
	dispose: () => void;
}

function createRig(tools: AgentTool[], retarget?: SpawnSubagentDependencies["retargetToolsForCwd"]): Rig {
	const faux = registerFauxProvider();
	faux.setResponses([]);
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const registry = new SubagentRegistry();
	return {
		faux,
		deps: {
			registry,
			model,
			modelRegistry,
			availableTools: tools,
			convertToLlm: (messages: AgentMessage[]) => convertToLlm(messages),
			retargetToolsForCwd: retarget,
		},
		dispose: () => faux.unregister(),
	};
}

function makeWriteTool(onWrite?: (cwd: string) => void, boundCwd?: string): AgentTool {
	return {
		name: "write",
		label: "write",
		description: "writes a marker file into its bound cwd",
		parameters: Type.Object({ value: Type.String() }),
		execute: async () => {
			if (boundCwd) {
				writeFileSync(join(boundCwd, "marker.txt"), "written");
				onWrite?.(boundCwd);
			}
			return { content: [{ type: "text", text: "wrote" }], details: {} };
		},
	};
}

describe("worktree isolation (spawn-level)", () => {
	const repos: string[] = [];
	const rigs: Rig[] = [];
	afterEach(() => {
		while (rigs.length > 0) rigs.pop()?.dispose();
		while (repos.length > 0) {
			const r = repos.pop();
			if (r) rmSync(r, { recursive: true, force: true });
		}
	});

	it("retargets tools to the worktree, announces it in the prompt, and writes land there", async () => {
		const repo = await initRepo();
		repos.push(repo);
		let retargetCwd: string | undefined;
		// The retarget swaps the parent-bound write tool for one bound to the
		// worktree cwd — mirroring what retargetToolsForWorktree does with the
		// real core tools, but observable in a hermetic test.
		const retarget = (tools: AgentTool[], cwd: string): AgentTool[] => {
			retargetCwd = cwd;
			return tools.map((t) => (t.name === "write" ? makeWriteTool(undefined, cwd) : t));
		};
		const rig = createRig([makeWriteTool(undefined, repo)], retarget);
		rigs.push(rig);
		rig.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { value: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		let capturedAgent: Agent | undefined;
		const result = await spawnSubagent(rig.deps, {
			prompt: "write the marker",
			taskName: "wt-isolated",
			cwd: repo,
			allowedTools: ["write"],
			worktree: { cleanup: "keep" },
			onAgentReady: (agent) => {
				capturedAgent = agent;
			},
		});

		// 1. Retarget got the worktree path (under <repo>/.pit/worktrees).
		expect(retargetCwd).toBeDefined();
		expect(retargetCwd).toContain(join(repo, ".pit", "worktrees"));
		expect(result.worktreePath).toBe(retargetCwd);
		// 2. The write landed in the worktree, NOT the parent checkout.
		expect(existsSync(join(retargetCwd as string, "marker.txt"))).toBe(true);
		expect(existsSync(join(repo, "marker.txt"))).toBe(false);
		// 3. The agent was told where to work.
		const systemPrompt = capturedAgent?.state.systemPrompt ?? "";
		expect(systemPrompt).toContain("Isolated worktree");
		expect(systemPrompt).toContain(retargetCwd as string);
		expect(result.record.status).toBe("completed");
	}, 30_000);

	it("aborts worktree creation promptly, reaps the git process tree, and preserves the abort reason", async () => {
		const repo = await initRepo();
		repos.push(repo);
		const rig = createRig([]);
		rigs.push(rig);
		const marker = join(repo, "hook-child.pid");
		const hanger = join(repo, "hang-hook.cjs");
		writeFileSync(
			hanger,
			'const fs = require("node:fs"); fs.writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n',
		);
		const hook = join(repo, ".git", "hooks", "post-checkout");
		writeFileSync(hook, `#!/bin/sh\n${shellQuote(process.execPath)} ${shellQuote(hanger)} ${shellQuote(marker)}\n`);
		chmodSync(hook, 0o755);
		const previousTimeout = process.env.PIT_WORKTREE_GIT_TIMEOUT_MS;
		process.env.PIT_WORKTREE_GIT_TIMEOUT_MS = "5000";
		const controller = new AbortController();
		const reason = new Error("aborted: stop worktree setup now");
		const spawning = spawnSubagent(rig.deps, {
			prompt: "work",
			taskName: "wt-abort-setup",
			cwd: repo,
			worktree: { cleanup: "keep" },
			signal: controller.signal,
		});
		let hookPid = 0;
		try {
			await waitFor(() => existsSync(marker));
			hookPid = Number(readFileSync(marker, "utf8"));
			expect(hookPid).toBeGreaterThan(0);
			controller.abort(reason);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const outcome = await Promise.race([
				spawning.then(
					() => ({ error: undefined }),
					(error: unknown) => ({ error }),
				),
				new Promise<undefined>((resolve) => {
					timer = setTimeout(() => resolve(undefined), 1500);
				}),
			]);
			if (timer) clearTimeout(timer);
			expect(outcome).toBeDefined();
			expect(outcome?.error).toBe(reason);
			await waitFor(() => !processIsAlive(hookPid), 1000);
			const worktreeRoot = join(repo, ".pit", "worktrees");
			if (existsSync(worktreeRoot)) expect(readdirSync(worktreeRoot)).toEqual([]);
			const list = (await execFileP("git", ["worktree", "list"], { cwd: repo })).stdout;
			expect(list).not.toContain("wt-abort-setup");
		} finally {
			controller.abort(reason);
			if (hookPid > 0) await killTestProcess(hookPid);
			await Promise.race([spawning.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000))]);
			if (previousTimeout === undefined) delete process.env.PIT_WORKTREE_GIT_TIMEOUT_MS;
			else process.env.PIT_WORKTREE_GIT_TIMEOUT_MS = previousTimeout;
		}
	}, 15_000);

	it.each([
		["explicit Error", () => new Error("aborted: retain unsafe worktree")],
		["default DOMException", undefined],
	] as const)(
		"retains an auto-cleanup worktree without mutating the %s abort reason",
		async (_label, makeReason) => {
			const repo = await initRepo();
			repos.push(repo);
			const rig = createRig([]);
			rigs.push(rig);
			let markStarted: (() => void) | undefined;
			const started = new Promise<void>((resolve) => {
				markStarted = resolve;
			});
			let releaseProvider: (() => void) | undefined;
			rig.faux.setResponses([
				async () => {
					markStarted?.();
					return await new Promise((resolve) => {
						releaseProvider = () => resolve(fauxAssistantMessage("late output"));
					});
				},
			]);
			const controller = new AbortController();
			let worktreePath: string | undefined;
			const spawning = spawnSubagent(rig.deps, {
				prompt: "never settles cooperatively",
				taskName: "wt-noncooperative-abort",
				cwd: repo,
				worktree: true,
				signal: controller.signal,
				onWorktreeReady: (path) => {
					worktreePath = path;
				},
			});
			await started;
			const explicitReason = makeReason?.();
			controller.abort(explicitReason);
			const originalReason = controller.signal.reason;
			const originalMessage = originalReason instanceof Error ? originalReason.message : undefined;
			try {
				const outcome = await Promise.race([
					spawning.then(
						() => ({ error: undefined }),
						(error: unknown) => ({ error }),
					),
					new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
				]);
				expect(outcome).toBeDefined();
				expect(worktreePath).toBeDefined();
				expect(existsSync(worktreePath as string)).toBe(true);
				expect(outcome?.error).toBeInstanceOf(Error);
				const wrapped = outcome?.error as Error & { cause?: unknown };
				expect(wrapped).not.toBe(originalReason);
				expect(wrapped.cause).toBe(originalReason);
				expect(wrapped.message).toContain(worktreePath as string);
				expect(wrapped.message).toMatch(/retained|residual|not quiescent/i);
				if (originalReason instanceof Error) {
					expect(originalReason.message).toBe(originalMessage);
					expect(wrapped.message).toContain(originalMessage);
				}
				const record = rig.deps.registry.list().find((entry) => entry.taskName === "wt-noncooperative-abort");
				expect(record?.status).toBe("cancelled");
				expect(record?.error).toMatch(/retained|residual|not quiescent/i);
				expect(slotStats().active).toBeGreaterThan(0);
			} finally {
				releaseProvider?.();
				const deadline = Date.now() + 3000;
				while (slotStats().active > 0 && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				if (worktreePath) {
					await waitFor(() => !existsSync(worktreePath as string), 3000);
					const list = (await execFileP("git", ["worktree", "list"], { cwd: repo })).stdout;
					expect(list).not.toContain(worktreePath);
				}
			}
			expect(slotStats().active).toBe(0);
		},
		15_000,
	);

	it("uses the native retargeter for direct API callers that provide no callback", async () => {
		const repo = await initRepo();
		repos.push(repo);
		const fakeRead: AgentTool = {
			name: "read",
			label: "read",
			description: "parent-bound read",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "parent" }], details: {} }),
		};
		const rig = createRig([fakeRead]);
		rigs.push(rig);
		rig.faux.setResponses([fauxAssistantMessage("done")]);
		let reboundRead: AgentTool | undefined;
		await spawnSubagent(rig.deps, {
			prompt: "inspect",
			taskName: "wt-native-retarget",
			cwd: repo,
			allowedTools: ["read"],
			worktree: { cleanup: "keep" },
			onAgentReady: (agent) => {
				reboundRead = agent.state.tools.find((tool) => tool.name === "read");
			},
		});
		expect(reboundRead).toBeDefined();
		expect(reboundRead).not.toBe(fakeRead);
	}, 30_000);

	it("fails closed and removes an auto-cleanup worktree when retargeting fails", async () => {
		const repo = await initRepo();
		repos.push(repo);
		const rig = createRig([makeWriteTool()], () => {
			throw new Error("retarget exploded");
		});
		rigs.push(rig);
		await expect(
			spawnSubagent(rig.deps, {
				prompt: "write",
				taskName: "wt-retarget-fail",
				cwd: repo,
				worktree: true,
			}),
		).rejects.toThrow(/retarget exploded/);
		const worktreeDir = join(repo, ".pit", "worktrees");
		expect(readdirSync(worktreeDir)).toEqual([]);
		expect(rig.deps.registry.list().at(-1)?.status).toBe("failed");
	}, 30_000);

	it("keeps an auto-cleanup worktree alive through acceptance, then removes it", async () => {
		const repo = await initRepo();
		repos.push(repo);
		let worktreePath: string | undefined;
		const retarget = (tools: AgentTool[], cwd: string): AgentTool[] =>
			tools.map((tool) => (tool.name === "write" ? makeWriteTool(undefined, cwd) : tool));
		const rig = createRig([makeWriteTool(undefined, repo)], retarget);
		rigs.push(rig);
		rig.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { value: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const check = process.platform === "win32" ? "if exist marker.txt (exit 0) else (exit 1)" : "test -f marker.txt";
		const result = await runWithAcceptance(
			rig.deps,
			{
				prompt: "write marker",
				taskName: "wt-acceptance",
				cwd: repo,
				allowedTools: ["write"],
				worktree: true,
				onWorktreeReady: (path) => {
					worktreePath = path;
				},
			},
			{ check, max_attempts: 1 },
		);
		expect(result.gate?.passed).toBe(true);
		expect(worktreePath).toBeDefined();
		expect(existsSync(worktreePath as string)).toBe(false);
		expect(existsSync(join(repo, "marker.txt"))).toBe(false);
	}, 30_000);

	it("cleanup:keep removes rejected retry worktrees and retains only the accepted one", async () => {
		const repo = await initRepo();
		repos.push(repo);
		const rig = createRig([]);
		rigs.push(rig);
		rig.faux.setResponses([
			fauxAssistantMessage("attempt one"),
			fauxAssistantMessage('```json\n{"pass":false,"reasons":"retry"}\n```'),
			fauxAssistantMessage("attempt two"),
			fauxAssistantMessage('```json\n{"pass":true,"reasons":"ok"}\n```'),
		]);
		const paths: string[] = [];
		const result = await runWithAcceptance(
			rig.deps,
			{
				prompt: "work",
				taskName: "wt-keep-retry",
				cwd: repo,
				worktree: { cleanup: "keep" },
				onWorktreeReady: (path) => paths.push(path),
			},
			{ criteria: "pass on second attempt", max_attempts: 2 },
		);
		expect(result.gate?.passed).toBe(true);
		expect(paths).toHaveLength(2);
		expect(existsSync(paths[0])).toBe(false);
		expect(existsSync(paths[1])).toBe(true);
	}, 30_000);

	it("does not invoke the retarget without a worktree", async () => {
		const repo = await initRepo();
		repos.push(repo);
		let called = false;
		const rig = createRig([makeWriteTool()], (tools) => {
			called = true;
			return tools;
		});
		rigs.push(rig);
		rig.faux.setResponses([fauxAssistantMessage("plain done")]);
		const result = await spawnSubagent(rig.deps, { prompt: "no worktree", taskName: "wt-none", cwd: repo });
		expect(result.output).toBe("plain done");
		expect(called).toBe(false);
	}, 30_000);
});

describe("retargetToolsForWorktree (unit)", () => {
	it("swaps cwd-sensitive core tools by name and passes others through", () => {
		const dir = mkdtempSync(join(tmpdir(), "pit-wt-unit-"));
		try {
			const fakeRead: AgentTool = {
				name: "read",
				label: "read",
				description: "parent-bound read",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
			};
			const custom: AgentTool = {
				name: "my_custom_tool",
				label: "custom",
				description: "extension tool",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
			};
			const out = retargetToolsForWorktree([fakeRead, custom], dir);
			expect(out).toHaveLength(2);
			// read was rebuilt (new instance bound to dir), custom passed through.
			expect(out[0].name).toBe("read");
			expect(out[0]).not.toBe(fakeRead);
			expect(out[1]).toBe(custom);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
