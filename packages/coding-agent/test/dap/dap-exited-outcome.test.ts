// Regression for #27: when `continue` races to an `exited` event (no matching
// `terminated`), the outcome must report the program as terminated (with its
// exit code), not "running".

import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type DapResolvedAdapter, dapSessionManager } from "../../src/core/dap/index.ts";

const FAKE = fileURLToPath(new URL("./fake-dap-exited.mjs", import.meta.url));

function fakeAdapter(): DapResolvedAdapter {
	return {
		name: "fake",
		command: "node",
		args: [FAKE],
		resolvedCommand: process.execPath,
		languages: ["c"],
		fileTypes: [".c"],
		rootMarkers: [],
		launchDefaults: { stopOnEntry: true },
		attachDefaults: {},
		connectMode: "stdio",
	};
}

describe("DAP continue when 'exited' wins the race (#27)", () => {
	afterEach(async () => {
		await dapSessionManager.disposeAll();
	});

	it("reports terminated (not running) and surfaces the exit code", async () => {
		const adapter = fakeAdapter();
		const launched = await dapSessionManager.launch(
			{ adapter, program: "/x/main.c", cwd: tmpdir() },
			undefined,
			10_000,
		);
		expect(launched.status).toBe("stopped");

		const out = await dapSessionManager.continue(undefined, 10_000);
		expect(out.state).toBe("terminated");
		expect(out.state).not.toBe("running");
		expect(out.snapshot.exitCode).toBe(7);
	});
});
