/**
 * Tests for the short-lived TTL memo on the "uncached" `!command` resolvers.
 * The per-request auth path resolves the same handful of commands every turn;
 * the memo collapses the repeated shell spawns without caching failures or
 * starving rotating tokens. Exercises the async path used by
 * model-registry.getApiKeyAndHeaders.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearConfigValueCache, resolveConfigValueUncachedAsync } from "../src/core/resolve-config-value.js";

describe("resolveConfigValueUncachedAsync TTL memo", () => {
	const prevTtl = process.env.PIT_CONFIG_COMMAND_TTL_MS;
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pit-ttl-"));
		clearConfigValueCache();
	});

	afterEach(() => {
		if (prevTtl === undefined) delete process.env.PIT_CONFIG_COMMAND_TTL_MS;
		else process.env.PIT_CONFIG_COMMAND_TTL_MS = prevTtl;
		clearConfigValueCache();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	// `!command` that bumps a counter file on every real spawn, then runs `tail`
	// (default: echoes a value so the result is a defined, memoisable string).
	function counterCommand(counterFile: string, tail = 'echo "key-value"'): string {
		const p = toShPath(counterFile);
		return `!sh -c 'count=$(cat "${p}"); echo $((count + 1)) > "${p}"; ${tail}'`;
	}

	function spawnCount(counterFile: string): number {
		return Number.parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
	}

	it("memoises a successful command within the TTL window (one spawn)", async () => {
		process.env.PIT_CONFIG_COMMAND_TTL_MS = "60000";
		const counterFile = join(tempDir, "c1");
		writeFileSync(counterFile, "0");
		const cmd = counterCommand(counterFile);

		const first = await resolveConfigValueUncachedAsync(cmd);
		const second = await resolveConfigValueUncachedAsync(cmd);

		expect(first).toBe("key-value");
		expect(second).toBe("key-value");
		expect(spawnCount(counterFile)).toBe(1); // second call served from the memo
	}, 20000);

	it("clearConfigValueCache forces a fresh spawn", async () => {
		process.env.PIT_CONFIG_COMMAND_TTL_MS = "60000";
		const counterFile = join(tempDir, "c2");
		writeFileSync(counterFile, "0");
		const cmd = counterCommand(counterFile);

		await resolveConfigValueUncachedAsync(cmd);
		clearConfigValueCache();
		await resolveConfigValueUncachedAsync(cmd);

		expect(spawnCount(counterFile)).toBe(2);
	}, 20000);

	it("a TTL of 0 disables the memo (fresh every call)", async () => {
		process.env.PIT_CONFIG_COMMAND_TTL_MS = "0";
		const counterFile = join(tempDir, "c3");
		writeFileSync(counterFile, "0");
		const cmd = counterCommand(counterFile);

		await resolveConfigValueUncachedAsync(cmd);
		await resolveConfigValueUncachedAsync(cmd);

		expect(spawnCount(counterFile)).toBe(2);
	}, 20000);

	it("never memoises a failing command (no sticky auth outage)", async () => {
		process.env.PIT_CONFIG_COMMAND_TTL_MS = "60000";
		const counterFile = join(tempDir, "c4");
		writeFileSync(counterFile, "0");
		// Bumps the counter, then exits non-zero -> resolves to undefined.
		const cmd = counterCommand(counterFile, "exit 1");

		const first = await resolveConfigValueUncachedAsync(cmd);
		const second = await resolveConfigValueUncachedAsync(cmd);

		expect(first).toBeUndefined();
		expect(second).toBeUndefined();
		expect(spawnCount(counterFile)).toBe(2); // failures re-run instead of caching
	}, 20000);
});
