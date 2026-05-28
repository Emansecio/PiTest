import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	_resetCredentialPool,
	type CredentialEntry,
	type CredentialPool,
	getCredentialPool,
} from "../src/credential-pool.js";

const originalCooldownMs = process.env.PI_KEY_COOLDOWN_MS;

describe("CredentialPool", () => {
	let pool: CredentialPool;

	beforeEach(() => {
		_resetCredentialPool();
		pool = getCredentialPool();
	});

	afterEach(() => {
		if (originalCooldownMs === undefined) {
			delete process.env.PI_KEY_COOLDOWN_MS;
		} else {
			process.env.PI_KEY_COOLDOWN_MS = originalCooldownMs;
		}
		_resetCredentialPool();
	});

	function entries(...keys: string[]): CredentialEntry[] {
		return keys.map((key) => ({ key, source: "env" as const }));
	}

	test("register replaces entries for a provider", () => {
		pool.register("anthropic", entries("a", "b"));
		expect(pool.count("anthropic")).toBe(2);
		pool.register("anthropic", entries("c"));
		expect(pool.count("anthropic")).toBe(1);
		const picked = pool.pick("anthropic");
		expect(picked?.entry.key).toBe("c");
	});

	test("pick with sessionId returns the same key on repeat calls (sticky)", () => {
		pool.register("anthropic", entries("a", "b", "c"));
		const first = pool.pick("anthropic", "s1");
		expect(first).toBeDefined();
		const second = pool.pick("anthropic", "s1");
		const third = pool.pick("anthropic", "s1");
		expect(second?.entry.key).toBe(first?.entry.key);
		expect(third?.entry.key).toBe(first?.entry.key);
	});

	test("markFailure rate-limit puts key on cooldown; next pick returns next entry", () => {
		pool.register("anthropic", entries("a", "b", "c"));
		const first = pool.pick("anthropic", "s1");
		expect(first?.entry.key).toBe("a");
		pool.markFailure("anthropic", "a", "rate-limit");
		const next = pool.pick("anthropic", "s1");
		expect(next?.entry.key).not.toBe("a");
		expect(["b", "c"]).toContain(next?.entry.key);
	});

	test("markFailure auth cooldowns key essentially forever", () => {
		pool.register("anthropic", entries("a", "b"));
		pool.markFailure("anthropic", "a", "auth");
		const picked = pool.pick("anthropic");
		expect(picked?.entry.key).toBe("b");
		// Confirm cooldown is effectively infinite
		pool.markFailure("anthropic", "b", "rate-limit");
		const none = pool.pick("anthropic");
		expect(none).toBeUndefined();
	});

	test("markSuccess clears failure count", () => {
		pool.register("anthropic", entries("a"));
		pool.markFailure("anthropic", "a", "other");
		pool.markFailure("anthropic", "a", "other");
		pool.markSuccess("anthropic", "a");
		const picked = pool.pick("anthropic");
		expect(picked?.entry.failures).toBe(0);
	});

	test("addRuntimeKey appends entries", () => {
		pool.register("anthropic", entries("a"));
		pool.addRuntimeKey("anthropic", "rt1");
		expect(pool.count("anthropic")).toBe(2);
		// dedupe: re-adding the same key is a no-op
		pool.addRuntimeKey("anthropic", "rt1");
		expect(pool.count("anthropic")).toBe(2);
	});

	test("awaitFreeSlot resolves immediately when slot ready", async () => {
		pool.register("anthropic", entries("a"));
		await expect(pool.awaitFreeSlot("anthropic", 1000)).resolves.toBeUndefined();
	});

	test("awaitFreeSlot rejects/skips when timeout < cooldown", async () => {
		// Force a long cooldown so timeout always loses.
		process.env.PI_KEY_COOLDOWN_MS = "60000";
		_resetCredentialPool();
		pool = getCredentialPool();
		pool.register("anthropic", entries("a"));
		pool.markFailure("anthropic", "a", "rate-limit");
		await expect(pool.awaitFreeSlot("anthropic", 5)).rejects.toThrow(/No credentials ready/);
	});
});
