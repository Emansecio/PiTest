import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.js";
import { stripNullishOptionalArgs, validateToolArguments } from "../src/utils/validation.js";

function createToolCallWithPlainSchema(
	schema: Tool["parameters"],
	value: unknown,
): {
	tool: Tool;
	toolCall: ToolCall;
} {
	const tool: Tool = {
		name: "echo",
		description: "Echo tool",
		parameters: {
			type: "object",
			properties: {
				value: schema,
			},
			required: ["value"],
		} as Tool["parameters"],
	};

	const toolCall: ToolCall = {
		type: "toolCall",
		id: "tool-1",
		name: "echo",
		arguments: { value },
	};

	return { tool, toolCall };
}

describe("validateToolArguments", () => {
	it("still validates when Function constructor is unavailable", () => {
		const originalFunction = globalThis.Function;
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				count: Type.Number(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { count: "42" as unknown as number },
		};

		globalThis.Function = (() => {
			throw new EvalError("Code generation from strings disallowed for this context");
		}) as unknown as FunctionConstructor;

		try {
			expect(validateToolArguments(tool, toolCall)).toEqual({ count: 42 });
		} finally {
			globalThis.Function = originalFunction;
		}
	});

	it("coerces serialized plain JSON schemas with AJV-compatible primitive rules", () => {
		const passingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
			expected: unknown;
		}> = [
			{ schema: { type: "number" } as Tool["parameters"], input: "42", expected: 42 },
			{ schema: { type: "number" } as Tool["parameters"], input: true, expected: 1 },
			{ schema: { type: "number" } as Tool["parameters"], input: null, expected: 0 },
			{ schema: { type: "integer" } as Tool["parameters"], input: "42", expected: 42 },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "true", expected: true },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "false", expected: false },
			{ schema: { type: "boolean" } as Tool["parameters"], input: 1, expected: true },
			{ schema: { type: "boolean" } as Tool["parameters"], input: 0, expected: false },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "1", expected: true },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "0", expected: false },
			{ schema: { type: "string" } as Tool["parameters"], input: null, expected: "" },
			{ schema: { type: "string" } as Tool["parameters"], input: true, expected: "true" },
			{ schema: { type: "null" } as Tool["parameters"], input: "", expected: null },
			{ schema: { type: "null" } as Tool["parameters"], input: 0, expected: null },
			{ schema: { type: "null" } as Tool["parameters"], input: false, expected: null },
			{
				schema: { type: ["number", "string"] } as Tool["parameters"],
				input: "1",
				expected: "1",
			},
			{
				schema: { type: ["boolean", "number"] } as Tool["parameters"],
				input: "1",
				expected: 1,
			},
		];

		for (const testCase of passingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(validateToolArguments(tool, toolCall)).toEqual({ value: testCase.expected });
		}
	});

	it("rejects invalid coercions for serialized plain JSON schemas", () => {
		const failingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
		}> = [
			{ schema: { type: "null" } as Tool["parameters"], input: "null" },
			{ schema: { type: "integer" } as Tool["parameters"], input: "42.1" },
		];

		for (const testCase of failingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
		}
	});

	it("appends a did-you-mean hint when args carry a misspelled key", () => {
		// DYM targets lexical typos (offse→offset, pat→path). Semantic aliases
		// like start_line→offset are handled by the rewrite registry's Tier 1
		// rules, not by Levenshtein, and intentionally fall through here.
		const tool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					offset: { type: "number" },
					limit: { type: "number" },
				},
				required: ["path"],
				additionalProperties: false,
			} as Tool["parameters"],
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "t1",
			name: "read",
			arguments: { pat: "foo", offse: 5 },
		};
		const error = (() => {
			try {
				validateToolArguments(tool, toolCall);
				return undefined;
			} catch (e) {
				return e instanceof Error ? e.message : String(e);
			}
		})();
		expect(error).toBeDefined();
		expect(error).toContain('Did you mean "path" instead of "pat"');
		expect(error).toContain('Did you mean "offset" instead of "offse"');
	});

	it("omits did-you-mean when no valid key is close enough", () => {
		const tool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
				},
				required: ["path"],
				additionalProperties: false,
			} as Tool["parameters"],
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "t1",
			name: "read",
			arguments: { path: "x", completely_unrelated_field_zzz: 1 },
		};
		const error = (() => {
			try {
				validateToolArguments(tool, toolCall);
				return undefined;
			} catch (e) {
				return e instanceof Error ? e.message : String(e);
			}
		})();
		expect(error).toBeDefined();
		expect(error).not.toContain("Did you mean");
	});
});

