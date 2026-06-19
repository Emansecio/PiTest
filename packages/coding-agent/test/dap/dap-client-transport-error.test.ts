// Regression for #29: a transport (socket/pipe) error must mark the DapClient
// disposed and tear it down, so isAlive() turns false rather than leaving a
// zombie session "alive" until the idle timeout.

import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DapClient } from "../../src/core/dap/client.ts";
import type { DapResolvedAdapter } from "../../src/core/dap/types.ts";

const FAKE = fileURLToPath(new URL("./fake-dap-adapter.mjs", import.meta.url));

function stdioAdapter(): DapResolvedAdapter {
	return {
		name: "fake",
		command: "node",
		args: [FAKE],
		resolvedCommand: process.execPath,
		languages: ["c"],
		fileTypes: [".c"],
		rootMarkers: [],
		launchDefaults: {},
		attachDefaults: {},
		connectMode: "stdio",
	};
}

describe("DapClient transport error tears down the session (#29)", () => {
	let client: DapClient | undefined;

	afterEach(async () => {
		await client?.dispose().catch(() => undefined);
		client = undefined;
	});

	it("isAlive() becomes false after an input-stream error", async () => {
		client = await DapClient.spawn({ adapter: stdioAdapter(), cwd: process.cwd() });
		expect(client.isAlive()).toBe(true);

		// Simulate a transport error on the reader stream (the socket/pipe carrying
		// DAP). In stdio mode `#input` is the proc stdout; the adapter PROCESS is
		// still alive at this point.
		const reader = (client as unknown as { proc: { stdout: NodeJS.EventEmitter } }).proc.stdout;
		reader.emit("error", new Error("ECONNRESET"));

		expect(client.isAlive()).toBe(false);
	});
});
