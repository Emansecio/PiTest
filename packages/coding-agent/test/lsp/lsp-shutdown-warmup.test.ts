/**
 * Regression for bughunt #26: shutdownClientsForCwd / shutdownClient /
 * shutdownAll must tear down a language server that is still WARMING UP
 * (mid-initialize), not just servers already published to the `clients` map.
 *
 * A client warming up lives only in `clientLocks` until initialize+initialized
 * complete. If a session/manager dispose races that handshake, the old code
 * found nothing to shut down and the resolved client re-registered AFTER dispose
 * — leaking the server process for the host's lifetime.
 *
 * We force the race with FAKE_LSP_INIT_DELAY_MS so `initialize` is in flight when
 * shutdown runs, then assert the spawned process actually dies.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getOrCreateClient, shutdownAll, shutdownClientsForCwd } from "../../src/core/lsp/client.ts";
import type { ServerConfig } from "../../src/core/lsp/types.ts";

const FAKE_SERVER = fileURLToPath(new URL("./fake-lsp-server.mjs", import.meta.url));

function makeConfig(): ServerConfig {
	return {
		command: "node",
		args: [FAKE_SERVER],
		fileTypes: [".txt"],
		rootMarkers: ["lsp.json"],
	};
}

async function waitForExit(proc: { exitCode: number | null; killed: boolean }, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null || proc.killed) return;
		await new Promise((r) => setTimeout(r, 25));
	}
}

describe("lsp shutdown vs in-flight warmup (#26)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(async () => {
		await shutdownAll().catch(() => {});
		for (const c of cleanups.splice(0)) c();
		delete process.env.FAKE_LSP_INIT_DELAY_MS;
	});

	it("shutdownClientsForCwd kills a server still mid-initialize", async () => {
		process.env.FAKE_LSP_INIT_DELAY_MS = "1500";
		const cwd = mkdtempSync(join(tmpdir(), "pit-lsp-warmup-"));
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));

		// Kick off warmup but DON'T await — initialize reply is delayed 1.5s.
		const warmup = getOrCreateClient(makeConfig(), cwd);

		// Let the process spawn and send `initialize` (reply still pending).
		await new Promise((r) => setTimeout(r, 300));

		// Dispose while the handshake is still in flight.
		await shutdownClientsForCwd(cwd);

		// The warmup promise resolves to the (now shut-down) client; grab its proc.
		const client = await warmup;
		await waitForExit(client.proc, 3000);
		expect(client.proc.exitCode !== null || client.proc.killed).toBe(true);
	}, 15000);
});
