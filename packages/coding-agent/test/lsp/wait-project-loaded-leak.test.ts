import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { waitForProjectLoaded } from "../../src/core/lsp/client.ts";
import type { LspClient } from "../../src/core/lsp/types.ts";

/**
 * Regression for #25: waitForProjectLoaded must not leak an 'abort' listener on
 * the caller signal when projectLoaded wins the race (the common case).
 */
describe("waitForProjectLoaded abort-listener cleanup", () => {
	it("removes the abort listener after each call when projectLoaded resolves first", async () => {
		const client = { projectLoaded: Promise.resolve() } as unknown as LspClient;
		const controller = new AbortController();
		for (let i = 0; i < 5; i++) {
			await waitForProjectLoaded(client, controller.signal);
		}
		// No accumulated listeners on the shared, still-unaborted signal.
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});
