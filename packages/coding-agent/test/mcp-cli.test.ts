/**
 * Tests for the `pit mcp …` CLI: add (stdio + http), scope file selection,
 * remove, and the CC `mcpServers` file format. Runs against a temp cwd.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcpCommand } from "../src/mcp-cli.js";

describe("handleMcpCommand", () => {
	let dir: string;
	let prevCwd: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pit-mcpcli-"));
		prevCwd = process.cwd();
		process.chdir(dir);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		process.chdir(prevCwd);
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("returns false for non-mcp argv", async () => {
		expect(await handleMcpCommand(["chat"])).toBe(false);
	});

	it("adds a stdio server to the local scope file (CC mcpServers format)", async () => {
		const handled = await handleMcpCommand(["mcp", "add", "fs", "npx", "-y", "server-filesystem", "/data"]);
		expect(handled).toBe(true);
		const file = join(dir, ".mcp.local.json");
		expect(existsSync(file)).toBe(true);
		const parsed = JSON.parse(readFileSync(file, "utf-8"));
		expect(parsed.mcpServers.fs).toEqual({
			transport: "stdio",
			command: "npx",
			args: ["-y", "server-filesystem", "/data"],
		});
	});

	it("adds an http server to the project scope file with a header", async () => {
		await handleMcpCommand([
			"mcp",
			"add",
			"remote",
			"https://example.com/mcp",
			"--scope",
			"project",
			"--header",
			"Authorization: Bearer X",
		]);
		const parsed = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf-8"));
		expect(parsed.mcpServers.remote).toEqual({
			transport: "http",
			url: "https://example.com/mcp",
			headers: { Authorization: "Bearer X" },
		});
	});

	it("removes a server", async () => {
		await handleMcpCommand(["mcp", "add", "fs", "npx", "server-fs"]);
		await handleMcpCommand(["mcp", "remove", "fs"]);
		const parsed = JSON.parse(readFileSync(join(dir, ".mcp.local.json"), "utf-8"));
		expect(parsed.mcpServers.fs).toBeUndefined();
	});

	it("add-json parses a raw config", async () => {
		await handleMcpCommand(["mcp", "add-json", "j", '{"type":"sse","url":"https://e/sse"}', "--scope", "project"]);
		const parsed = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf-8"));
		expect(parsed.mcpServers.j.url).toBe("https://e/sse");
		expect(parsed.mcpServers.j.transport).toBe("sse");
	});
});
