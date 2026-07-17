import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getToolArgRepairStats,
	repairToolArguments,
	resetToolArgRepairStats,
	type ToolArgRepairKind,
} from "../src/tool-arg-repair.js";
import { ToolRewriteRegistry } from "../src/tool-rewrite-registry.js";
import type { AgentToolCall } from "../src/types.js";

// Minimal JSON-schema builders (typebox schemas ARE JSON Schema at runtime; the
// repair module only reads the JSON-schema surface, so plain objects suffice).
function obj(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
	return { type: "object", properties, required };
}

const TOOL = "test_tool";

/** Run repair and return the applied kinds for a concise assertion. */
function kinds(rawArgs: unknown, schema: unknown): ToolArgRepairKind[] {
	return repairToolArguments(rawArgs, schema, TOOL).repairs;
}

beforeEach(() => resetToolArgRepairStats());
afterEach(() => {
	delete process.env.PIT_NO_TOOLCALL_REPAIR;
});

describe("structural repair (whole-arguments string)", () => {
	const anySchema = obj({}); // no declared properties → Tier B is a no-op

	it("parses a fenced ```json block", () => {
		const raw = '```json\n{"path": "a.ts"}\n```';
		const out = repairToolArguments(raw, anySchema, TOOL);
		expect(out.args).toEqual({ path: "a.ts" });
		expect(out.repairs).toContain("fence_strip");
		expect(out.repairs).toContain("structural_json");
	});

	it("repairs trailing commas via jsonrepair", () => {
		const out = repairToolArguments('{"a": 1, "b": 2,}', anySchema, TOOL);
		expect(out.args).toEqual({ a: 1, b: 2 });
		expect(out.repairs).toContain("structural_json");
	});

	it("repairs single-quoted JSON via jsonrepair", () => {
		const out = repairToolArguments("{'a': 'x'}", anySchema, TOOL);
		expect(out.args).toEqual({ a: "x" });
	});

	it("repairs Python True/None via jsonrepair", () => {
		const out = repairToolArguments('{"ok": True, "val": None}', anySchema, TOOL);
		expect(out.args).toEqual({ ok: true, val: null });
	});

	it("repairs unquoted keys via jsonrepair", () => {
		const out = repairToolArguments('{path: "a.ts", n: 3}', anySchema, TOOL);
		expect(out.args).toEqual({ path: "a.ts", n: 3 });
	});

	it("leaves an unparseable string untouched (same reference, no repairs)", () => {
		const raw = "this is not json at all {{{";
		const out = repairToolArguments(raw, anySchema, TOOL);
		expect(out.args).toBe(raw);
		expect(out.repairs).toEqual([]);
	});
});

describe("schema coercion — numbers", () => {
	it('coerces "42" → 42 for a number field', () => {
		const out = repairToolArguments({ n: "42" }, obj({ n: { type: "number" } }), TOOL);
		expect(out.args).toEqual({ n: 42 });
		expect(out.repairs).toEqual(["number_from_string"]);
	});

	it('coerces "4.2" → 4.2 for a number field', () => {
		const out = repairToolArguments({ n: "4.2" }, obj({ n: { type: "number" } }), TOOL);
		expect(out.args).toEqual({ n: 4.2 });
	});

	it('coerces "42" → 42 for an integer field', () => {
		const out = repairToolArguments({ n: "42" }, obj({ n: { type: "integer" } }), TOOL);
		expect(out.args).toEqual({ n: 42 });
	});

	it('does NOT coerce "4.2" for an integer field', () => {
		expect(kinds({ n: "4.2" }, obj({ n: { type: "integer" } }))).toEqual([]);
	});

	it("does NOT coerce non-strict numeric strings", () => {
		expect(kinds({ n: "42abc" }, obj({ n: { type: "number" } }))).toEqual([]);
		expect(kinds({ n: "0x10" }, obj({ n: { type: "number" } }))).toEqual([]);
		expect(kinds({ n: "" }, obj({ n: { type: "number" } }, ["n"]))).toEqual([]);
	});

	it("leaves an already-numeric value untouched (same reference)", () => {
		const args = { n: 42 };
		const out = repairToolArguments(args, obj({ n: { type: "number" } }), TOOL);
		expect(out.args).toBe(args);
		expect(out.repairs).toEqual([]);
	});

	it("does NOT coerce when the field also accepts string", () => {
		expect(kinds({ n: "42" }, obj({ n: { type: ["string", "number"] } }))).toEqual([]);
	});
});

