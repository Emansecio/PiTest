/**
 * Shell-spawn coverage for AuthStorage `!command` apiKey resolution.
 * Kept out of the unit subset (see vitest.unit.config.ts) — real shell
 * spawns dominate wall time on Windows.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { clearConfigValueCache } from "../src/core/resolve-config-value.js";

describe("AuthStorage shell !command resolution", () => {
	let tempDir: string;
	let authJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-auth-storage-shell-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearConfigValueCache();
	});

	function writeAuthJson(data: Record<string, unknown>) {
		writeFileSync(authJsonPath, JSON.stringify(data));
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	test("apiKey with ! prefix executes command and uses stdout", async () => {
		writeAuthJson({
			anthropic: { type: "api_key", key: "!echo test-api-key-from-command" },
		});

		authStorage = AuthStorage.create(authJsonPath);
		const apiKey = await authStorage.getApiKey("anthropic");

		expect(apiKey).toBe("test-api-key-from-command");
	});

	test("apiKey with ! prefix trims whitespace from command output", async () => {
		writeAuthJson({
			anthropic: { type: "api_key", key: "!echo '  spaced-key  '" },
		});

		authStorage = AuthStorage.create(authJsonPath);
		const apiKey = await authStorage.getApiKey("anthropic");

		expect(apiKey).toBe("spaced-key");
	});

	test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
		writeAuthJson({
			anthropic: { type: "api_key", key: "!printf 'line1\\nline2'" },
		});

		authStorage = AuthStorage.create(authJsonPath);
		const apiKey = await authStorage.getApiKey("anthropic");

		expect(apiKey).toBe("line1\nline2");
	});

	test("apiKey with ! prefix returns undefined on command failure", async () => {
		writeAuthJson({
			anthropic: { type: "api_key", key: "!exit 1" },
		});

		authStorage = AuthStorage.create(authJsonPath);
		const apiKey = await authStorage.getApiKey("anthropic");

		expect(apiKey).toBeUndefined();
	});

	test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
		writeAuthJson({
			anthropic: { type: "api_key", key: "!nonexistent-command-12345" },
		});

		authStorage = AuthStorage.create(authJsonPath);
		const apiKey = await authStorage.getApiKey("anthropic");

		expect(apiKey).toBeUndefined();
	});

	test("apiKey with ! prefix returns undefined on empty output", async () => {
		writeAuthJson({
			anthropic: { type: "api_key", key: "!printf ''" },
		});

		authStorage = AuthStorage.create(authJsonPath);
		const apiKey = await authStorage.getApiKey("anthropic");

		expect(apiKey).toBeUndefined();
	});

	test("apiKey command can use shell features like pipes", async () => {
		writeAuthJson({
			anthropic: { type: "api_key", key: "!echo 'hello world' | tr ' ' '-'" },
		});

		authStorage = AuthStorage.create(authJsonPath);
		const apiKey = await authStorage.getApiKey("anthropic");

		expect(apiKey).toBe("hello-world");
	});

	test("command is only executed once per process", async () => {
		const counterFile = join(tempDir, "counter");
		writeFileSync(counterFile, "0");

		const counterPath = toShPath(counterFile);
		const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
		writeAuthJson({
			anthropic: { type: "api_key", key: command },
		});

		authStorage = AuthStorage.create(authJsonPath);

		await authStorage.getApiKey("anthropic");
		await authStorage.getApiKey("anthropic");
		await authStorage.getApiKey("anthropic");

		const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
		expect(count).toBe(1);
	});

	test("cache persists across AuthStorage instances", async () => {
		const counterFile = join(tempDir, "counter");
		writeFileSync(counterFile, "0");

		const counterPath = toShPath(counterFile);
		const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
		writeAuthJson({
			anthropic: { type: "api_key", key: command },
		});

		const storage1 = AuthStorage.create(authJsonPath);
		await storage1.getApiKey("anthropic");

		const storage2 = AuthStorage.create(authJsonPath);
		await storage2.getApiKey("anthropic");

		const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
		expect(count).toBe(1);
	});

	test("clearConfigValueCache allows command to run again", async () => {
		const counterFile = join(tempDir, "counter");
		writeFileSync(counterFile, "0");

		const counterPath = toShPath(counterFile);
		const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
		writeAuthJson({
			anthropic: { type: "api_key", key: command },
		});

		authStorage = AuthStorage.create(authJsonPath);
		await authStorage.getApiKey("anthropic");

		clearConfigValueCache();
		await authStorage.getApiKey("anthropic");

		const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
		expect(count).toBe(2);
	});

	test("different commands are cached separately", async () => {
		writeAuthJson({
			anthropic: { type: "api_key", key: "!echo key-anthropic" },
			openai: { type: "api_key", key: "!echo key-openai" },
		});

		authStorage = AuthStorage.create(authJsonPath);

		const keyA = await authStorage.getApiKey("anthropic");
		const keyB = await authStorage.getApiKey("openai");

		expect(keyA).toBe("key-anthropic");
		expect(keyB).toBe("key-openai");
	});

	test("failed commands are not memoised (retried within TTL window)", async () => {
		const counterFile = join(tempDir, "counter");
		writeFileSync(counterFile, "0");

		const counterPath = toShPath(counterFile);
		const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
		writeAuthJson({
			anthropic: { type: "api_key", key: command },
		});

		authStorage = AuthStorage.create(authJsonPath);

		const key1 = await authStorage.getApiKey("anthropic");
		const key2 = await authStorage.getApiKey("anthropic");

		expect(key1).toBeUndefined();
		expect(key2).toBeUndefined();

		const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
		expect(count).toBe(2);
	});

	test("runtime override takes priority over auth.json command key", async () => {
		writeAuthJson({
			anthropic: { type: "api_key", key: "!echo stored-key" },
		});

		authStorage = AuthStorage.create(authJsonPath);
		authStorage.setRuntimeApiKey("anthropic", "runtime-key");

		const apiKey = await authStorage.getApiKey("anthropic");

		expect(apiKey).toBe("runtime-key");
	});

	test("removing runtime override falls back to auth.json command key", async () => {
		writeAuthJson({
			anthropic: { type: "api_key", key: "!echo stored-key" },
		});

		authStorage = AuthStorage.create(authJsonPath);
		authStorage.setRuntimeApiKey("anthropic", "runtime-key");
		authStorage.removeRuntimeApiKey("anthropic");

		const apiKey = await authStorage.getApiKey("anthropic");

		expect(apiKey).toBe("stored-key");
	});
});
