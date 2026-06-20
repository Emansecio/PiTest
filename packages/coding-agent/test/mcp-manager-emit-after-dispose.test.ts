/**
 * Regression for bughunt #32: McpManager.emit() must not pass `undefined` to
 * onStateChange after dispose().
 *
 * connectAll()/callTool() capture `entry` and call emit() AFTER awaiting the
 * client handshake. If dispose() (session_shutdown) clears the entries map
 * during that await, getState(entry.name) returns undefined and the old
 * `getState(...)!` non-null assertion passed undefined to onStateChange — which
 * crashes consumers that read `state.connected` (mcp-extension.ts).
 *
 * We force the race with a fetch mock that delays the `initialize` reply, call
 * dispose() while connectAll is in flight, then assert onStateChange was never
 * invoked with a non-object value.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { McpManager } from "../src/core/mcp/manager.js";

const TEST_URL = "http://localhost:0/mcp";

describe("McpManager emit after dispose (#32)", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("does not pass undefined state to onStateChange when dispose races connectAll", async () => {
		let releaseInit: (() => void) | undefined;
		const initGate = new Promise<void>((resolve) => {
			releaseInit = resolve;
		});

		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) => {
				const body = init?.body ? JSON.parse(init.body.toString()) : {};
				if (body.method === "initialize") {
					// Hold the handshake open so dispose() can win the race.
					await initGate;
					return new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							id: body.id,
							result: { protocolVersion: "2025-06-18", serverInfo: { name: "test", version: "1" } },
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				return new Response("", { status: 200, headers: { "content-type": "application/json" } });
			},
		) as unknown as typeof fetch;

		const seen: unknown[] = [];
		const manager = new McpManager({
			servers: { test: { url: TEST_URL } },
			onStateChange: (state) => {
				// The bug delivers `undefined` here; reading any property would throw.
				seen.push(state);
			},
		});

		const connecting = manager.connectAll();
		// Let connectAll reach the awaited initialize, then dispose mid-flight.
		await new Promise((r) => setTimeout(r, 20));
		manager.dispose();
		// Now let the (orphaned) initialize resolve so emit() fires post-dispose.
		releaseInit?.();
		await connecting;

		// No emit may carry a non-object (undefined) state.
		for (const state of seen) {
			expect(state).toBeTypeOf("object");
			expect(state).not.toBeNull();
		}
		// A consumer that reads state.connected must be safe for every emit.
		expect(() => {
			for (const state of seen) void (state as { connected: boolean }).connected;
		}).not.toThrow();
	});
});