describe("schema coercion — booleans", () => {
	it('coerces "true"/"false" → boolean', () => {
		expect(repairToolArguments({ b: "true" }, obj({ b: { type: "boolean" } }), TOOL).args).toEqual({ b: true });
		expect(repairToolArguments({ b: "false" }, obj({ b: { type: "boolean" } }), TOOL).args).toEqual({ b: false });
	});

	it("is case-insensitive on the literal", () => {
		expect(repairToolArguments({ b: "TRUE" }, obj({ b: { type: "boolean" } }), TOOL).args).toEqual({ b: true });
	});

	it("leaves an already-boolean value untouched", () => {
		const args = { b: true };
		expect(repairToolArguments(args, obj({ b: { type: "boolean" } }), TOOL).args).toBe(args);
	});

	it('does NOT coerce a non-literal like "yes"', () => {
		expect(kinds({ b: "yes" }, obj({ b: { type: "boolean" } }))).toEqual([]);
	});
});

describe("schema coercion — empty string", () => {
	it("drops an empty string for an optional non-string field", () => {
		const out = repairToolArguments({ n: "" }, obj({ n: { type: "number" } }), TOOL);
		expect(out.args).toEqual({});
		expect(out.repairs).toEqual(["empty_to_undefined"]);
	});

	it("coerces an empty string to null for a nullable field", () => {
		const out = repairToolArguments({ n: "" }, obj({ n: { type: ["number", "null"] } }), TOOL);
		expect(out.args).toEqual({ n: null });
		expect(out.repairs).toEqual(["empty_to_null"]);
	});

	it("keeps an empty string for a field that accepts string", () => {
		expect(kinds({ s: "" }, obj({ s: { type: "string" } }))).toEqual([]);
	});

	it("keeps an empty string for a required non-nullable non-string field (left for validation)", () => {
		expect(kinds({ n: "" }, obj({ n: { type: "number" } }, ["n"]))).toEqual([]);
	});
});

describe("schema coercion — stringified array/object", () => {
	const arrSchema = obj({ items: { type: "array", items: { type: "number" } } });
	const objSchema = obj({ meta: { type: "object", properties: { a: { type: "number" } } } });

	it('parses "[1,2]" → [1,2] for an array field', () => {
		const out = repairToolArguments({ items: "[1,2]" }, arrSchema, TOOL);
		expect(out.args).toEqual({ items: [1, 2] });
		expect(out.repairs).toContain("json_string_to_array");
	});

	it("parses '{\"a\":1}' → {a:1} for an object field", () => {
		const out = repairToolArguments({ meta: '{"a":1}' }, objSchema, TOOL);
		expect(out.args).toEqual({ meta: { a: 1 } });
		expect(out.repairs).toContain("json_string_to_object");
	});

	it("uses jsonrepair as a fallback for a malformed stringified array", () => {
		const out = repairToolArguments({ items: "[1, 2,]" }, arrSchema, TOOL);
		expect(out.args).toEqual({ items: [1, 2] });
	});

	it("coerces nested string items after parsing the array", () => {
		const out = repairToolArguments({ items: '["1","2"]' }, arrSchema, TOOL);
		expect(out.args).toEqual({ items: [1, 2] });
	});

	it("leaves an already-array value untouched (same reference)", () => {
		const args = { items: [1, 2] };
		expect(repairToolArguments(args, arrSchema, TOOL).args).toBe(args);
	});
});

