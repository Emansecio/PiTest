// Regression: #awaitStopOutcome must report timedOut: true on wait failure and derive
// state from session.status (not hardcode "running" with timedOut gated on status).

import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DapResolvedAdapter, dapSessionManager } from "../../src/core/dap/index.ts";
import * as lspInternal from "../../src/core/lsp/internal.ts";

const FAKE = fileURLToPath(new URL("./fake-dap-adapter.mjs", import.meta.url));

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

describe("DapSessionManager.#awaitStopOutcome — timeout reporting", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await dapSessionManager.disposeAll();
	});

	it("returns timedOut: true when the stop outcome wait fails", async () => {
		const untilSpy = vi.spyOn(lspInternal, "untilAborted").mockRejectedValue(new Error("wait timed out"));

		const launched = await dapSessionManager.launch(
			{ adapter: fakeAdapter(), program: "/x/main.c", cwd: tmpdir() },
			undefined,
			10_000,
		);
		expect(launched.status).toBe("stopped");

		const outcome = await dapSessionManager.stepIn(undefined, 10_000);
		expect(outcome.timedOut).toBe(true);
		expect(outcome.state).toBe("running");

		untilSpy.mockRestore();
		await dapSessionManager.terminate();
	}, 60_000);
});
