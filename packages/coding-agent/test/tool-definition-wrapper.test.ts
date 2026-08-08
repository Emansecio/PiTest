import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { brandCoordinatorTool, isCoordinatorTool } from "../src/core/coordinator/brand.js";
import type { ToolDefinition } from "../src/core/extensions/types.js";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.js";

function fakeTaskDefinition(): ToolDefinition {
	return {
		name: "task",
		label: "task",
		description: "test task",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
	};
}

describe("wrapToolDefinition trusted metadata", () => {
	it("preserves the native coordinator brand", () => {
		const definition = brandCoordinatorTool(fakeTaskDefinition());

		expect(isCoordinatorTool(definition)).toBe(true);
		expect(isCoordinatorTool(wrapToolDefinition(definition))).toBe(true);
	});

	it("does not brand an unbranded lookalike or copy arbitrary symbols", () => {
		const arbitrary = Symbol("untrusted");
		const definition = Object.assign(fakeTaskDefinition(), { [arbitrary]: true });
		const wrapped = wrapToolDefinition(definition);

		expect(isCoordinatorTool(wrapped)).toBe(false);
		expect(Reflect.get(wrapped, arbitrary)).toBeUndefined();
	});
});
