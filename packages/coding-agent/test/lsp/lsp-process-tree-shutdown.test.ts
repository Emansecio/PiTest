import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getOrCreateClient, shutdownAll, shutdownClient } from "../../src/core/lsp/client.ts";
import type { ServerConfig } from "../../src/core/lsp/types.ts";

const FAKE_SERVER = fileURLToPath(new URL("./fake-lsp-server.mjs", import.meta.url));
const WAIT_MS = 3_000;

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(check: () => boolean, timeoutMs = WAIT_MS): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return check();
}

async function readPidWhenReady(pidFile: string): Promise<number> {
	if (!(await waitUntil(() => existsSync(pidFile)))) {
		throw new Error("fake LSP grandchild did not publish its PID");
	}
	return Number.parseInt(readFileSync(pidFile, "utf8"), 10);
}

describe("LSP process-tree shutdown", () => {
	let grandchildPid: number | undefined;
	const cleanupPaths: string[] = [];

	afterEach(async () => {
		await shutdownAll().catch(() => {});
		const pid = grandchildPid;
		if (pid !== undefined && isPidAlive(pid)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// The assertion may already have reaped this test's exact descendant.
			}
			await waitUntil(() => !isPidAlive(pid));
		}
		for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
		grandchildPid = undefined;
	});

	it.each(["shutdownAll", "shutdownClient"] as const)(
		"%s reaps the persistent grandchild after graceful shutdown",
		async (method) => {
			const cwd = mkdtempSync(join(tmpdir(), "pit-lsp-tree-"));
			cleanupPaths.push(cwd);
			const pidFile = join(cwd, "grandchild.pid");
			const config: ServerConfig = {
				command: "node",
				args: [FAKE_SERVER, `--spawn-grandchild=${pidFile}`],
				fileTypes: [".txt"],
				rootMarkers: ["lsp.json"],
			};

			const client = await getOrCreateClient(config, cwd);
			grandchildPid = await readPidWhenReady(pidFile);
			expect(Number.isInteger(grandchildPid)).toBe(true);
			expect(isPidAlive(grandchildPid)).toBe(true);

			if (method === "shutdownAll") await shutdownAll();
			else await shutdownClient(client.name);

			expect(await waitUntil(() => !isPidAlive(grandchildPid!))).toBe(true);
		},
		15_000,
	);
});
