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

	it("disable then enable toggles the disabled flag in the scope file", async () => {
		await handleMcpCommand(["mcp", "add", "fs", "npx", "server-fs"]);
		await handleMcpCommand(["mcp", "disable", "fs"]);
		expect(JSON.parse(readFileSync(join(dir, ".mcp.local.json"), "utf-8")).mcpServers.fs.disabled).toBe(true);
		await handleMcpCommand(["mcp", "enable", "fs"]);
		expect(JSON.parse(readFileSync(join(dir, ".mcp.local.json"), "utf-8")).mcpServers.fs.disabled).toBeUndefined();
	});

	it("get returns true for an existing server and sets exit 1 for a missing one", async () => {
		await handleMcpCommand(["mcp", "add", "fs", "npx", "server-fs"]);
		process.exitCode = undefined;
		expect(await handleMcpCommand(["mcp", "get", "fs"])).toBe(true);
		expect(process.exitCode).not.toBe(1);
		await handleMcpCommand(["mcp", "get", "nope"]);
		expect(process.exitCode).toBe(1);
		process.exitCode = undefined;
	});
});
