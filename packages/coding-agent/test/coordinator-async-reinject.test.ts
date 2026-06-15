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

import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createCoordinatorExtension } from "../src/core/built-ins/coordinator-extension.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";

describe("coordinator op:spawn re-injection", () => {
	let faux: FauxProviderRegistration | undefined;
	afterEach(() => faux?.unregister());

	// Build the `task` tool wired to the given onAsyncComplete, with a scripted
	// one-turn faux subagent. Sets the suite-level `faux` so afterEach cleans up.
	function buildTask(
		onAsyncComplete?: (handle: string, text: string, status: "done" | "error") => boolean,
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
		let resolve!: (v: { handle: string; text: string; status: "done" | "error" }) => void;
		const fired = new Promise<{ handle: string; text: string; status: "done" | "error" }>((r) => {
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

	it("delivers through the full ref chain: coordinator → onAsyncComplete → asyncDeliverRef → deliver", async () => {
		// Reproduce the exact glue production wires (index.ts + agent-session-services.ts):
		// the coordinator's onAsyncComplete reads through a ref that __bindBuiltInRefs
		// points at the session's _deliverAsyncResult after construction.
		const asyncDeliverRef: { current?: (h: string, t: string, s: "done" | "error") => boolean } = {};
		let resolve!: () => void;
		const delivered = new Promise<void>((r) => {
			resolve = r;
		});
		const deliver = vi.fn((_h: string, _t: string, _s: "done" | "error") => {
			resolve();
			return true;
		});

		const task = buildTask((handle, text, status) => asyncDeliverRef.current?.(handle, text, status) ?? false);
		// Bind happens after construction, before any spawn settles — as in production.
		asyncDeliverRef.current = deliver;

		await spawn(task, "wired");
		await delivered;
		expect(deliver).toHaveBeenCalledWith("wired", expect.stringContaining("the answer is 42"), "done");
	});
});
