// Unit tests for DapClient socket-mode (#spawnSocket) failure paths:
//  - connect timeout must kill the leaked adapter process (no orphan).
//  - a spawn 'error' inside the connect window must be handled (no unhandled
//    rejection / host crash), and the process must be reaped.
// The happy path is covered end-to-end by debug.test.ts against the real fake
// adapter, so here we only drive the timeout/error branches.

import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spy on killProcessTree while keeping the real kill so the spawned test
// processes are actually reaped (no leaked node procs after the run).
const killSpy = vi.fn();
vi.mock("../../src/utils/shell.ts", async () => {
	const actual = await vi.importActual<typeof import("../../src/utils/shell.ts")>("../../src/utils/shell.ts");
	return {
		...actual,
		killProcessTree: (pid: number) => {
			killSpy(pid);
			actual.killProcessTree(pid);
		},
	};
});

const { DapClient } = await import("../../src/core/dap/client.ts");

import type { DapResolvedAdapter } from "../../src/core/dap/types.ts";

const NOCONNECT = fileURLToPath(new URL("./fake-dap-noconnect.mjs", import.meta.url));

function socketAdapter(overrides: Partial<DapResolvedAdapter> = {}): DapResolvedAdapter {
	return {
		name: "fake-dlv",
		command: "node",
		args: [NOCONNECT],
		resolvedCommand: process.execPath,
		languages: ["go"],
		fileTypes: [".go"],
		rootMarkers: [],
		launchDefaults: {},
		attachDefaults: {},
		connectMode: "socket",
		...overrides,
	};
}

describe("DapClient socket-mode failure paths", () => {
	beforeEach(() => {
		killSpy.mockClear();
		// Keep the connect deadline tiny so the timeout branch is fast + deterministic.
		process.env.PIT_DAP_CONNECT_TIMEOUT_MS = "300";
	});
	afterEach(() => {
		delete process.env.PIT_DAP_CONNECT_TIMEOUT_MS;
	});

	it("kills the adapter process when the socket connect times out (no leak)", async () => {
		await expect(DapClient.spawn({ adapter: socketAdapter(), cwd: process.cwd() })).rejects.toThrow(
			/did not connect/i,
		);
		// The leaked adapter tree must have been killed rather than orphaned.
		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(typeof killSpy.mock.calls[0][0]).toBe("number");
	});

	it("handles a spawn 'error' in the connect window without an unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			// A non-existent executable makes Node emit 'error' (ENOENT) during connect.
			const adapter = socketAdapter({ resolvedCommand: "/no/such/dap/adapter-binary-xyz" });
			await expect(DapClient.spawn({ adapter, cwd: process.cwd() })).rejects.toThrow();
			// Let any stray microtasks flush so a missed listener would surface.
			await new Promise((r) => setTimeout(r, 50));
			expect(unhandled).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
