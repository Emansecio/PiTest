/**
 * Async re-injection hook for the coordinator's non-blocking spawn path.
 *
 * `task({op:"spawn"})` launches a detached subagent and returns a handle
 * immediately. This suite asserts:
 *  - the `onAsyncComplete` extension point fires once the detached subagent
 *    settles, carrying the same string `op:"join"` would return;
 *  - when re-injection happened (callback returned true), the handle is marked
 *    delivered so `op:"poll"`/`op:"join"` don't repeat the payload;
 *  - the full ref chain production wires (coordinator → onAsyncComplete →
 *    asyncDeliverRef → session deliver) carries the result end to end.
 *
 * Rig mirrors `coordinator-spawn.test.ts`: a scripted faux provider + in-memory
 * AuthStorage/ModelRegistry. The extension contract is the real one —
 * `createCoordinatorExtension(...)` returns `(pi) => void`; we hand it a minimal
 * `pi` whose `registerTool` captures the `task` tool by name.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createCoordinatorExtension } from "../src/core/built-ins/coordinator-extension.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";

describe("coordinator op:spawn re-injection", () => {
	let faux: FauxProviderRegistration | undefined;
	afterEach(() => faux?.unregister());

	// Build the `task` tool wired to the given onAsyncComplete, with a scripted
	// one-turn faux subagent. Sets the suite-level `faux` so afterEach cleans up.
	function buildTask(
		onAsyncComplete?: (handle: string, text: string, status: "done" | "error" | "cancelled") => boolean,
		response = "the answer is 42",
	) {
		faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage(response)]);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);

		const ext = createCoordinatorExtension({
			modelRegistry,
			getParentModel: () => model,
			getAvailableTools: () => [],
			convertToLlm: (messages) => convertToLlm(messages),
			onAsyncComplete,
		});
		// Real contract: the extension is `(pi) => void` and registers the `task`
		// tool via `pi.registerTool`. Capture it through a minimal stub `pi`.
		const tools: Record<string, { execute: (...a: unknown[]) => Promise<unknown> }> = {};
		ext({
			registerTool: (def: { name: string }) => {
				tools[def.name] = def as never;
			},
		} as never);
		const task = tools.task;
		expect(task).toBeDefined();
		return task;
	}

	const spawn = (task: { execute: (...a: unknown[]) => Promise<unknown> }, name: string) =>
		task.execute("call-spawn", { op: "spawn", name, prompt: "what is 6*7?" }, undefined, undefined, {});

	const run = (task: { execute: (...a: unknown[]) => Promise<unknown> }, op: string, handles: string[]) =>
		task.execute(`call-${op}`, { op, handles }, undefined, undefined, {});

	const textOf = (res: unknown): string => (res as { content: { text: string }[] }).content[0].text;

	it("invokes onAsyncComplete with the result when a spawned subagent settles", async () => {
		let resolve!: (v: { handle: string; text: string; status: "done" | "error" | "cancelled" }) => void;
		const fired = new Promise<{ handle: string; text: string; status: "done" | "error" | "cancelled" }>((r) => {
			resolve = r;
		});
		const task = buildTask((handle, text, status) => {
			resolve({ handle, text, status });
			return true;
		});

		const spawnRes = await spawn(task, "t1");
		expect((spawnRes as { details?: { async?: boolean } }).details?.async).toBe(true);

		const settled = await fired;
		expect(settled.handle).toBe("t1");
		expect(settled.status).toBe("done");
		expect(settled.text).toContain("the answer is 42");
	});

	it("marks the handle delivered so poll/join report it and don't repeat the payload", async () => {
		let resolve!: () => void;
		const fired = new Promise<void>((r) => {
			resolve = r;
		});
		// Returning true mimics a real re-injection → coordinator sets entry.delivered.
		const task = buildTask(() => {
			resolve();
			return true;
		});

		await spawn(task, "t1");
		await fired; // settle ran; delivered=true is set synchronously after the callback returns

		const poll = await run(task, "poll", ["t1"]);
		expect(textOf(poll)).toContain("already delivered to chat");

		const join = await run(task, "join", ["t1"]);
		expect(textOf(join)).toContain("already delivered");
		expect(textOf(join)).not.toContain("the answer is 42");
	});

	it("rejects a second spawn reusing a RUNNING handle instead of orphaning the first's controller", async () => {
		// Regression for finding #4: `pending.set(handle, ...)` used to overwrite the
		// entry unconditionally. A second op:"spawn" with the same `name` while the
		// first still ran clobbered the first's AbortController in `pending` →
		// session teardown (which only iterates pending.values()) could no longer
		// abort the first detached run, leaking tokens/worktree.
		faux = registerFauxProvider();
		// Gate the first spawn's turn open so it is provably still "running" when the
		// second spawn arrives; release it afterward.
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		faux.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage("first-result");
			},
			fauxAssistantMessage("second-result"),
		]);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);

		let resolveFirst!: (v: { text: string; status: string }) => void;
		const settledFirst = new Promise<{ text: string; status: string }>((r) => {
			resolveFirst = r;
		});

		const ext = createCoordinatorExtension({
			modelRegistry,
			getParentModel: () => model,
			getAvailableTools: () => [],
			convertToLlm: (messages) => convertToLlm(messages),
			onAsyncComplete: (handle, text, status) => {
				if (handle === "dup") resolveFirst({ text, status });
				return true;
			},
		});
		const tools: Record<string, { execute: (...a: unknown[]) => Promise<unknown> }> = {};
		ext({
			registerTool: (def: { name: string }) => {
				tools[def.name] = def as never;
			},
		} as never);
		const task = tools.task;

		const firstSpawn = await spawn(task, "dup");
		expect((firstSpawn as { isError: boolean }).isError).toBe(false);

		// Second spawn with the SAME name while the first is still gated/running.
		const secondSpawn = await spawn(task, "dup");
		expect((secondSpawn as { isError: boolean }).isError).toBe(true);
		expect(textOf(secondSpawn)).toMatch(/already running/i);

		// Release the first run; it must still settle and deliver ITS result (proof
		// the first controller/entry was never clobbered).
		release();
		const first = await settledFirst;
		expect(first.status).toBe("done");
		expect(first.text).toContain("first-result");
	});

	it("does NOT mark delivered when the callback declines (e.g. kill-switch returns false)", async () => {
		let resolve!: () => void;
		const fired = new Promise<void>((r) => {
			resolve = r;
		});
		const task = buildTask(() => {
			resolve();
			return false; // re-injection disabled → result stays collectable verbatim
		});

		await spawn(task, "t1");
		await fired;

		const join = await run(task, "join", ["t1"]);
		expect(textOf(join)).toContain("the answer is 42");
		expect(textOf(join)).not.toContain("already delivered");
	});

	it("binds the coordinator's async completion to the real AgentSession", async () => {
		const tempDir = join(tmpdir(), `pit-coordinator-async-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
		try {
			faux = registerFauxProvider();
			faux.setResponses([fauxAssistantMessage("the answer is 42")]);
			const model = faux.getModel();
			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(model.provider, "faux-key");

			const services = await createAgentSessionServices({
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
			});
			({ session } = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(),
				model,
			}));
			await session.bindExtensions({});

			const task = session.agent.state.tools.find((tool) => tool.name === "task");
			expect(task).toBeDefined();
			const taskTool = task as unknown as { execute: (...a: unknown[]) => Promise<unknown> };
			let resolve!: (event: { handle: string; status: "done" | "error" | "cancelled" }) => void;
			const completed = new Promise<{ handle: string; status: "done" | "error" | "cancelled" }>((r) => {
				resolve = r;
			});
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "subagent_complete" && event.handle === "wired") {
					resolve({ handle: event.handle, status: event.status });
				}
			});
			try {
				const spawned = await spawn(taskTool, "wired");
				expect((spawned as { details?: { async?: boolean } }).details?.async).toBe(true);
				expect(await completed).toEqual({ handle: "wired", status: "done" });
			} finally {
				unsubscribe();
			}
		} finally {
			await session?.dispose();
			if (existsSync(tempDir)) {
				try {
					rmSync(tempDir, { recursive: true, force: true });
				} catch {
					// Best-effort on Windows handle-release races.
				}
			}
		}
	}, 60_000);
});
