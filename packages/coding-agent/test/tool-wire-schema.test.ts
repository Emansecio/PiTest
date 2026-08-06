import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	agentToolToWireSurface,
	compactToolSchemaForWire,
	compactToolsForProviderContext,
	compactWireToolSurface,
	LAZY_TOOL_DESCRIPTION_MAX_CHARS,
	WIRE_TOOL_SNIPPET_MAX_CHARS,
} from "../src/core/tool-wire-schema.js";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.js";

describe("compactToolSchemaForWire (E1)", () => {
	it("strips nested property descriptions", () => {
		const schema = {
			type: "object",
			properties: {
				path: { type: "string", description: "File path to read" },
				offset: { type: "number", description: "Start line" },
			},
			required: ["path"],
		};
		const compact = compactToolSchemaForWire(schema) as {
			properties: Record<string, { type?: string; description?: string }>;
			required: string[];
		};
		expect(compact.properties.path.description).toBeUndefined();
		expect(compact.properties.path.type).toBe("string");
		expect(compact.required).toEqual(["path"]);
	});

	it("preserves a property literally named title (exit_plan)", () => {
		const schema = {
			type: "object",
			required: ["title"],
			properties: {
				title: { type: "string", description: "Plan title" },
				summary: { type: "string", description: "Optional summary" },
			},
			additionalProperties: false,
		};
		const compact = compactToolSchemaForWire(schema) as {
			properties: Record<string, { type?: string; description?: string }>;
			required: string[];
		};
		expect(compact.properties.title).toEqual({ type: "string" });
		expect(compact.properties.title.description).toBeUndefined();
		expect(compact.required).toEqual(["title"]);
	});
});

describe("compactToolsForProviderContext", () => {
	it("reuses the compacted surface while the tools array is unchanged", () => {
		const tools = [
			{
				name: "read",
				description: "Read a file\nLong provider-only prose",
				parameters: { type: "object", properties: { path: { type: "string", description: "Path" } } },
			},
		];
		const first = compactToolsForProviderContext({ messages: [], tools });
		const second = compactToolsForProviderContext({ messages: [], tools });

		expect(second.tools).toBe(first.tools);
		expect(second.tools).not.toBe(tools);
	});
});

describe("compactWireToolSurface (E1)", () => {
	it("shortens multi-line descriptions", () => {
		const out = compactWireToolSurface({
			name: "read",
			description: "Read a file\n\nLong body that should not ship on wire.",
			parameters: { type: "object", properties: {} },
		});
		expect(out.description).toBe("Read a file");
		expect(out.description).not.toContain("Long body");
	});

	it("truncates long first-line descriptions to the wire stub budget (T01)", () => {
		expect(LAZY_TOOL_DESCRIPTION_MAX_CHARS).toBe(110);
		const long = `Structural code search via ast-grep with metavariables and language pins for large repos. ${"x".repeat(200)}`;
		const out = compactWireToolSurface({
			name: "ast_grep",
			description: long,
			parameters: { type: "object", properties: {} },
		});
		expect(out.description.length).toBeLessThanOrEqual(LAZY_TOOL_DESCRIPTION_MAX_CHARS);
		expect(out.description.endsWith("…")).toBe(true);
		expect(out.description).not.toBe(long);
	});

	it("keeps a first line that fits the 110-char fallback budget intact", () => {
		const line = "Structural code search via ast-grep with metavariables and language pins for large repos";
		expect(line.length).toBeGreaterThan(40);
		expect(line.length).toBeLessThanOrEqual(LAZY_TOOL_DESCRIPTION_MAX_CHARS);
		const out = compactWireToolSurface({
			name: "ast_grep",
			description: line,
			parameters: { type: "object", properties: {} },
		});
		expect(out.description).toBe(line);
	});

	it("ships the hand-written promptSnippet verbatim instead of a truncated first line (T01)", () => {
		const snippet =
			"Read file contents (text, images, PDFs); outline:true for a symbol map; pr:// issue:// conflict:// paths";
		const out = compactWireToolSurface({
			name: "read",
			description:
				"Read the contents of a file. Supports text files, images (jpg, png, gif, webp), and PDFs.\n\nNever…",
			promptSnippet: snippet,
			parameters: { type: "object", properties: {} },
		});
		expect(out.description).toBe(snippet);
		expect(out.description.endsWith("…")).toBe(false);
		// Folded into `description`; never carried (and counted) twice.
		expect(out.promptSnippet).toBeUndefined();
	});

	it("collapses a multi-line snippet to one line", () => {
		const out = compactWireToolSurface({
			name: "custom",
			description: "Long provider prose",
			promptSnippet: "  Do a thing\n   and then another  ",
			parameters: { type: "object", properties: {} },
		});
		expect(out.description).toBe("Do a thing and then another");
	});

	it("caps an oversized snippet at the defensive snippet budget", () => {
		expect(WIRE_TOOL_SNIPPET_MAX_CHARS).toBe(140);
		const out = compactWireToolSurface({
			name: "verbose_extension_tool",
			description: "short first line",
			promptSnippet: "y".repeat(400),
			parameters: { type: "object", properties: {} },
		});
		expect(out.description.length).toBeLessThanOrEqual(WIRE_TOOL_SNIPPET_MAX_CHARS);
		expect(out.description.endsWith("…")).toBe(true);
	});
});

describe("promptSnippet propagation to the wire (T01)", () => {
	it("carries the snippet from ToolDefinition through wrapToolDefinition to the wire surface", () => {
		const tool = wrapToolDefinition({
			name: "demo",
			label: "demo",
			description: "A very long description whose first line would otherwise be cut mid-word on the provider wire.",
			promptSnippet: "Do exactly one demo thing",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: undefined }),
		});
		expect((tool as { promptSnippet?: string }).promptSnippet).toBe("Do exactly one demo thing");
		const surface = agentToolToWireSurface(tool);
		expect(surface.promptSnippet).toBe("Do exactly one demo thing");
		expect(compactWireToolSurface(surface).description).toBe("Do exactly one demo thing");
		// Round-trip back to a definition (SDK baseToolsOverride path) keeps it.
		expect(createToolDefinitionFromAgentTool(tool).promptSnippet).toBe("Do exactly one demo thing");
	});

	it("falls back to the 110-char first line for snippet-less tools (MCP / extensions)", () => {
		const tool = wrapToolDefinition({
			name: "mcp_thing",
			label: "mcp_thing",
			description: `An MCP tool with no snippet at all, whose description is long. ${"z".repeat(200)}`,
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: undefined }),
		});
		expect((tool as { promptSnippet?: string }).promptSnippet).toBeUndefined();
		const wire = compactWireToolSurface(agentToolToWireSurface(tool));
		expect(wire.description.length).toBeLessThanOrEqual(LAZY_TOOL_DESCRIPTION_MAX_CHARS);
		expect(wire.description.startsWith("An MCP tool with no snippet")).toBe(true);
		expect(wire.description.endsWith("…")).toBe(true);
	});

	it("uses the snippet on the provider-context path too", () => {
		const tools = [
			Object.assign(
				{
					name: "read",
					description: "Read the contents of a file. Supports text files, images, and PDFs.",
					parameters: { type: "object", properties: {} },
				},
				{ promptSnippet: "Read file contents; outline:true for a symbol map" },
			),
		];
		const compacted = compactToolsForProviderContext({ messages: [], tools });
		expect(compacted.tools?.[0].description).toBe("Read file contents; outline:true for a symbol map");
	});
});
