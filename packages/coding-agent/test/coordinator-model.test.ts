import { type Context, fauxAssistantMessage, type Model, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createCoordinatorExtension } from "../src/core/built-ins/coordinator-extension.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";

describe("coordinator selectable model view", () => {
	const registrations: Array<{ unregister(): void }> = [];
	afterEach(() => {
		for (const registration of registrations.splice(0)) registration.unregister();
	});

	function buildTask(parent: Model<any>, selectableModels: readonly Model<any>[]) {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(parent.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const extension = createCoordinatorExtension({
			modelRegistry,
			getParentModel: () => parent,
			getSelectableModels: () => selectableModels,
			getAvailableTools: () => [],
			convertToLlm,
		});
		let task:
			| { execute: (...args: unknown[]) => Promise<unknown>; parameters: unknown; description?: string }
			| undefined;
		extension({
			registerTool: (definition: { name: string }) => {
				if (definition.name === "task") task = definition as never;
			},
		} as never);
		return task!;
	}

	it("does not recommend a provider-specific model that may be unavailable", () => {
		const faux = registerFauxProvider({ provider: "custom-parent", models: [{ id: "working-parent" }] });
		registrations.push(faux);
		const parent = faux.getModel();
		const task = buildTask(parent, [parent]);
		const promptSurface = `${task.description ?? ""}\n${JSON.stringify(task.parameters)}`;

		expect(promptSurface).not.toMatch(/['"]haiku['"]/i);
		expect(promptSurface).toMatch(/inherit.*parent/i);
	});

	it("selects a second SDK scoped model that is absent from ModelRegistry", async () => {
		const faux = registerFauxProvider({ models: [{ id: "parent" }, { id: "sdk-only-one" }, { id: "sdk-only-two" }] });
		registrations.push(faux);
		const parent = faux.getModel("parent")!;
		const firstScoped = { ...faux.getModel("sdk-only-one")!, name: "first scoped object" };
		const secondScoped = { ...faux.getModel("sdk-only-two")!, name: "second scoped object" };
		let received: Model<any> | undefined;
		faux.setResponses([
			(_context: Context, _options, _state, model) => {
				received = model;
				return fauxAssistantMessage("selected");
			},
		]);
		const task = buildTask(parent, [firstScoped, secondScoped, parent]);

		const result = (await task.execute(
			"call",
			{ prompt: "use scoped", model: `${secondScoped.provider}/${secondScoped.id}` },
			undefined,
			undefined,
			{},
		)) as { isError: boolean };

		expect(result.isError).toBe(false);
		expect(received).toBe(secondScoped);
	});

	it.each(["openai-codex", "xai", "custom-parent"])(
		"stock explore inherits a %s parent instead of requiring haiku",
		async (provider) => {
			const faux = registerFauxProvider({ provider, models: [{ id: "working-parent" }] });
			registrations.push(faux);
			const parent = faux.getModel();
			let received: Model<any> | undefined;
			faux.setResponses([
				(_context, _options, _state, model) => {
					received = model;
					return fauxAssistantMessage("explored");
				},
			]);
			const task = buildTask(parent, [parent]);

			const result = (await task.execute(
				"call",
				{ prompt: "explore", type: "explore" },
				undefined,
				undefined,
				{},
			)) as { isError: boolean };

			expect(result.isError).toBe(false);
			expect(received).toBe(parent);
		},
	);
});
