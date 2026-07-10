/**
 * Shell-spawn coverage for ModelRegistry `!command` apiKey resolution.
 * Kept out of the unit subset (see vitest.unit.config.ts).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { clearApiKeyCache, ModelRegistry } from "../src/core/model-registry.js";

describe("ModelRegistry shell !command resolution", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-model-registry-shell-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	function writeRawModelsJson(providers: Record<string, unknown>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

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

	test("apiKey with ! prefix executes command and uses stdout", async () => {
		writeRawModelsJson({
			"custom-provider": providerWithApiKey("!echo test-api-key-from-command"),
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const apiKey = await registry.getApiKeyForProvider("custom-provider");

		expect(apiKey).toBe("test-api-key-from-command");
	});

	test("apiKey with ! prefix trims whitespace from command output", async () => {
		writeRawModelsJson({
			"custom-provider": providerWithApiKey("!echo '  spaced-key  '"),
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const apiKey = await registry.getApiKeyForProvider("custom-provider");

		expect(apiKey).toBe("spaced-key");
	});

	test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
		writeRawModelsJson({
			"custom-provider": providerWithApiKey("!printf 'line1\\nline2'"),
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const apiKey = await registry.getApiKeyForProvider("custom-provider");

		expect(apiKey).toBe("line1\nline2");
	});

	test("apiKey with ! prefix returns undefined on command failure", async () => {
		writeRawModelsJson({
			"custom-provider": providerWithApiKey("!exit 1"),
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const apiKey = await registry.getApiKeyForProvider("custom-provider");

		expect(apiKey).toBeUndefined();
	});

	test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
		writeRawModelsJson({
			"custom-provider": providerWithApiKey("!nonexistent-command-12345"),
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const apiKey = await registry.getApiKeyForProvider("custom-provider");

		expect(apiKey).toBeUndefined();
	});

	test("apiKey with ! prefix returns undefined on empty output", async () => {
		writeRawModelsJson({
			"custom-provider": providerWithApiKey("!printf ''"),
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const apiKey = await registry.getApiKeyForProvider("custom-provider");

		expect(apiKey).toBeUndefined();
	});

	test("apiKey command can use shell features like pipes", async () => {
		writeRawModelsJson({
			"custom-provider": providerWithApiKey("!echo 'hello world' | tr ' ' '-'"),
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const apiKey = await registry.getApiKeyForProvider("custom-provider");

		expect(apiKey).toBe("hello-world");
	});

	test("command is memoised across lookups within the TTL window", async () => {
		const counterFile = join(tempDir, "counter");
		writeFileSync(counterFile, "0");

		const counterPath = toShPath(counterFile);
		const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
		writeRawModelsJson({
			"custom-provider": providerWithApiKey(command),
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.getApiKeyForProvider("custom-provider");
		await registry.getApiKeyForProvider("custom-provider");
		await registry.getApiKeyForProvider("custom-provider");

		const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
		expect(count).toBe(1);
	});

	test("command memo is shared across registry instances within the TTL window", async () => {
		const counterFile = join(tempDir, "counter");
		writeFileSync(counterFile, "0");

		const counterPath = toShPath(counterFile);
		const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
		writeRawModelsJson({
			"custom-provider": providerWithApiKey(command),
		});

		const registry1 = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry1.getApiKeyForProvider("custom-provider");

		const registry2 = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry2.getApiKeyForProvider("custom-provider");

		const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
		expect(count).toBe(1);
	});

	test("different commands resolve independently", async () => {
		writeRawModelsJson({
			"provider-a": providerWithApiKey("!echo key-a"),
			"provider-b": providerWithApiKey("!echo key-b"),
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);

		const keyA = await registry.getApiKeyForProvider("provider-a");
		const keyB = await registry.getApiKeyForProvider("provider-b");

		expect(keyA).toBe("key-a");
		expect(keyB).toBe("key-b");
	});

	test("failed commands are retried", async () => {
		const counterFile = join(tempDir, "counter");
		writeFileSync(counterFile, "0");

		const counterPath = toShPath(counterFile);
		const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
		writeRawModelsJson({
			"custom-provider": providerWithApiKey(command),
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const key1 = await registry.getApiKeyForProvider("custom-provider");
		const key2 = await registry.getApiKeyForProvider("custom-provider");

		expect(key1).toBeUndefined();
		expect(key2).toBeUndefined();

		const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
		expect(count).toBe(2);
	});

	test("provider auth status reports command apiKey values from models.json without executing them", () => {
		const counterFile = join(tempDir, "status-counter");
		writeFileSync(counterFile, "0");
		const counterPath = toShPath(counterFile);
		const command = `!sh -c 'echo 1 > "${counterPath}"; echo key-value'`;
		writeRawModelsJson({
			"custom-provider": providerWithApiKey(command),
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);

		expect(registry.getProviderAuthStatus("custom-provider")).toEqual({
			configured: true,
			source: "models_json_command",
		});
		expect(readFileSync(counterFile, "utf-8")).toBe("0");
	});

	test("getAvailable does not execute command-backed apiKey resolution", async () => {
		const counterFile = join(tempDir, "counter");
		writeFileSync(counterFile, "0");

		const counterPath = toShPath(counterFile);
		const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
		writeRawModelsJson({
			"custom-provider": providerWithApiKey(command),
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const available = registry.getAvailable();

		expect(available.some((m) => m.provider === "custom-provider")).toBe(true);
		const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
		expect(count).toBe(0);
	});

	test("getApiKeyAndHeaders re-resolves authHeader each request when the memo is disabled", async () => {
		process.env.PIT_CONFIG_COMMAND_TTL_MS = "0";
		const tokenFile = join(tempDir, "token");
		writeFileSync(tokenFile, "token-1");
		const tokenPath = toShPath(tokenFile);

		writeRawModelsJson({
			"custom-provider": {
				...providerWithApiKey(`!sh -c 'cat "${tokenPath}"'`),
				authHeader: true,
			},
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const model = registry.find("custom-provider", "test-model");
		expect(model).toBeDefined();

		const auth1 = await registry.getApiKeyAndHeaders(model!);
		expect(auth1).toEqual({
			ok: true,
			apiKey: "token-1",
			headers: { Authorization: "Bearer token-1" },
		});

		writeFileSync(tokenFile, "token-2");

		const auth2 = await registry.getApiKeyAndHeaders(model!);
		expect(auth2).toEqual({
			ok: true,
			apiKey: "token-2",
			headers: { Authorization: "Bearer token-2" },
		});
	});

	test("getApiKeyAndHeaders memoises authHeader within the TTL window", async () => {
		const tokenFile = join(tempDir, "token");
		writeFileSync(tokenFile, "token-1");
		const tokenPath = toShPath(tokenFile);

		writeRawModelsJson({
			"custom-provider": {
				...providerWithApiKey(`!sh -c 'cat "${tokenPath}"'`),
				authHeader: true,
			},
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const model = registry.find("custom-provider", "test-model");
		expect(model).toBeDefined();

		const auth1 = await registry.getApiKeyAndHeaders(model!);
		expect(auth1).toEqual({
			ok: true,
			apiKey: "token-1",
			headers: { Authorization: "Bearer token-1" },
		});

		writeFileSync(tokenFile, "token-2");

		const auth2 = await registry.getApiKeyAndHeaders(model!);
		expect(auth2).toEqual({
			ok: true,
			apiKey: "token-1",
			headers: { Authorization: "Bearer token-1" },
		});
	});

	test("getApiKeyAndHeaders returns an error for failed authHeader resolution", async () => {
		writeRawModelsJson({
			"custom-provider": {
				...providerWithApiKey("!exit 1"),
				authHeader: true,
			},
		});

		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const model = registry.find("custom-provider", "test-model");
		expect(model).toBeDefined();

		const auth = await registry.getApiKeyAndHeaders(model!);
		expect(auth.ok).toBe(false);
		if (!auth.ok) {
			expect(auth.error).toContain('Failed to resolve API key for provider "custom-provider"');
		}
	});
});
