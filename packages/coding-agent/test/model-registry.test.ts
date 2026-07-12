import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnthropicMessagesCompat, Api, Context, Model, OpenAICompletionsCompat } from "@pit/ai";
import { getApiProvider } from "@pit/ai";
import { getOAuthProvider } from "@pit/ai/oauth";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { clearApiKeyCache, ModelRegistry, type ProviderConfigInput } from "../src/core/model-registry.js";

describe("ModelRegistry", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-model-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearApiKeyCache();
		delete process.env.PIT_CONFIG_COMMAND_TTL_MS;
	});

	/** Create minimal provider config  */
	function providerConfig(
		baseUrl: string,
		models: Array<{ id: string; name?: string }>,
		api: string = "anthropic-messages",
	): ProviderConfigInput {
		return {
			baseUrl,
			apiKey: "TEST_KEY",
			api: api as Api,
			models: models.map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 8000,
			})),
		};
	}

	function writeModelsJson(providers: Record<string, ReturnType<typeof providerConfig>>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function getModelsForProvider(registry: ModelRegistry, provider: string) {
		return registry.getAll().filter((m) => m.provider === provider);
	}

	/** Create a baseUrl-only override (no custom models) */
	function overrideConfig(baseUrl: string, headers?: Record<string, string>) {
		return { baseUrl, ...(headers && { headers }) };
	}

	/** Write raw providers config (for mixed override/replacement scenarios) */
	function writeRawModelsJson(providers: Record<string, unknown>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	const openAiModel: Model<Api> = {
		id: "test-openai-model",
		name: "Test OpenAI Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};

	const emptyContext: Context = {
		messages: [],
	};

	describe("baseUrl override (no custom models)", () => {
		test("overriding baseUrl keeps all built-in models", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// Should have multiple built-in models, not just one
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});

		test("overriding baseUrl changes URL on all built-in models", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// All models should have the new baseUrl
			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://my-proxy.example.com/v1");
			}
		});

		test("overriding headers resolves at request time", async () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1", {
					"X-Custom-Header": "custom-value",
				}),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				const auth = await registry.getApiKeyAndHeaders(model);
				expect(auth.ok).toBe(true);
				if (auth.ok) {
					expect(auth.headers?.["X-Custom-Header"]).toBe("custom-value");
				}
			}
		});

		test("headers-only override resolves at request time", async () => {
			writeRawModelsJson({
				anthropic: {
					headers: {
						"X-Custom-Header": "custom-value",
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(registry.getError()).toBeUndefined();
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				const auth = await registry.getApiKeyAndHeaders(model);
				expect(auth.ok).toBe(true);
				if (auth.ok) {
					expect(auth.headers?.["X-Custom-Header"]).toBe("custom-value");
				}
			}
		});

		test("baseUrl-only override does not affect other providers", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const opencodeModels = getModelsForProvider(registry, "opencode");

			// OpenCode models should still have their original baseUrl
			expect(opencodeModels.length).toBeGreaterThan(0);
			expect(opencodeModels[0].baseUrl).not.toBe("https://my-proxy.example.com/v1");
		});

		test("can mix baseUrl override and models merge", () => {
			writeRawModelsJson({
				// baseUrl-only for anthropic
				anthropic: overrideConfig("https://anthropic-proxy.example.com/v1"),
				// Add custom model for opencode (merged with built-ins)
				opencode: providerConfig(
					"https://opencode-proxy.example.com/v1",
					[{ id: "opencode-custom" }],
					"openai-completions",
				),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			// Anthropic: multiple built-in models with new baseUrl
			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels[0].baseUrl).toBe("https://anthropic-proxy.example.com/v1");

			// OpenCode: built-ins plus custom model
			const opencodeModels = getModelsForProvider(registry, "opencode");
			expect(opencodeModels.length).toBeGreaterThan(1);
			expect(opencodeModels.some((m) => m.id === "opencode-custom")).toBe(true);
		});

		test("refresh() picks up baseUrl override changes", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://first-proxy.example.com/v1"),
			});
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://first-proxy.example.com/v1");

			// Update and refresh
			writeRawModelsJson({
				anthropic: overrideConfig("https://second-proxy.example.com/v1"),
			});
			registry.refresh();

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://second-proxy.example.com/v1");
		});
	});

	describe("custom models merge behavior", () => {
		test("built-in provider custom models inherit api and baseUrl without explicit fields", () => {
			// Built-in providers already have api/baseUrl on every model, and auth
			// comes from env vars / auth storage. No need to specify them.
			writeRawModelsJson({
				opencode: {
					models: [
						{
							id: "fake-provider/fake-model",
							name: "Fake model",
							reasoning: true,
							input: ["text"],
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(registry.getError()).toBeUndefined();

			const model = registry.find("opencode", "fake-provider/fake-model");
			expect(model).toBeDefined();
			expect(model?.api).toBe("openai-completions");
			expect(model?.baseUrl).toBe("https://opencode.ai/zen/v1");
		});

		test("non-built-in provider custom models still require baseUrl and apiKey", () => {
			writeRawModelsJson({
				"my-custom-provider": {
					models: [
						{
							id: "my-model",
							api: "openai-completions",
							reasoning: false,
							input: ["text"],
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(registry.getError()).toContain("baseUrl");
		});

		test("custom provider with same name as built-in merges with built-in models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some((m) => m.id === "claude-custom")).toBe(true);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});

		test("custom model with same id replaces built-in model by id", () => {
			writeModelsJson({
				opencode: providerConfig(
					"https://my-proxy.example.com/v1",
					[{ id: "claude-sonnet-4-5" }],
					"openai-completions",
				),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "opencode");
			const sonnetModels = models.filter((m) => m.id === "claude-sonnet-4-5");

			expect(sonnetModels).toHaveLength(1);
			expect(sonnetModels[0].baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom provider with same name as built-in does not affect other built-in providers", () => {
			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "opencode").length).toBeGreaterThan(0);
			expect(getModelsForProvider(registry, "xai").length).toBeGreaterThan(0);
		});

		test("provider-level baseUrl applies to both built-in and custom models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://merged-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://merged-proxy.example.com/v1");
			}
		});

		test("provider-level compat applies to custom models", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.supportsUsageInStreaming).toBe(false);
			expect(compat?.maxTokensField).toBe("max_tokens");
		});

		test("model-level compat overrides provider-level compat for custom models", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								supportsUsageInStreaming: true,
								maxTokensField: "max_completion_tokens",
							},
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.supportsUsageInStreaming).toBe(true);
			expect(compat?.maxTokensField).toBe("max_completion_tokens");
		});

		test("provider-level compat applies to built-in models", () => {
			writeRawModelsJson({
				opencode: {
					compat: {
						supportsUsageInStreaming: false,
						supportsStrictMode: false,
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "opencode");

			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				const compat = model.compat as OpenAICompletionsCompat | undefined;
				expect(compat?.supportsUsageInStreaming).toBe(false);
				expect(compat?.supportsStrictMode).toBe(false);
			}
		});

		test("model schema accepts thinkingLevelMap and compat schema accepts supportsStrictMode and cacheControlFormat", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					models: [
						{
							id: "demo-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							thinkingLevelMap: {
								minimal: null,
								high: "max",
							},
							compat: {
								supportsStrictMode: false,
								cacheControlFormat: "anthropic",
							},
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const model = registry.find("demo", "demo-model");
			const compat = model?.compat as OpenAICompletionsCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(model?.thinkingLevelMap).toEqual({ minimal: null, high: "max" });
			expect(compat?.supportsStrictMode).toBe(false);
			expect(compat?.cacheControlFormat).toBe("anthropic");
		});

		test("compat schema accepts Anthropic eager tool input streaming flag", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com",
					apiKey: "DEMO_KEY",
					api: "anthropic-messages",
					compat: {
						supportsEagerToolInputStreaming: false,
					},
					models: [
						{
							id: "demo-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as AnthropicMessagesCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(compat?.supportsEagerToolInputStreaming).toBe(false);
		});

		test("compat schema accepts long cache retention flag", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com",
					apiKey: "DEMO_KEY",
					api: "anthropic-messages",
					compat: {
						supportsLongCacheRetention: false,
					},
					models: [
						{
							id: "demo-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as AnthropicMessagesCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(compat?.supportsLongCacheRetention).toBe(false);
		});

		test("model-level baseUrl overrides provider-level baseUrl for custom models", () => {
			writeRawModelsJson({
				"opencode-go": {
					baseUrl: "https://opencode.ai/zen/go/v1",
					apiKey: "TEST_KEY",
					models: [
						{
							id: "minimax-m2.5",
							api: "anthropic-messages",
							baseUrl: "https://opencode.ai/zen/go",
							reasoning: true,
							input: ["text"],
							cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
						{
							id: "glm-5",
							api: "openai-completions",
							reasoning: true,
							input: ["text"],
							cost: { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const m25 = registry.find("opencode-go", "minimax-m2.5");
			const glm5 = registry.find("opencode-go", "glm-5");

			expect(m25?.baseUrl).toBe("https://opencode.ai/zen/go");
			expect(glm5?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
		});

		test("modelOverrides still apply when provider also defines models", () => {
			writeRawModelsJson({
				opencode: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "OPENCODE_API_KEY",
					api: "openai-completions",
					models: [
						{
							id: "custom/opencode-model",
							name: "Custom OpenCode Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 16384,
						},
					],
					modelOverrides: {
						"claude-sonnet-4-5": {
							name: "Overridden Built-in Sonnet",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "opencode");

			expect(models.some((m) => m.id === "custom/opencode-model")).toBe(true);
			expect(
				models.some((m) => m.id === "claude-sonnet-4-5" && m.name === "Overridden Built-in Sonnet"),
			).toBe(true);
		});

		test("refresh() reloads merged custom models from disk", () => {
			writeModelsJson({
				anthropic: providerConfig("https://first-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, "anthropic").some((m) => m.id === "claude-custom")).toBe(true);

			// Update and refresh
			writeModelsJson({
				anthropic: providerConfig("https://second-proxy.example.com/v1", [{ id: "claude-custom-2" }]),
			});
			registry.refresh();

			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.some((m) => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some((m) => m.id === "claude-custom-2")).toBe(true);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});

		test("removing custom models from models.json keeps built-in provider models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, "anthropic").some((m) => m.id === "claude-custom")).toBe(true);

			// Remove custom models and refresh
			writeModelsJson({});
			registry.refresh();

			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.some((m) => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});
	});

	describe("modelOverrides (per-model customization)", () => {
		test("model override applies to a single built-in model", () => {
			writeRawModelsJson({
				opencode: {
					modelOverrides: {
						"claude-sonnet-4-5": {
							name: "Custom Sonnet Name",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "opencode");

			const sonnet = models.find((m) => m.id === "claude-sonnet-4-5");
			expect(sonnet?.name).toBe("Custom Sonnet Name");

			// Other models should be unchanged
			const opus = models.find((m) => m.id === "claude-opus-4-5");
			expect(opus?.name).not.toBe("Custom Sonnet Name");
		});

		test("model override with compat.openRouterRouting", () => {
			writeRawModelsJson({
				opencode: {
					modelOverrides: {
						"claude-sonnet-4-5": {
							compat: {
								openRouterRouting: { only: ["amazon-bedrock"] },
							},
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "opencode");

			const sonnet = models.find((m) => m.id === "claude-sonnet-4-5");
			const compat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
		});

		test("model override deep merges compat settings", () => {
			writeRawModelsJson({
				opencode: {
					modelOverrides: {
						"claude-sonnet-4-5": {
							compat: {
								openRouterRouting: { order: ["anthropic", "together"] },
							},
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "opencode");
			const sonnet = models.find((m) => m.id === "claude-sonnet-4-5");

			// Should have both the new routing AND preserve other compat settings
			const compat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ order: ["anthropic", "together"] });
		});

		test("multiple model overrides on same provider", () => {
			writeRawModelsJson({
				opencode: {
					modelOverrides: {
						"claude-sonnet-4-5": {
							compat: { openRouterRouting: { only: ["amazon-bedrock"] } },
						},
						"claude-opus-4-5": {
							compat: { openRouterRouting: { only: ["anthropic"] } },
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "opencode");

			const sonnet = models.find((m) => m.id === "claude-sonnet-4-5");
			const opus = models.find((m) => m.id === "claude-opus-4-5");

			const sonnetCompat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			const opusCompat = opus?.compat as OpenAICompletionsCompat | undefined;
			expect(sonnetCompat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
			expect(opusCompat?.openRouterRouting).toEqual({ only: ["anthropic"] });
		});

		test("model override combined with baseUrl override", () => {
			writeRawModelsJson({
				opencode: {
					baseUrl: "https://my-proxy.example.com/v1",
					modelOverrides: {
						"claude-sonnet-4-5": {
							name: "Proxied Sonnet",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "opencode");
			const sonnet = models.find((m) => m.id === "claude-sonnet-4-5");

			// Both overrides should apply
			expect(sonnet?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(sonnet?.name).toBe("Proxied Sonnet");

			// Other models should have the baseUrl but not the name override
			const opus = models.find((m) => m.id === "claude-opus-4-5");
			expect(opus?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(opus?.name).not.toBe("Proxied Sonnet");
		});

		test("model override for non-existent model ID is ignored", () => {
			writeRawModelsJson({
				opencode: {
					modelOverrides: {
						"nonexistent/model-id": {
							name: "This should not appear",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "opencode");

			// Should not create a new model
			expect(models.find((m) => m.id === "nonexistent/model-id")).toBeUndefined();
			// Should not crash or show error
			expect(registry.getError()).toBeUndefined();
		});

		test("model override can change cost fields partially", () => {
			writeRawModelsJson({
				opencode: {
					modelOverrides: {
						"claude-sonnet-4-5": {
							cost: { input: 99 },
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "opencode");
			const sonnet = models.find((m) => m.id === "claude-sonnet-4-5");

			// Input cost should be overridden
			expect(sonnet?.cost.input).toBe(99);
			// Other cost fields should be preserved from built-in
			expect(sonnet?.cost.output).toBeGreaterThan(0);
		});

		test("model override can add headers at request time", async () => {
			writeRawModelsJson({
				opencode: {
					modelOverrides: {
						"claude-sonnet-4-5": {
							headers: { "X-Custom-Model-Header": "value" },
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "opencode");
			const sonnet = models.find((m) => m.id === "claude-sonnet-4-5");
			expect(sonnet).toBeDefined();

			const auth = await registry.getApiKeyAndHeaders(sonnet!);
			expect(auth.ok).toBe(true);
			if (auth.ok) {
				expect(auth.headers?.["X-Custom-Model-Header"]).toBe("value");
			}
		});

		test("refresh() picks up model override changes", () => {
			writeRawModelsJson({
				opencode: {
					modelOverrides: {
						"claude-sonnet-4-5": {
							name: "First Name",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(
				getModelsForProvider(registry, "opencode").find((m) => m.id === "claude-sonnet-4-5")?.name,
			).toBe("First Name");

			// Update and refresh
			writeRawModelsJson({
				opencode: {
					modelOverrides: {
						"claude-sonnet-4-5": {
							name: "Second Name",
						},
					},
				},
			});
			registry.refresh();

			expect(
				getModelsForProvider(registry, "opencode").find((m) => m.id === "claude-sonnet-4-5")?.name,
			).toBe("Second Name");
		});

		test("removing model override restores built-in values", () => {
			writeRawModelsJson({
				opencode: {
					modelOverrides: {
						"claude-sonnet-4-5": {
							name: "Custom Name",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const customName = getModelsForProvider(registry, "opencode").find(
				(m) => m.id === "claude-sonnet-4-5",
			)?.name;
			expect(customName).toBe("Custom Name");

			// Remove override and refresh
			writeRawModelsJson({});
			registry.refresh();

			const restoredName = getModelsForProvider(registry, "opencode").find(
				(m) => m.id === "claude-sonnet-4-5",
			)?.name;
			expect(restoredName).not.toBe("Custom Name");
		});
	});

	describe("dynamic provider lifecycle", () => {
		test("getProviderDisplayName resolves registered, OAuth, built-in, and fallback names", () => {
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			expect(registry.getProviderDisplayName("opencode")).toBe("OpenCode Zen");
			expect(registry.getProviderDisplayName("opencode-go")).toBe("OpenCode Go");
			expect(registry.getProviderDisplayName("unknown-provider")).toBe("unknown-provider");

			registry.registerProvider("named-provider", {
				name: "Named Provider",
				baseUrl: "https://provider.test/v1",
				apiKey: "TEST_KEY",
				api: "openai-completions",
				models: [
					{
						id: "demo-model",
						name: "Demo Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});
			expect(registry.getProviderDisplayName("named-provider")).toBe("Named Provider");

			registry.registerProvider("oauth-provider", {
				baseUrl: "https://provider.test/v1",
				api: "openai-completions",
				oauth: {
					name: "OAuth Provider",
					login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => credentials.access,
				},
				models: [
					{
						id: "demo-model",
						name: "Demo Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});
			expect(registry.getProviderDisplayName("oauth-provider")).toBe("OAuth Provider");
		});

		test("failed registerProvider does not persist invalid streamSimple config", () => {
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			expect(() =>
				registry.registerProvider("broken-provider", {
					streamSimple: (() => {
						throw new Error("should not run");
					}) as any,
				}),
			).toThrow('Provider broken-provider: "api" is required when registering streamSimple.');

			expect(() => registry.refresh()).not.toThrow();
		});

		test("failed registerProvider does not remove existing provider models", () => {
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			registry.registerProvider("demo-provider", {
				baseUrl: "https://provider.test/v1",
				apiKey: "TEST_KEY",
				api: "openai-completions",
				models: [
					{
						id: "demo-model",
						name: "Demo Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});

			expect(registry.find("demo-provider", "demo-model")).toBeDefined();

			expect(() =>
				registry.registerProvider("demo-provider", {
					baseUrl: "https://provider.test/v2",
					apiKey: "TEST_KEY",
					models: [
						{
							id: "broken-model",
							name: "Broken Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				}),
			).toThrow('Provider demo-provider, model broken-model: no "api" specified.');

			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
			expect(() => registry.refresh()).not.toThrow();
			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
		});

		test("unregisterProvider removes custom OAuth provider and restores built-in OAuth provider", () => {
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			registry.registerProvider("anthropic", {
				oauth: {
					name: "Custom Anthropic OAuth",
					login: async () => ({
						access: "custom-access-token",
						refresh: "custom-refresh-token",
						expires: Date.now() + 60_000,
					}),
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => credentials.access,
				},
			});

			expect(getOAuthProvider("anthropic")?.name).toBe("Custom Anthropic OAuth");

			registry.unregisterProvider("anthropic");

			expect(getOAuthProvider("anthropic")?.name).not.toBe("Custom Anthropic OAuth");
		});

		test("unregisterProvider removes custom streamSimple override and restores built-in API stream handler", () => {
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			registry.registerProvider("stream-override-provider", {
				api: "openai-completions",
				streamSimple: () => {
					throw new Error("custom streamSimple override");
				},
			});

			let threwCustomOverride = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverride = error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverride).toBe(true);

			registry.unregisterProvider("stream-override-provider");

			let threwCustomOverrideAfterUnregister = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverrideAfterUnregister =
					error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverrideAfterUnregister).toBe(false);
		});

		describe("dynamic provider override persistence", () => {
			test("baseUrl-only override keeps built-in provider models after refresh", () => {
				const registry = ModelRegistry.create(authStorage, modelsJsonPath);

				registry.registerProvider("anthropic", { baseUrl: "https://proxy.test/anthropic" });
				registry.refresh();

				const anthropicModels = getModelsForProvider(registry, "anthropic");
				expect(anthropicModels.length).toBeGreaterThan(1);
				expect(anthropicModels.every((m) => m.baseUrl === "https://proxy.test/anthropic")).toBe(true);
			});

			test("models-only override replaces built-in provider models after refresh", () => {
				const registry = ModelRegistry.create(authStorage, modelsJsonPath);

				registry.registerProvider("anthropic", {
					...providerConfig("https://custom.test/anthropic", [{ id: "custom-claude" }], "anthropic-messages"),
					baseUrl: "https://custom.test/anthropic",
				});
				registry.refresh();

				expect(getModelsForProvider(registry, "anthropic").map((m) => m.id)).toEqual(["custom-claude"]);
				expect(registry.find("anthropic", "custom-claude")?.baseUrl).toBe("https://custom.test/anthropic");
			});

			test("models plus baseUrl override replaces built-in provider models after refresh", () => {
				const registry = ModelRegistry.create(authStorage, modelsJsonPath);

				registry.registerProvider("anthropic", {
					...providerConfig("https://custom.test/anthropic", [{ id: "custom-claude" }], "anthropic-messages"),
					baseUrl: "https://custom.test/anthropic",
				});
				registry.registerProvider("anthropic", { baseUrl: "https://proxy.test/anthropic" });
				registry.refresh();

				expect(getModelsForProvider(registry, "anthropic").map((m) => m.id)).toEqual(["custom-claude"]);
				expect(registry.find("anthropic", "custom-claude")?.baseUrl).toBe("https://proxy.test/anthropic");
			});

			test("models-only custom provider registration survives refresh", () => {
				const registry = ModelRegistry.create(authStorage, modelsJsonPath);

				registry.registerProvider(
					"custom-provider",
					providerConfig("https://custom.test/v1", [{ id: "custom-a" }, { id: "custom-b" }], "openai-completions"),
				);
				registry.refresh();

				expect(getModelsForProvider(registry, "custom-provider").map((m) => m.id)).toEqual([
					"custom-a",
					"custom-b",
				]);
			});

			test("baseUrl-only override keeps custom provider models after refresh", () => {
				const registry = ModelRegistry.create(authStorage, modelsJsonPath);

				registry.registerProvider(
					"custom-provider",
					providerConfig("https://custom.test/v1", [{ id: "custom-a" }, { id: "custom-b" }], "openai-completions"),
				);
				registry.registerProvider("custom-provider", { baseUrl: "https://proxy.test/custom" });
				registry.refresh();

				expect(getModelsForProvider(registry, "custom-provider").map((m) => m.id)).toEqual([
					"custom-a",
					"custom-b",
				]);
				expect(
					getModelsForProvider(registry, "custom-provider").every(
						(m) => m.baseUrl === "https://proxy.test/custom",
					),
				).toBe(true);
			});

			test("headers-only override keeps custom provider models after refresh", async () => {
				const registry = ModelRegistry.create(authStorage, modelsJsonPath);

				registry.registerProvider(
					"custom-provider",
					providerConfig("https://custom.test/v1", [{ id: "custom-a" }, { id: "custom-b" }], "openai-completions"),
				);
				registry.registerProvider("custom-provider", { headers: { "x-proxy": "enabled" } });
				registry.refresh();

				const models = getModelsForProvider(registry, "custom-provider");
				expect(models.map((m) => m.id)).toEqual(["custom-a", "custom-b"]);
				expect(models.every((m) => m.baseUrl === "https://custom.test/v1")).toBe(true);
				expect(await registry.getApiKeyAndHeaders(models[0])).toMatchObject({
					ok: true,
					headers: { "x-proxy": "enabled" },
				});
			});
		});
	});

	describe("API key resolution", () => {
		/** Create provider config with custom apiKey */
		function providerWithApiKey(apiKey: string) {
			return {
				baseUrl: "https://example.com/v1",
				apiKey,
				api: "anthropic-messages",
				models: [
					{
						id: "test-model",
						name: "Test Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 100000,
						maxTokens: 8000,
					},
				],
			};
		}

		test("apiKey as environment variable name resolves to env value", async () => {
			const originalEnv = process.env.TEST_API_KEY_12345;
			process.env.TEST_API_KEY_12345 = "env-api-key-value";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("TEST_API_KEY_12345"),
				});

				const registry = ModelRegistry.create(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_API_KEY_12345;
				} else {
					process.env.TEST_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			// Make sure this isn't an env var
			delete process.env.literal_api_key_value;

			writeRawModelsJson({
				"custom-provider": providerWithApiKey("literal_api_key_value"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("literal_api_key_value");
		});

		describe("request-time resolution", () => {
			test("provider auth status reports apiKey environment variables from models.json", () => {
				const envVarName = "TEST_API_KEY_STATUS_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "status-test-key";

					writeRawModelsJson({
						"custom-provider": providerWithApiKey(envVarName),
					});

					const registry = ModelRegistry.create(authStorage, modelsJsonPath);

					expect(registry.getProviderAuthStatus("custom-provider")).toEqual({
						configured: true,
						source: "environment",
						label: envVarName,
					});
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});

			test("provider auth status reports non-env apiKey values from models.json as a config key", () => {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("literal_api_key_value"),
				});

				const registry = ModelRegistry.create(authStorage, modelsJsonPath);

				expect(registry.getProviderAuthStatus("custom-provider")).toEqual({
					configured: true,
					source: "models_json_key",
				});
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_API_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeRawModelsJson({
						"custom-provider": providerWithApiKey(envVarName),
					});

					const registry = ModelRegistry.create(authStorage, modelsJsonPath);

					const key1 = await registry.getApiKeyForProvider("custom-provider");
					expect(key1).toBe("first-value");

					process.env[envVarName] = "second-value";

					const key2 = await registry.getApiKeyForProvider("custom-provider");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});
		});

		describe("scoped-model auth filtering", () => {
			test("filterScopedModels keeps only entries with configured auth", () => {
				writeModelsJson({
					authed: providerConfig("https://authed.example.com", [{ id: "m1", name: "Authed One" }]),
				});
				const registry = ModelRegistry.create(authStorage, modelsJsonPath);
				registry.refresh();
				const authedModel = registry.find("authed", "m1");
				const unauthedModel = {
					id: "ghost",
					name: "Ghost Model",
					provider: "ghost-provider",
					api: "openai-completions" as const,
					baseUrl: "https://ghost.example.com/v1",
					reasoning: false,
					input: ["text"] as ("text" | "image")[],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				};
				expect(authedModel).toBeDefined();
				expect(registry.hasConfiguredAuth(authedModel!)).toBe(true);
				expect(registry.hasConfiguredAuth(unauthedModel)).toBe(false);

				const filtered = registry.filterScopedModels([
					{ model: authedModel!, thinkingLevel: "off" },
					{ model: unauthedModel, thinkingLevel: "high" },
				]);
				expect(filtered).toHaveLength(1);
				expect(filtered[0]?.model.provider).toBe("authed");
			});
		});
	});
});
