/**
 * Change A (boot-failure circuit breaker) + Change B (writethrough init cap).
 *
 * A genuine spawn/init failure is remembered per client key: within the cooldown
 * window getOrCreateClient short-circuits with a "cooling down" error instead of
 * re-spawning; after the window one retry is allowed. An abort (user ESC /
 * AbortSignal) is never treated as a boot failure. A hanging `initialize` capped
 * by an init timeout counts as a boot failure and arms the breaker.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetLspFailureMemoryForTest, getOrCreateClient, shutdownAll } from "../../src/core/lsp/client.ts";
import type { ServerConfig } from "../../src/core/lsp/types.ts";

const FAKE_SERVER = fileURLToPath(new URL("./fake-lsp-server.mjs", import.meta.url));

const PREV_COOLDOWN = process.env.PIT_LSP_BOOT_BREAKER_COOLDOWN_MS;
const PREV_DISABLE = process.env.PIT_NO_LSP_BOOT_BREAKER;

function makeCwd(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pit-lsp-breaker-"));
	writeFileSync(join(cwd, "lsp.json"), JSON.stringify({ servers: {} }));
	return cwd;
}

/**
 * Best-effort temp-dir removal: a just-killed LSP child (its own cwd is this
 * dir) can hold it open briefly on Windows (EBUSY), so retry, then give up — the
 * OS reclaims the temp dir regardless. Never fails the test on teardown.
 */
function removeDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	} catch {
		// leave it for the OS temp sweeper
	}
}

function badConfig(): ServerConfig {
	return {
		command: "pit-no-such-lsp-binary-xyz",
		args: [],
		fileTypes: [".txt"],
		rootMarkers: ["lsp.json"],
	};
}

function fakeConfig(): ServerConfig {
	return { command: "node", args: [FAKE_SERVER], fileTypes: [".txt"], rootMarkers: ["lsp.json"] };
}

describe("lsp boot-failure circuit breaker + init cap", () => {
	const cleanups: Array<() => void> = [];

	beforeEach(() => {
		_resetLspFailureMemoryForTest();
	});

	afterEach(async () => {
		await shutdownAll().catch(() => {});
		_resetLspFailureMemoryForTest();
		for (const c of cleanups.splice(0)) c();
		delete process.env.FAKE_LSP_INIT_DELAY_MS;
		if (PREV_COOLDOWN === undefined) delete process.env.PIT_LSP_BOOT_BREAKER_COOLDOWN_MS;
		else process.env.PIT_LSP_BOOT_BREAKER_COOLDOWN_MS = PREV_COOLDOWN;
		if (PREV_DISABLE === undefined) delete process.env.PIT_NO_LSP_BOOT_BREAKER;
		else process.env.PIT_NO_LSP_BOOT_BREAKER = PREV_DISABLE;
	});

	it("trips after a boot failure and skips the spawn during cooldown", async () => {
		process.env.PIT_LSP_BOOT_BREAKER_COOLDOWN_MS = "60000";
		const cwd = makeCwd();
		cleanups.push(() => removeDir(cwd));

		// First attempt genuinely spawns and fails (missing binary) — NOT a breaker throw.
		await expect(getOrCreateClient(badConfig(), cwd)).rejects.toThrow(/^(?!.*cooling down).*/s);

		// Second attempt is short-circuited by the breaker (no spawn).
		await expect(getOrCreateClient(badConfig(), cwd)).rejects.toThrow(/cooling down after boot failure/);
	});

	it("allows one retry after the cooldown window elapses", async () => {
		// Cooldown 0 → the window is always already elapsed, so the breaker permits a
		// re-spawn (which fails again and re-arms), never a "cooling down" throw.
		process.env.PIT_LSP_BOOT_BREAKER_COOLDOWN_MS = "0";
		const cwd = makeCwd();
		cleanups.push(() => removeDir(cwd));

		await expect(getOrCreateClient(badConfig(), cwd)).rejects.toThrow(/^(?!.*cooling down).*/s);
		// Window elapsed → retry re-spawns and fails with the real error, not cooldown.
		await expect(getOrCreateClient(badConfig(), cwd)).rejects.toThrow(/^(?!.*cooling down).*/s);
	});

	it("never trips on an aborted init (user ESC / AbortSignal)", async () => {
		process.env.PIT_LSP_BOOT_BREAKER_COOLDOWN_MS = "60000";
		process.env.FAKE_LSP_INIT_DELAY_MS = "5000"; // initialize will not reply promptly
		const cwd = makeCwd();
		cleanups.push(() => removeDir(cwd));

		const ac = new AbortController();
		const pending = getOrCreateClient(fakeConfig(), cwd, 5000, ac.signal);
		ac.abort();
		await expect(pending).rejects.toBeTruthy();

		// Abort must NOT have armed the breaker: a fresh (non-delayed) spawn succeeds.
		delete process.env.FAKE_LSP_INIT_DELAY_MS;
		const client = await getOrCreateClient(fakeConfig(), cwd, 5000);
		expect(client.serverCapabilities).toBeTruthy();
	});

	it("bounds a hanging initialize and arms the breaker (init cap)", async () => {
		process.env.PIT_LSP_BOOT_BREAKER_COOLDOWN_MS = "60000";
		process.env.FAKE_LSP_INIT_DELAY_MS = "10000"; // hang well past the cap
		const cwd = makeCwd();
		cleanups.push(() => removeDir(cwd));

		// 150ms init cap → the hang is turned into a bounded request-timeout failure.
		await expect(getOrCreateClient(fakeConfig(), cwd, 150)).rejects.toThrow(/timed out/);
		// The timed-out init counts as a boot failure → next call is cooling down.
		await expect(getOrCreateClient(fakeConfig(), cwd, 150)).rejects.toThrow(/cooling down after boot failure/);
	});

	it("kill-switch PIT_NO_LSP_BOOT_BREAKER=1 restores always-respawn", async () => {
		process.env.PIT_NO_LSP_BOOT_BREAKER = "1";
		process.env.PIT_LSP_BOOT_BREAKER_COOLDOWN_MS = "60000";
		const cwd = makeCwd();
		cleanups.push(() => removeDir(cwd));

		// With the breaker disabled every attempt re-spawns → real error, never cooldown.
		await expect(getOrCreateClient(badConfig(), cwd)).rejects.toThrow(/^(?!.*cooling down).*/s);
		await expect(getOrCreateClient(badConfig(), cwd)).rejects.toThrow(/^(?!.*cooling down).*/s);
	});
});
