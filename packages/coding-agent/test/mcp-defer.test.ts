/**
 * Tests for the MCP deferral policy: which servers' tools are kept off the
 * active surface (registered into the tool-discovery index, found on demand via
 * search_tool_bm25) vs registered eagerly. Deferral keeps grab-bag servers from
 * permanently bloating the prompt and churning the cache prefix.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldDeferMcpServer } from "../src/core/built-ins/mcp-extension.js";
import type { McpServerConfig, McpSettings } from "../src/core/mcp/index.js";

describe("shouldDeferMcpServer", () => {
	const originalEnv = process.env.PIT_DEFER_MCP;
	beforeEach(() => {
		delete process.env.PIT_DEFER_MCP;
	});
	afterEach(() => {
		if (originalEnv === undefined) delete process.env.PIT_DEFER_MCP;
		else process.env.PIT_DEFER_MCP = originalEnv;
	});

	const noServer: McpServerConfig | undefined = undefined;

	it("auto (default) defers only servers at or above the threshold", () => {
		const settings: McpSettings = {}; // defer defaults to "auto", threshold 10
		expect(shouldDeferMcpServer(25, noServer, settings)).toBe(true); // Chrome/DC-sized
		expect(shouldDeferMcpServer(10, noServer, settings)).toBe(true); // exactly at threshold
		expect(shouldDeferMcpServer(9, noServer, settings)).toBe(false); // just under
		expect(shouldDeferMcpServer(2, noServer, settings)).toBe(false); // small focused server
	});

	it("auto honors a custom deferThreshold", () => {
		const settings: McpSettings = { defer: "auto", deferThreshold: 5 };
		expect(shouldDeferMcpServer(5, noServer, settings)).toBe(true);
		expect(shouldDeferMcpServer(4, noServer, settings)).toBe(false);
	});

	it("always defers every server regardless of size", () => {
		const settings: McpSettings = { defer: "always" };
		expect(shouldDeferMcpServer(1, noServer, settings)).toBe(true);
		expect(shouldDeferMcpServer(50, noServer, settings)).toBe(true);
	});

	it("never defers any server (legacy eager behavior)", () => {
		const settings: McpSettings = { defer: "never" };
		expect(shouldDeferMcpServer(50, noServer, settings)).toBe(false);
	});

	it("per-server defer override wins over the global policy", () => {
		// Force-eager a big server even under auto.
		expect(shouldDeferMcpServer(40, { url: "x", defer: false }, {})).toBe(false);
		// Force-defer a tiny server even under "never".
		expect(shouldDeferMcpServer(1, { url: "x", defer: true }, { defer: "never" })).toBe(true);
	});

	it("legacy PIT_DEFER_MCP=1 forces always, but a per-server override still wins", () => {
		process.env.PIT_DEFER_MCP = "1";
		expect(shouldDeferMcpServer(1, noServer, { defer: "never" })).toBe(true); // env beats global
		expect(shouldDeferMcpServer(40, { url: "x", defer: false }, {})).toBe(false); // server beats env
	});
});