describe("schema coercion — double-encoded strings", () => {
	const arrSchema = obj({ items: { type: "array", items: { type: "number" } } });

	it("unwraps a double-encoded JSON array string", () => {
		// The model sent JSON.stringify(JSON.stringify([1,2])) → a quoted string of a string.
		const doubled = JSON.stringify(JSON.stringify([1, 2]));
		const out = repairToolArguments({ items: doubled }, arrSchema, TOOL);
		expect(out.args).toEqual({ items: [1, 2] });
		expect(out.repairs).toContain("unwrap_double_encoded");
	});

	it("unwraps a triple-encoded array (within the 4-level cap)", () => {
		let s: string = JSON.stringify([1, 2]);
		s = JSON.stringify(s);
		s = JSON.stringify(s); // 3 total levels of encoding
		const out = repairToolArguments({ items: s }, arrSchema, TOOL);
		expect(out.args).toEqual({ items: [1, 2] });
		expect(out.repairs).toContain("unwrap_double_encoded");
	});

	it("terminates on pathologically deep encoding (cap prevents runaway)", () => {
		let s: string = JSON.stringify([1]);
		for (let i = 0; i < 8; i++) s = JSON.stringify(s); // 8 levels
		// The unwrap loop is hard-capped at 4; a garbage-bracket fallback may still
		// recover a valid array, but the call must terminate and yield an array —
		// never loop or throw.
		const out = repairToolArguments({ items: s }, arrSchema, TOOL);
		expect(Array.isArray((out.args as { items: unknown }).items)).toBe(true);
	});
});

describe("schema coercion — array extraction from garbage", () => {
	const arrSchema = obj({ items: { type: "array", items: { type: "number" } } });

	it('extracts a balanced [..] region from "prefix[1,2]suffix"', () => {
		const out = repairToolArguments({ items: "prefix[1,2]suffix" }, arrSchema, TOOL);
		expect(out.args).toEqual({ items: [1, 2] });
		expect(out.repairs).toContain("array_from_garbage");
	});

	it("respects quoted strings when scanning brackets", () => {
		const out = repairToolArguments(
			{ items: 'note ["a]b","c"] end' },
			obj({ items: { type: "array", items: { type: "string" } } }),
			TOOL,
		);
		expect(out.args).toEqual({ items: ["a]b", "c"] });
	});
});

describe("schema coercion — wrap single value in array", () => {
	it("wraps a single string for a string-array field", () => {
		const out = repairToolArguments(
			{ tags: "solo" },
			obj({ tags: { type: "array", items: { type: "string" } } }),
			TOOL,
		);
		expect(out.args).toEqual({ tags: ["solo"] });
		expect(out.repairs).toEqual(["wrap_single_in_array"]);
	});

	it("wraps a single number for a number-array field", () => {
		const out = repairToolArguments({ ids: 5 }, obj({ ids: { type: "array", items: { type: "number" } } }), TOOL);
		expect(out.args).toEqual({ ids: [5] });
		expect(out.repairs).toEqual(["wrap_single_in_array"]);
	});

	it("coerces the wrapped element to the item type", () => {
		const out = repairToolArguments({ ids: "5" }, obj({ ids: { type: "array", items: { type: "number" } } }), TOOL);
		expect(out.args).toEqual({ ids: [5] });
	});

	it("does NOT wrap when the value cannot fit the item type", () => {
		expect(kinds({ ids: true }, obj({ ids: { type: "array", items: { type: "number" } } }))).toEqual([]);
	});
});

describe("schema coercion — enums", () => {
	const enumSchema = obj({ mode: { type: "string", enum: ["read", "write"] } });

	it("fixes case-insensitively to the canonical member", () => {
		const out = repairToolArguments({ mode: "READ" }, enumSchema, TOOL);
		expect(out.args).toEqual({ mode: "read" });
		expect(out.repairs).toEqual(["enum_case_fix"]);
	});

	it("leaves an exact member untouched", () => {
		expect(kinds({ mode: "write" }, enumSchema)).toEqual([]);
	});

	it("does NOT coerce a non-member value", () => {
		expect(kinds({ mode: "delete" }, enumSchema)).toEqual([]);
	});

	it("never applies numeric coercion to an enum field", () => {
		// enum wins: "1" is not a case-insensitive member, so no coercion at all.
		expect(kinds({ mode: "1" }, obj({ mode: { type: "string", enum: ["read"] } }))).toEqual([]);
	});
});

