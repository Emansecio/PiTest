import { describe, expect, it } from "vitest";
import {
	compactToolSchemaForWire,
	compactWireToolSurface,
	sortToolsForWireCache,
} from "../src/core/tool-wire-schema.js";

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
});

describe("sortToolsForWireCache (E2)", () => {
	it("sorts tools by name for stable cache keys", () => {
		const sorted = sortToolsForWireCache([{ name: "write" }, { name: "bash" }, { name: "read" }]);
		expect(sorted.map((t) => t.name)).toEqual(["bash", "read", "write"]);
	});
});
