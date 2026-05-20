import { describe, expect, it } from "vitest";
import { formatUnknownToolError } from "../src/agent-loop.js";
import type { AgentTool } from "../src/types.js";

function makeToolMap(names: string[]): Map<string, AgentTool<any>> {
	const map = new Map<string, AgentTool<any>>();
	for (const name of names) {
		map.set(name, {
			name,
			label: name,
			description: "",
			parameters: { type: "object", additionalProperties: false } as any,
			execute: async () => ({ content: [], details: {} }),
		});
	}
	return map;
}

describe("formatUnknownToolError", () => {
	it("includes the available tool list", () => {
		const error = formatUnknownToolError("readd", makeToolMap(["read", "bash", "edit", "write"]));
		expect(error).toContain('Tool "readd" not found.');
		expect(error).toMatch(/Available tools: bash, edit, read, write\./);
	});

	it("suggests the nearest tool name", () => {
		const error = formatUnknownToolError("readd", makeToolMap(["read", "bash", "edit", "write"]));
		expect(error).toContain('Did you mean "read"?');
	});

	it("omits the suggestion line when nothing is close enough", () => {
		const error = formatUnknownToolError("totally-different", makeToolMap(["read", "bash"]));
		expect(error).not.toContain("Did you mean");
	});

	it("falls back gracefully on an empty tool map", () => {
		const error = formatUnknownToolError("x", makeToolMap([]));
		expect(error).toBe('Tool "x" not found.');
	});

	it("truncates the listing for very large registries", () => {
		const names = Array.from({ length: 30 }, (_, i) => `t${String(i).padStart(2, "0")}`);
		const error = formatUnknownToolError("missing", makeToolMap(names));
		expect(error).toMatch(/\u2026 \(14 more\)\./);
	});

	it("is case-insensitive when picking suggestions", () => {
		const error = formatUnknownToolError("READ", makeToolMap(["read"]));
		expect(error).toContain('Did you mean "read"?');
	});
});
