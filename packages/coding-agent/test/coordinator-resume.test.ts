/**
 * Resume of an interrupted subagent (Tier 1, in-memory).
 *
 * When an op:"run" / op:"spawn" subagent is cut short — the user hits ESC, or a
 * long network drop exhausts provider retries — its partial transcript must not
 * be thrown away. The coordinator keeps the live Agent under its handle so
 * task({op:"resume", name}) re-opens it with the context intact and finishes the
 * job, instead of restarting from zero.
 *
 * Rig mirrors coordinator-async-reinject.test.ts: a scripted faux provider whose
 * FIRST step ends the turn with stopReason:"error" (the connection drop) and a
 * SECOND step that the resume turn consumes.
 */

import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createCoordinatorExtension } from "../src/core/built-ins/coordinator-extension.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";

describe("coordinator op:resume", () => {
	let faux: FauxProviderRegistration | undefined;
	afterEach(() => faux?.unregister());

	function buildTask(responses: Parameters<FauxProviderRegistration["setResponses"]>[0]) {
		faux = registerFauxProvider();
		faux.setResponses(responses);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const ext = createCoordinatorExtension({
			modelRegistry,
			getParentModel: () => model,
			getAvailableTools: () => [],
			convertToLlm: (messages) => convertToLlm(messages),
		});
		const tools: Record<string, { execute: (...a: unknown[]) => Promise<unknown> }> = {};
		ext({
			registerTool: (def: { name: string }) => {
				tools[def.name] = def as never;
			},
		} as never);
		return tools.task;
	}

	const exec = (task: { execute: (...a: unknown[]) => Promise<unknown> }, params: Record<string, unknown>) =>
		task.execute("call", params, undefined, undefined, {});
	const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0].text;
	const isErr = (r: unknown): boolean => (r as { isError: boolean }).isError;

	it("makes an interrupted op:run subagent resumable and finishes it via op:resume", async () => {
		const task = buildTask([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "network down" }),
			fauxAssistantMessage("RESUMED: task complete"),
		]);

		const runRes = await exec(task, { op: "run", name: "probe", prompt: "do the thing" });
		expect(isErr(runRes)).toBe(true);

		const list = await exec(task, { op: "list" });
		expect(textOf(list)).toMatch(/[Rr]esumable[\s\S]*probe/);

		const resumed = await exec(task, { op: "resume", name: "probe" });
		expect(isErr(resumed)).toBe(false);
		expect(textOf(resumed)).toContain("RESUMED: task complete");

		// Consumed: no longer offered as resumable.
		const list2 = await exec(task, { op: "list" });
		expect(textOf(list2)).not.toMatch(/[Rr]esumable[\s\S]*probe/);
	});

	it("resume accepts a continuation prompt", async () => {
		const task = buildTask([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "drop" }),
			fauxAssistantMessage("CONTINUED with new instruction"),
		]);
		await exec(task, { op: "run", name: "p2", prompt: "start" });
		const resumed = await exec(task, { op: "resume", name: "p2", prompt: "now wrap it up" });
		expect(isErr(resumed)).toBe(false);
		expect(textOf(resumed)).toContain("CONTINUED with new instruction");
	});

	it("returns a clear error when resuming an unknown handle", async () => {
		const task = buildTask([fauxAssistantMessage("ok")]);
		const res = await exec(task, { op: "resume", name: "ghost" });
		expect(isErr(res)).toBe(true);
		expect(textOf(res)).toContain("no resumable");
	});

	it("a cleanly-completed op:run is not resumable", async () => {
		const task = buildTask([fauxAssistantMessage("done cleanly")]);
		const ok = await exec(task, { op: "run", name: "clean", prompt: "x" });
		expect(isErr(ok)).toBe(false);
		const res = await exec(task, { op: "resume", name: "clean" });
		expect(isErr(res)).toBe(true);
	});
});
