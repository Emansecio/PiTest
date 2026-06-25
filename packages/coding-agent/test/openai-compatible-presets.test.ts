import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import {
	deriveProviderIdFromBaseUrl,
	getPresetProviderModels,
	isPresetProviderId,
	normalizeBaseUrl,
	persistOpenAICompatibleProviderToModelsJson,
	probeOpenAICompatibleConnection,
} from "../src/core/openai-compatible-presets.js";

describe("openai-compatible presets", () => {
	test("getPresetProviderModels exposes Z.ai GLM and Verboo models", () => {
		const models = getPresetProviderModels();
		const glm = models.find((m) => m.provider === "zai" && m.id === "glm-5.2");
		expect(glm).toBeDefined();
		expect(glm?.api).toBe("openai-completions");
		expect(glm?.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
		expect(glm?.contextWindow).toBe(1_000_000);
		expect(models.some((m) => m.provider === "verboo")).toBe(true);
	});

	test("isPresetProviderId recognizes preset ids only", () => {
		expect(isPresetProviderId("zai")).toBe(true);
		expect(isPresetProviderId("verboo")).toBe(true);
		expect(isPresetProviderId("anthropic")).toBe(false);
	});

	test("normalizeBaseUrl trims and strips trailing slashes", () => {
		expect(normalizeBaseUrl("  https://api.example.com/v1/// ")).toBe("https://api.example.com/v1");
		expect(normalizeBaseUrl("https://api.example.com")).toBe("https://api.example.com");
	});

	test("deriveProviderIdFromBaseUrl slugifies host and avoids collisions", () => {
		expect(deriveProviderIdFromBaseUrl("https://api.z.ai/api/coding/paas/v4")).toBe("api-z");
		expect(deriveProviderIdFromBaseUrl("https://code.verboo.ai/v1")).toBe("code-verboo");
		const taken = new Set(["code-verboo"]);
		expect(deriveProviderIdFromBaseUrl("https://code.verboo.ai/v1", taken)).toBe("code-verboo-2");
	});
});

describe("preset providers in the model registry", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-oai-presets-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	test("presets appear in getAll and resolve a friendly display name", () => {
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		expect(registry.getAll().some((m) => m.provider === "zai" && m.id === "glm-5.2")).toBe(true);
		expect(registry.getProviderDisplayName("zai")).toBe("Z.ai GLM (Coding Plan)");
	});

	test("a preset model becomes available only after a key is stored", () => {
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		expect(registry.getAvailable().some((m) => m.provider === "zai")).toBe(false);

		authStorage.set("zai", { type: "api_key", key: "test-key" });
		registry.refresh();

		expect(registry.getAvailable().some((m) => m.provider === "zai" && m.id === "glm-5.2")).toBe(true);
	});

	test("persisted custom provider loads from models.json without an inline apiKey", () => {
		persistOpenAICompatibleProviderToModelsJson(modelsJsonPath, "code-verboo", {
			name: "Verboo Code",
			baseUrl: "https://code.verboo.ai/v1",
			api: "openai-completions",
			models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
		});

		const written = JSON.parse(readFileSync(modelsJsonPath, "utf-8")) as {
			providers: Record<string, { login?: boolean; apiKey?: string }>;
		};
		expect(written.providers["code-verboo"]?.login).toBe(true);
		expect(written.providers["code-verboo"]?.apiKey).toBeUndefined();

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		// login:true means no inline key is required — no schema/validation error.
		expect(registry.getError()).toBeUndefined();
		expect(registry.getAll().some((m) => m.provider === "code-verboo" && m.id === "deepseek-v4-flash")).toBe(true);
		// Not usable until a key is stored, then it is.
		expect(registry.getAvailable().some((m) => m.provider === "code-verboo")).toBe(false);

		authStorage.set("code-verboo", { type: "api_key", key: "k" });
		registry.refresh();
		expect(registry.getAvailable().some((m) => m.provider === "code-verboo")).toBe(true);
	});

	test("injects curated GLM-5.2 into the built-in opencode-go provider (once, gated by auth)", () => {
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const glm52 = registry.getAll().filter((m) => m.provider === "opencode-go" && m.id === "glm-5.2");
		expect(glm52).toHaveLength(1); // present and not duplicated against the generated catalog
		expect(glm52[0]?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
		expect(glm52[0]?.api).toBe("openai-completions");
		expect(glm52[0]?.contextWindow).toBe(1_000_000); // opencode reports 1M for glm-5.2
		expect(glm52[0]?.maxTokens).toBe(131_072); // opencode reports 128k (131072) max output for glm-5.2

		// glm-5.2 only accepts two reasoning efforts ("high" and "max"), exposed as
		// the xhigh map. off/minimal/low/medium are nulled-out so the menu offers
		// just the two real modes (regression: previously Pi leaked all five).
		expect(glm52[0]?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: "max",
		});
		// The strict glm-5.2 backend rejects store/developer-role/max_completion_tokens
		// and the auto-enabled `prompt_cache_retention: "24h"` — opt out of all of them.
		const compat = glm52[0]?.compat as
			| {
					supportsLongCacheRetention?: boolean;
					supportsStore?: boolean;
					supportsDeveloperRole?: boolean;
					maxTokensField?: string;
			  }
			| undefined;
		expect(compat?.supportsLongCacheRetention).toBe(false);
		expect(compat?.supportsStore).toBe(false);
		expect(compat?.supportsDeveloperRole).toBe(false);
		expect(compat?.maxTokensField).toBe("max_tokens");

		// Gated by auth like every other opencode-go model.
		expect(registry.getAvailable().some((m) => m.provider === "opencode-go" && m.id === "glm-5.2")).toBe(false);
		authStorage.set("opencode-go", { type: "api_key", key: "k" });
		registry.refresh();
		expect(registry.getAvailable().some((m) => m.provider === "opencode-go" && m.id === "glm-5.2")).toBe(true);
	});
});