describe("nested coercion", () => {
	it("coerces values inside a nested object", () => {
		const schema = obj({
			opts: { type: "object", properties: { count: { type: "number" }, on: { type: "boolean" } } },
		});
		const out = repairToolArguments({ opts: { count: "3", on: "true" } }, schema, TOOL);
		expect(out.args).toEqual({ opts: { count: 3, on: true } });
	});

	it("coerces each element of an array of objects", () => {
		const schema = obj({ rows: { type: "array", items: { type: "object", properties: { x: { type: "number" } } } } });
		const out = repairToolArguments({ rows: [{ x: "1" }, { x: "2" }] }, schema, TOOL);
		expect(out.args).toEqual({ rows: [{ x: 1 }, { x: 2 }] });
	});
});

describe("no-op behavior", () => {
	it("returns the exact same reference when nothing changed", () => {
		const args = { path: "a.ts", n: 3, ok: true };
		const schema = obj({ path: { type: "string" }, n: { type: "number" }, ok: { type: "boolean" } });
		expect(repairToolArguments(args, schema, TOOL).args).toBe(args);
	});

	it("ignores keys not declared in the schema", () => {
		expect(kinds({ unknown_key: "5" }, obj({ known: { type: "number" } }))).toEqual([]);
	});
});

describe("kill-switch (PIT_NO_TOOLCALL_REPAIR)", () => {
	it("disables both tiers when set to 1", () => {
		process.env.PIT_NO_TOOLCALL_REPAIR = "1";
		const args = { n: "42" };
		const out = repairToolArguments(args, obj({ n: { type: "number" } }), TOOL);
		expect(out.args).toBe(args); // untouched, same reference
		expect(out.repairs).toEqual([]);
		// And structural is disabled too.
		const raw = '```json\n{"a":1}\n```';
		expect(repairToolArguments(raw, obj({}), TOOL).args).toBe(raw);
	});

	it("stays enabled for other/absent values", () => {
		process.env.PIT_NO_TOOLCALL_REPAIR = "0";
		expect(kinds({ n: "42" }, obj({ n: { type: "number" } }))).toEqual(["number_from_string"]);
	});
});

describe("stats counter", () => {
	it("counts repairs per (tool, kind) and per kind", () => {
		repairToolArguments({ n: "42" }, obj({ n: { type: "number" } }), "alpha");
		repairToolArguments({ b: "true" }, obj({ b: { type: "boolean" } }), "alpha");
		repairToolArguments({ n: "7" }, obj({ n: { type: "number" } }), "beta");

		const stats = getToolArgRepairStats();
		expect(stats.total).toBe(3);
		expect(stats.byKind.number_from_string).toBe(2);
		expect(stats.byKind.boolean_from_string).toBe(1);
		expect(stats.byTool.alpha).toEqual({ number_from_string: 1, boolean_from_string: 1 });
		expect(stats.byTool.beta).toEqual({ number_from_string: 1 });
	});

	it("does not count no-op calls", () => {
		repairToolArguments({ n: 42 }, obj({ n: { type: "number" } }), "alpha");
		expect(getToolArgRepairStats().total).toBe(0);
	});
});

describe("precedence — registry rewrite wins, then repair coerces on top", () => {
	function call(name: string, args: Record<string, unknown>): AgentToolCall {
		return { type: "toolCall", id: "1", name, arguments: args } as AgentToolCall;
	}

	it("applies the curated rewrite first, then coercion", () => {
		// Registry renames `file` → `path` (curated). Repair then coerces the sibling
		// numeric string. This mirrors the agent-loop order (registry, then repair).
		const registry = new ToolRewriteRegistry();
		registry.add({
			id: "rename-file-to-path",
			appliesTo: "read",
			matcher: (c) => "file" in (c.arguments as Record<string, unknown>),
			action: {
				tier: "auto",
				rewrite: (c) => {
					const { file, ...rest } = c.arguments as Record<string, unknown>;
					return { ...c, arguments: { ...rest, path: file } };
				},
			},
		});

		const outcome = registry.apply(call("read", { file: "a.ts", offset: "10" }));
		expect(outcome.kind).toBe("rewritten");
		const rewritten = outcome.kind === "rewritten" ? outcome.call : call("read", {});

		const schema = obj({ path: { type: "string" }, offset: { type: "number" } });
		const repaired = repairToolArguments(rewritten.arguments, schema, "read");
		// Registry's rename is preserved; repair only coerced the numeric string.
		expect(repaired.args).toEqual({ path: "a.ts", offset: 10 });
		expect(repaired.repairs).toEqual(["number_from_string"]);
	});
});
