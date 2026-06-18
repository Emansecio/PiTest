/**
 * Conversational continuation of a successfully-finished subagent (GAP #2,
 * ADR/uplift). Unlike op:resume (which only re-drives subagents interrupted with
 * an error/abort), op:continue sends a follow-up prompt to a subagent that
 * completed cleanly, reusing its live Agent so the transcript carries over —
 * the equivalent of Claude Code's SendMessage(agentId).
 *
 * Rig mirrors coordinator-resume.test.ts.
 */

import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createCoordinatorExtension } from "../src/core/built-ins/coordinator-extension.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";

describe("coordinator op:continue", () => {
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

	it("sends a follow-up to a cleanly-finished op:run via op:continue", async () => {
		const task = buildTask([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("follow-up answer with prior context"),
		]);
		const run = await exec(task, { op: "run", name: "c1", prompt: "first task" });
		expect(isErr(run)).toBe(false);

		const cont = await exec(task, { op: "continue", name: "c1", prompt: "now go further" });
		expect(isErr(cont)).toBe(false);
		expect(textOf(cont)).toContain("follow-up answer with prior context");
	});

	it("allows multiple follow-ups on the same handle (stays continuable)", async () => {
		const task = buildTask([
			fauxAssistantMessage("answer 1"),
			fauxAssistantMessage("answer 2"),
			fauxAssistantMessage("answer 3"),
		]);
		await exec(task, { op: "run", name: "multi", prompt: "p1" });
		const a2 = await exec(task, { op: "continue", name: "multi", prompt: "p2" });
		expect(textOf(a2)).toContain("answer 2");
		const a3 = await exec(task, { op: "continue", name: "multi", prompt: "p3" });
		expect(textOf(a3)).toContain("answer 3");
	});

	it("requires a prompt", async () => {
		const task = buildTask([fauxAssistantMessage("done")]);
		await exec(task, { op: "run", name: "needp", prompt: "x" });
		const res = await exec(task, { op: "continue", name: "needp" });
		expect(isErr(res)).toBe(true);
		expect(textOf(res)).toContain("needs `prompt`");
	});

	it("returns a clear error for an unknown / never-run handle", async () => {
		const task = buildTask([fauxAssistantMessage("ok")]);
		const res = await exec(task, { op: "continue", name: "ghost", prompt: "hi" });
		expect(isErr(res)).toBe(true);
		expect(textOf(res)).toContain("no continuable subagent");
	});
});
