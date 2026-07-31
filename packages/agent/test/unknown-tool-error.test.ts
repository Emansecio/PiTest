import { afterEach, describe, expect, it } from "vitest";
import { formatUnknownToolError, setUnknownToolHintProvider } from "../src/agent-loop.js";
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
	it("includes the available tool list, nearest name first", () => {
		const error = formatUnknownToolError("readd", makeToolMap(["read", "bash", "edit", "write"]));
		expect(error).toContain('Tool "readd" not found.');
		// Proximity order, not alphabetical: the listing is capped, so the tools
		// closest to what the model asked for must survive the cut.
		expect(error).toMatch(/Available tools: read, bash, edit, write\./);
	});

	it("keeps near matches inside the cap on a large, namespace-heavy surface", () => {
		const noise = Array.from({ length: 24 }, (_, i) => `chrome_devtools_action_${String(i).padStart(2, "0")}`);
		const error = formatUnknownToolError("write_file", makeToolMap([...noise, "write", "read"]));
		const listed = /Available tools: ([^…]*), …/.exec(error)?.[1].split(", ") ?? [];
		expect(listed).toHaveLength(16);
		expect(listed[0]).toBe("write");
		expect(listed).toContain("read");
		expect(error).toMatch(/… \(10 more\)\./);
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

describe("formatUnknownToolError + hidden-tool hint provider", () => {
	afterEach(() => setUnknownToolHintProvider(undefined));

	it("appends the provider hint when no active tool is close", () => {
		setUnknownToolHintProvider((name) => (name === "query_sqlite" ? "HIDDEN_HINT" : undefined));
		const error = formatUnknownToolError("query_sqlite", makeToolMap(["read", "bash"]));
		expect(error).toContain("HIDDEN_HINT");
	});

	it("prefers an active-tool 'did you mean' over the hidden hint", () => {
		let called = false;
		setUnknownToolHintProvider(() => {
			called = true;
			return "HIDDEN_HINT";
		});
		const error = formatUnknownToolError("readd", makeToolMap(["read", "bash"]));
		expect(error).toContain('Did you mean "read"?');
		expect(error).not.toContain("HIDDEN_HINT");
		expect(called).toBe(false);
	});

	it("is fail-open when the provider throws", () => {
		setUnknownToolHintProvider(() => {
			throw new Error("boom");
		});
		const error = formatUnknownToolError("totally_unrelated_xyz", makeToolMap(["read", "bash"]));
		expect(error).toContain('Tool "totally_unrelated_xyz" not found.');
	});
});