describe("probeOpenAICompatibleConnection", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("returns ok with model ids when GET /models succeeds", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			expect(url).toBe("https://api.example.com/v1/models");
			return new Response(JSON.stringify({ data: [{ id: "glm-5.2" }, { id: "glm-4.7" }] }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await probeOpenAICompatibleConnection({
			baseUrl: "https://api.example.com/v1",
			apiKey: "key",
			model: "glm-5.2",
		});
		expect(result.ok).toBe(true);
		expect(result.authRejected).toBe(false);
		expect(result.models).toEqual(["glm-5.2", "glm-4.7"]);
	});

	test("flags an explicit auth rejection (401)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unauthorized", { status: 401 })),
		);
		const result = await probeOpenAICompatibleConnection({
			baseUrl: "https://api.example.com/v1",
			apiKey: "bad",
			model: "glm-5.2",
		});
		expect(result.ok).toBe(false);
		expect(result.authRejected).toBe(true);
		expect(result.status).toBe(401);
	});

	test("falls back to a chat completion when /models is unavailable", async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/models")) {
				return new Response("not found", { status: 404 });
			}
			expect(url).toBe("https://api.example.com/v1/chat/completions");
			expect(init?.method).toBe("POST");
			return new Response(JSON.stringify({ choices: [] }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await probeOpenAICompatibleConnection({
			baseUrl: "https://api.example.com/v1",
			apiKey: "key",
			model: "glm-5.2",
		});
		expect(result.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("reports a failure when both probes fail", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		);
		const result = await probeOpenAICompatibleConnection({
			baseUrl: "https://api.example.com/v1",
			apiKey: "key",
			model: "glm-5.2",
		});
		expect(result.ok).toBe(false);
		expect(result.authRejected).toBe(false);
		expect(result.detail).toContain("ECONNREFUSED");
	});
});
