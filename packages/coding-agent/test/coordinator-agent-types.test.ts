/**
 * Reusable agent types (.pit/agents/*.md) resolved by the coordinator's `task`
 * tool via `type: "<name>"`. Asserts the type's system prompt is applied, that
 * explicit fields override it, that unknown types error clearly, and that the
 * tool description advertises the available types for discovery.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createCoordinatorExtension } from "../src/core/built-ins/coordinator-extension.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";

describe("coordinator agent types", () => {
	let faux: FauxProviderRegistration | undefined;
	let root: string | undefined;
	afterEach(() => {
		faux?.unregister();
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	function writeType(file: string, content: string): void {
		if (!root) root = mkdtempSync(join(tmpdir(), "pit-ct-"));
		const dir = join(root, ".pit", "agents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, file), content);
	}

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
			getCwd: () => root ?? process.cwd(),
		});
		const tools: Record<string, { description?: string; execute: (...a: unknown[]) => Promise<unknown> }> = {};
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

	it("applies the agent type's system prompt to the spawned subagent", async () => {
		writeType("explorer.md", `---\nname: explorer\ndescription: read-only exploration\n---\nEXPLORER-SYSTEM-MARKER`);
		let captured = "";
		const task = buildTask([
			(ctx) => {
				captured = ctx.systemPrompt ?? "";
				return fauxAssistantMessage("done");
			},
		]);
		const res = await exec(task, { op: "run", type: "explorer", prompt: "go" });
		expect(isErr(res)).toBe(false);
		expect(captured).toContain("EXPLORER-SYSTEM-MARKER");
	});

	it("lets an explicit system_prompt override the type", async () => {
		writeType("explorer.md", `---\nname: explorer\n---\nTYPE-MARKER`);
		let captured = "";
		const task = buildTask([
			(ctx) => {
				captured = ctx.systemPrompt ?? "";
				return fauxAssistantMessage("done");
			},
		]);
		await exec(task, { op: "run", type: "explorer", system_prompt: "OVERRIDE-MARKER", prompt: "go" });
		expect(captured).toContain("OVERRIDE-MARKER");
		expect(captured).not.toContain("TYPE-MARKER");
	});

	it("errors clearly on an unknown agent type", async () => {
		writeType("explorer.md", `---\nname: explorer\n---\nbody`);
		const task = buildTask([fauxAssistantMessage("x")]);
		const res = await exec(task, { op: "run", type: "ghost", prompt: "go" });
		expect(isErr(res)).toBe(true);
		expect(textOf(res)).toContain("unknown agent type");
	});

	it("applies the agent type in the async op:spawn path too", async () => {
		writeType("explorer.md", `---\nname: explorer\n---\nSPAWN-TYPE-MARKER`);
		let captured = "";
		const task = buildTask([
			(ctx) => {
				captured = ctx.systemPrompt ?? "";
				return fauxAssistantMessage("spawn-done");
			},
		]);
		const sp = await exec(task, { op: "spawn", type: "explorer", name: "x", prompt: "go" });
		expect(isErr(sp)).toBe(false);
		const joined = await exec(task, { op: "join", handles: ["x"] });
		expect(captured).toContain("SPAWN-TYPE-MARKER");
		expect(textOf(joined)).toContain("spawn-done");
	});

	it("op:agents lists the loaded types with origin and attributes", async () => {
		writeType(
			"explorer.md",
			`---\nname: explorer\ndescription: read-only exploration\ntools: read, grep\nmodel: haiku\n---\nbody`,
		);
		const task = buildTask([fauxAssistantMessage("x")]);
		const res = await exec(task, { op: "agents" });
		expect(isErr(res)).toBe(false);
		const text = textOf(res);
		expect(text).toContain("explorer [project]");
		expect(text).toContain("read-only exploration");
		expect(text).toContain("tools: read, grep");
		expect(text).toContain("model: haiku");
	});

	it("advertises available types in the tool description", () => {
		writeType("explorer.md", `---\nname: explorer\ndescription: read-only exploration\n---\nbody`);
		const task = buildTask([fauxAssistantMessage("x")]);
		expect(task.description ?? "").toContain("explorer");
		expect(task.description ?? "").toContain("read-only exploration");
	});
});
