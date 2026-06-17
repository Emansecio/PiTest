/**
 * Tests for MCP config-file loading, scope precedence, and env interpolation.
 */

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file intentionally tests literal ${VAR} interpolation fixtures.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeMcpSettings, loadMcpConfigFiles, resolveServerConfig } from "../src/core/mcp/config-files.js";
import { interpolateEnvVars } from "../src/core/resolve-config-value.js";

describe("interpolateEnvVars", () => {
	it("expands ${VAR} and ${VAR:-default} with CC semantics", () => {
		const env = { TOKEN: "secret", EMPTY: "" } as NodeJS.ProcessEnv;
		expect(interpolateEnvVars("Bearer ${TOKEN}", env)).toBe("Bearer secret");
		expect(interpolateEnvVars("${MISSING:-fallback}", env)).toBe("fallback");
		expect(interpolateEnvVars("${EMPTY:-fb}", env)).toBe("fb"); // empty → default
		expect(interpolateEnvVars("${MISSING}", env)).toBe(""); // unset, no default → ""
		expect(interpolateEnvVars("plain text", env)).toBe("plain text");
	});
});

describe("loadMcpConfigFiles + composeMcpSettings", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pit-mcp-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("loads CC-format .mcp.json (mcpServers + type→transport)", () => {
		writeFileSync(
			join(dir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					fs: { type: "stdio", command: "npx", args: ["-y", "server-filesystem"] },
					remote: { type: "http", url: "https://example.com/mcp" },
				},
			}),
		);
		const files = loadMcpConfigFiles(dir, join(dir, "agent"));
		expect(files.project.fs).toEqual({ transport: "stdio", command: "npx", args: ["-y", "server-filesystem"] });
		expect(files.project.remote).toEqual({ transport: "http", url: "https://example.com/mcp" });
	});

	it("applies precedence: local > project settings > .mcp.json > global settings", () => {
		writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { a: { url: "http://project-file" } } }));
		writeFileSync(join(dir, ".mcp.local.json"), JSON.stringify({ mcpServers: { a: { url: "http://local" } } }));
		const files = loadMcpConfigFiles(dir, join(dir, "agent"));
		const composed = composeMcpSettings(
			{
				global: { servers: { a: { url: "http://global" }, g: { url: "http://global-only" } }, defer: "never" },
				project: { servers: { a: { url: "http://project-settings" } }, defer: "always" },
			},
			files,
		);
		// local wins for `a`; global-only `g` survives; project defer policy wins.
		expect(composed.servers?.a.url).toBe("http://local");
		expect(composed.servers?.g.url).toBe("http://global-only");
		expect(composed.defer).toBe("always");
	});

	it("resolveServerConfig interpolates url/headers/env/args", () => {
		process.env.PIT_TEST_TOKEN = "abc123";
		const resolved = resolveServerConfig({
			url: "https://api/${PIT_TEST_MISSING:-v1}",
			headers: { Authorization: "Bearer ${PIT_TEST_TOKEN}" },
			env: { KEY: "${PIT_TEST_TOKEN}" },
			args: ["--token", "${PIT_TEST_TOKEN}"],
		});
		expect(resolved.url).toBe("https://api/v1");
		expect(resolved.headers).toEqual({ Authorization: "Bearer abc123" });
		expect(resolved.env).toEqual({ KEY: "abc123" });
		expect(resolved.args).toEqual(["--token", "abc123"]);
		delete process.env.PIT_TEST_TOKEN;
	});
});
