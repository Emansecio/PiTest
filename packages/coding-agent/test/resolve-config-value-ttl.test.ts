/**
 * Tests for the short-lived TTL memo on the "uncached" `!command` resolvers.
 * The per-request auth path resolves the same handful of commands every turn;
 * the memo collapses the repeated shell spawns without caching failures or
 * starving rotating tokens. Exercises the async path used by
 * model-registry.getApiKeyAndHeaders.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigValueCache, resolveConfigValueUncachedAsync } from "../src/core/resolve-config-value.js";
import * as shellUtils from "../src/utils/shell.js";

describe("resolveConfigValueUncachedAsync TTL memo", () => {
	const prevTtl = process.env.PIT_CONFIG_COMMAND_TTL_MS;
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pit-ttl-"));
		clearConfigValueCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
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

	async function waitFor<T>(check: () => T | undefined, timeoutMs = 5000): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const value = check();
			if (value !== undefined) return value;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error("Timed out waiting for test child process");
	}

	function isPidAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
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

	it("falls back to the default shell when configured-shell resolution fails before spawning", async () => {
		const getShellConfig = vi.spyOn(shellUtils, "getShellConfig").mockImplementation(() => {
			throw new Error("configured shell is unavailable");
		});

		await expect(resolveConfigValueUncachedAsync("!node -e \"console.log('fallback-key')\"")).resolves.toBe(
			"fallback-key",
		);

		getShellConfig.mockRestore();
	});

	it("stops and reaps a noisy command tree when stdout exceeds 1 MiB", async () => {
		const childPidFile = join(tempDir, "noisy-child.pid");
		const launcherFile = join(tempDir, "spawn-noisy-child.cjs");
		writeFileSync(
			launcherFile,
			[
				'const { spawn } = require("node:child_process");',
				'const { writeFileSync } = require("node:fs");',
				'const child = spawn(process.execPath, ["-e", \'process.stdout.write("x".repeat(1024 * 1024 + 1)); setInterval(() => {}, 1000)\'], { stdio: ["ignore", "inherit", "ignore"] });',
				"writeFileSync(process.argv[2], String(child.pid));",
				"setInterval(() => {}, 1000);",
			].join("\n"),
		);

		const controller = new AbortController();
		const command = `!${JSON.stringify(process.execPath)} ${JSON.stringify(launcherFile)} ${JSON.stringify(childPidFile)}`;
		const resolving = resolveConfigValueUncachedAsync(command, controller.signal);
		const noisyChildPid = await waitFor(() => {
			if (!existsSync(childPidFile)) return undefined;
			return Number.parseInt(readFileSync(childPidFile, "utf-8"), 10);
		});
		const deadline = Symbol("stdout limit deadline");
		const result = await Promise.race([
			resolving,
			new Promise<typeof deadline>((resolve) => setTimeout(() => resolve(deadline), 5000)),
		]);

		if (result === deadline) {
			controller.abort(new Error("test cleanup"));
			await expect(resolving).rejects.toThrow("test cleanup");
		}
		expect(result).toBeUndefined();
		expect(isPidAlive(noisyChildPid)).toBe(false);
	}, 20000);

	it("rejects abort promptly and reaps a persistent Node grandchild asynchronously", async () => {
		const childPidFile = join(tempDir, "persistent-child.pid");
		const launcherFile = join(tempDir, "spawn-persistent-child.cjs");
		writeFileSync(
			launcherFile,
			[
				'const { spawn } = require("node:child_process");',
				'const { writeFileSync } = require("node:fs");',
				'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
				"writeFileSync(process.argv[2], String(child.pid));",
				"setInterval(() => {}, 1000);",
			].join("\n"),
		);

		const controller = new AbortController();
		const abortReason = "test abort";
		const command = `!${JSON.stringify(process.execPath)} ${JSON.stringify(launcherFile)} ${JSON.stringify(childPidFile)}`;
		const resolving = resolveConfigValueUncachedAsync(command, controller.signal);
		const persistentChildPid = await waitFor(() => {
			if (!existsSync(childPidFile)) return undefined;
			return Number.parseInt(readFileSync(childPidFile, "utf-8"), 10);
		});

		const abortedAt = Date.now();
		controller.abort(abortReason);
		await expect(resolving).rejects.toBe(abortReason);
		expect(Date.now() - abortedAt).toBeLessThan(800);
		await waitFor(() => (isPidAlive(persistentChildPid) ? undefined : true));
	}, 20000);
});
