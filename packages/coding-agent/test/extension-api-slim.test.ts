/**
 * Guard: slim extension-api must not pull agent-session or the full tools registry.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionApiPath = join(__dirname, "../src/extension-api.ts");

describe("extension-api slim surface", () => {
	it("source does not import agent-session or tools/index", () => {
		const source = readFileSync(extensionApiPath, "utf8");
		expect(source).not.toMatch(/from\s+["'][^"']*agent-session/);
		expect(source).not.toMatch(/from\s+["'][^"']*tools\/index/);
		expect(source).not.toMatch(/from\s+["']\.\/index/);
	});

	it("exports defineTool / getAgentDir / createBashTool", async () => {
		const mod = await import(pathToFileURL(extensionApiPath).href);
		expect(typeof mod.defineTool).toBe("function");
		expect(typeof mod.getAgentDir).toBe("function");
		expect(typeof mod.createBashTool).toBe("function");
		expect(typeof mod.withFileMutationQueue).toBe("function");
	});
});
