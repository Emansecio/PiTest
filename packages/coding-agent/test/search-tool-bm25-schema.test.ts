import { describe, expect, it } from "vitest";
import { createSearchToolBm25Definition } from "../src/core/tools/search-tool-bm25.js";

describe("search_tool_bm25 schema", () => {
	it("declares limit bounds matching the runtime clamp (1..15)", () => {
		const def = createSearchToolBm25Definition("/tmp");
		const schema = def.parameters as {
			properties: { limit: { minimum?: number; maximum?: number } };
		};
		expect(schema.properties.limit.minimum).toBe(1);
		expect(schema.properties.limit.maximum).toBe(15);
	});

	it("states the activate_top mechanics in exactly one place", () => {
		const def = createSearchToolBm25Definition("/tmp");
		const schema = def.parameters as {
			properties: { activate_top: { description?: string } };
		};
		const fieldDescription = schema.properties.activate_top.description ?? "";
		const toolDescription = def.description ?? "";

		// Canonical statement of the condition + effect lives on the field itself.
		expect(fieldDescription).toContain("joins the active tool surface");
		// Built-ins carry no promptGuidelines (dead for builtins), and the
		// top-level description does not restate the activation mechanics.
		expect(def.promptGuidelines).toBeUndefined();
		expect(toolDescription).not.toContain("active tool surface");
		expect(toolDescription).not.toContain("becomes callable");
	});
});