describe("stripNullishOptionalArgs", () => {
	const schema = {
		type: "object",
		properties: {
			path: { type: "string" },
			pattern: { type: "string" },
			limit: { type: "number" },
			options: { type: "object", properties: { deep: { type: "boolean" } } },
			nullable: { type: ["string", "null"] },
		},
		required: ["path"],
	};

	it("drops an optional field whose value is null when the schema rejects null", () => {
		expect(stripNullishOptionalArgs({ path: "a", pattern: null }, schema)).toEqual({ path: "a" });
	});

	it("drops an optional field whose value is an empty object placeholder", () => {
		expect(stripNullishOptionalArgs({ path: "a", limit: {} }, schema)).toEqual({ path: "a" });
	});

	it("keeps null on a required field — dropping would only trade one error for another", () => {
		expect(stripNullishOptionalArgs({ path: null, pattern: "x" }, schema)).toEqual({ path: null, pattern: "x" });
	});

	it("keeps null when the field's schema legitimately accepts null", () => {
		expect(stripNullishOptionalArgs({ path: "a", nullable: null }, schema)).toEqual({ path: "a", nullable: null });
	});

	it("keeps an empty object when the field is typed as object", () => {
		expect(stripNullishOptionalArgs({ path: "a", options: {} }, schema)).toEqual({ path: "a", options: {} });
	});

	it("ignores keys not declared in the schema (additionalProperties)", () => {
		const input = { path: "a", extra: null };
		expect(stripNullishOptionalArgs(input, schema)).toBe(input);
	});

	it("returns the same reference when nothing is dropped", () => {
		const input = { path: "a", pattern: "x" };
		expect(stripNullishOptionalArgs(input, schema)).toBe(input);
	});

	it("makes validateToolArguments accept a null optional by omission, not coercion to ''", () => {
		const tool: Tool = {
			name: "read",
			description: "read",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, pattern: { type: "string" } },
				required: ["path"],
			} as Tool["parameters"],
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "t1",
			name: "read",
			arguments: { path: "a", pattern: null },
		};
		expect(validateToolArguments(tool, toolCall)).toEqual({ path: "a" });
	});
});

describe("coerceJsonStringArrays (via validateToolArguments)", () => {
	const editTool = (): Tool => ({
		name: "edit",
		description: "edit",
		parameters: Type.Object({
			path: Type.String(),
			edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
		}),
	});

	it("parses a JSON-stringified array for an array-typed field on a TypeBox tool", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "t1",
			name: "edit",
			arguments: { path: "a.ts", edits: '[{"oldText":"x","newText":"y"}]' } as unknown as Record<string, unknown>,
		};
		expect(validateToolArguments(editTool(), toolCall)).toEqual({
			path: "a.ts",
			edits: [{ oldText: "x", newText: "y" }],
		});
	});

	it("coerces JSON-string array on a plain (non-TypeBox) schema too", () => {
		const tool: Tool = {
			name: "todo",
			description: "todo",
			parameters: {
				type: "object",
				properties: { items: { type: "array", items: { type: "string" } } },
				required: ["items"],
			} as Tool["parameters"],
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "t1",
			name: "todo",
			arguments: { items: '["a","b"]' },
		};
		expect(validateToolArguments(tool, toolCall)).toEqual({ items: ["a", "b"] });
	});

	it("leaves the string alone when the field also accepts string", () => {
		const tool: Tool = {
			name: "echo",
			description: "echo",
			parameters: {
				type: "object",
				properties: { value: { type: ["string", "array"] } },
				required: ["value"],
			} as Tool["parameters"],
		};
		const toolCall: ToolCall = { type: "toolCall", id: "t1", name: "echo", arguments: { value: '["a"]' } };
		expect(validateToolArguments(tool, toolCall)).toEqual({ value: '["a"]' });
	});

	it("throws a validation error (does not coerce) when the string is not JSON", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "t1",
			name: "edit",
			arguments: { path: "a.ts", edits: "not json" } as unknown as Record<string, unknown>,
		};
		expect(() => validateToolArguments(editTool(), toolCall)).toThrow(/Validation failed/);
	});

	it("throws when the string parses to a non-array (scalar JSON)", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "t1",
			name: "edit",
			arguments: { path: "a.ts", edits: '"oops"' } as unknown as Record<string, unknown>,
		};
		expect(() => validateToolArguments(editTool(), toolCall)).toThrow(/Validation failed/);
	});
});
