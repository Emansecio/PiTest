import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider, type StreamOptions } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("SDK coordinator request policy", () => {
	let cleanup: (() => Promise<void>) | undefined;
	afterEach(async () => cleanup?.());

	it("inherits parent request policy while defaulting only the subagent cache retention to short", async () => {
		const root = join(tmpdir(), `pit-sdk-sub-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const faux = registerFauxProvider({ provider: "sdk-policy", models: [{ id: "parent" }, { id: "scoped" }] });
		const parent = faux.getModel("parent")!;
		const scoped = { ...faux.getModel("scoped")!, name: "SDK scoped model" };
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(parent.provider, "policy-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(parent.provider, {
			apiKey: "policy-key",
			api: parent.api,
			baseUrl: parent.baseUrl,
			headers: { "x-registry": "registry" },
			// The second SDK-scoped model is deliberately absent from the registry.
			models: [parent].map((model) => ({
				id: model.id,
				name: model.name,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			})),
		});
		let afterResponses = 0;
		const settingsManager = SettingsManager.inMemory({
			transport: "sse",
			retry: { provider: { timeoutMs: 1234, maxRetries: 7, maxRetryDelayMs: 88, idleTimeoutMs: 4321 } },
			lsp: { enabled: false },
			frequentFiles: { enabled: false },
		});
		const services = await createAgentSessionServices({
			cwd: root,
			agentDir: root,
			authStorage,
			modelRegistry,
			settingsManager,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					(pi) => {
						pi.on("after_provider_response", () => {
							afterResponses++;
						});
					},
				],
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(root),
			model: parent,
			scopedModels: [{ model: parent }, { model: scoped }],
			cacheRetention: "long",
		});
		cleanup = async () => {
			await session.dispose();
			faux.unregister();
			if (existsSync(root)) rmSync(root, { recursive: true, force: true });
		};
		await session.bindExtensions({});
		const requestOptions: StreamOptions[] = [];
		faux.setResponses([
			(_context, options) => {
				requestOptions.push(options ?? {});
				return fauxAssistantMessage("parent policy retained");
			},
			(_context, options) => {
				requestOptions.push(options ?? {});
				return fauxAssistantMessage("policy inherited");
			},
		]);
		const task = session.agent.state.tools.find((tool) => tool.name === "task")!;

		await session.prompt("check parent request policy");
		const result = await task.execute("call", {
			prompt: "check request policy",
			model: `${scoped.provider}/${scoped.id}`,
		});

		expect(JSON.stringify(result.content)).toContain("policy inherited");
		expect(requestOptions[0]).toMatchObject({
			timeoutMs: 1234,
			maxRetries: 7,
			maxRetryDelayMs: 88,
			idleTimeoutMs: 4321,
			transport: "sse",
			cacheRetention: "long",
			headers: { "x-registry": "registry" },
		});
		expect(requestOptions[1]).toMatchObject({
			timeoutMs: 1234,
			maxRetries: 7,
			maxRetryDelayMs: 88,
			idleTimeoutMs: 4321,
			transport: "sse",
			cacheRetention: "short",
			headers: { "x-registry": "registry" },
		});
		expect(afterResponses).toBe(2);
	});

	it("selects an SDK-scoped model on a different provider that is absent from the registry", async () => {
		const root = join(tmpdir(), `pit-sdk-cross-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const parentProvider = registerFauxProvider({ provider: "sdk-parent-a", models: [{ id: "parent-a" }] });
		const scopedProvider = registerFauxProvider({ provider: "sdk-scoped-b", models: [{ id: "scoped-b" }] });
		const parent = parentProvider.getModel();
		const scoped = scopedProvider.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(parent.provider, "parent-key");
		authStorage.setRuntimeApiKey(scoped.provider, "scoped-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const services = await createAgentSessionServices({
			cwd: root,
			agentDir: root,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory({ lsp: { enabled: false }, frequentFiles: { enabled: false } }),
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(root),
			model: parent,
			scopedModels: [{ model: parent }, { model: scoped }],
		});
		cleanup = async () => {
			await session.dispose();
			parentProvider.unregister();
			scopedProvider.unregister();
			if (existsSync(root)) rmSync(root, { recursive: true, force: true });
		};
		await session.bindExtensions({});
		let receivedModel: typeof scoped | undefined;
		scopedProvider.setResponses([
			(_context, _options, _state, model) => {
				receivedModel = model;
				return fauxAssistantMessage("cross-provider scoped selected");
			},
		]);
		const task = session.agent.state.tools.find((tool) => tool.name === "task")!;

		const result = await task.execute("call", {
			prompt: "use provider B",
			model: `${scoped.provider}/${scoped.id}`,
		});

		expect(JSON.stringify(result.content)).toContain("cross-provider scoped selected");
		expect(receivedModel).toBe(scoped);
		expect(parentProvider.state.callCount).toBe(0);
	});

	it("cancels a detached child stalled in before_provider_request without aborting the parent", async () => {
		const root = join(tmpdir(), `pit-sdk-child-hook-abort-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		const faux = registerFauxProvider({ provider: "sdk-child-hook-abort", models: [{ id: "parent" }] });
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "policy-key");
		let markHookStarted: (() => void) | undefined;
		const hookStarted = new Promise<void>((resolve) => {
			markHookStarted = resolve;
		});
		let releaseHook: (() => void) | undefined;
		const hookRelease = new Promise<void>((resolve) => {
			releaseHook = resolve;
		});
		const services = await createAgentSessionServices({
			cwd: root,
			agentDir: root,
			authStorage,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			settingsManager: SettingsManager.inMemory({ lsp: { enabled: false }, frequentFiles: { enabled: false } }),
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					(pi) => {
						pi.on("before_provider_request", async () => {
							markHookStarted?.();
							await hookRelease;
						});
					},
				],
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(root),
			model,
		});
		cleanup = async () => {
			releaseHook?.();
			await Promise.race([session.dispose(), new Promise((resolve) => setTimeout(resolve, 1000))]);
			faux.unregister();
			if (existsSync(root)) rmSync(root, { recursive: true, force: true });
		};
		await session.bindExtensions({});
		const parentStreamFn = session.agent.streamFn;
		session.agent.streamFn = async (requestModel, context, options) => {
			await options?.onPayload?.({}, requestModel);
			return parentStreamFn(requestModel, context, { ...options, onPayload: undefined });
		};
		faux.setResponses([fauxAssistantMessage("must not complete before cancellation")]);
		const task = session.agent.state.tools.find((tool) => tool.name === "task")!;
		await task.execute("spawn", { op: "spawn", name: "hook-stall", prompt: "wait" });
		await Promise.race([
			hookStarted,
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error("child never entered before_provider_request")), 2000);
			}),
		]);

		await task.execute("cancel", { op: "cancel", handles: ["hook-stall"] });
		const joined = task.execute("join", { op: "join", handles: ["hook-stall"] });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const settled = await Promise.race([
				joined,
				new Promise<undefined>((resolve) => {
					timer = setTimeout(() => resolve(undefined), 1000);
				}),
			]);
			expect(settled).toBeDefined();
			expect(session.agent.signal?.aborted).not.toBe(true);
		} finally {
			if (timer) clearTimeout(timer);
			releaseHook?.();
			await Promise.race([joined, new Promise((resolve) => setTimeout(resolve, 1000))]);
		}
	});
});
