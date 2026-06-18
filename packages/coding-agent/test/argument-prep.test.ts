import { describe, expect, it } from "vitest";
import {
	applyKeyAliases,
	coerceJsonArrayField,
	composePreparers,
	extractEditOldTexts,
	extractEdits,
	PATH_KEY_ALIASES,
	prepareArgsForLooseSchema,
	prepareWithPathAliases,
} from "../src/core/tools/argument-prep.js";

describe("prepareArgsForLooseSchema (MCP / loose-schema tools)", () => {
	const schema = { properties: { path: { type: "string" }, items: { type: "array" } } };

	it("renames an alias to the canonical when the schema declares the canonical and not the alias", () => {
		expect(prepareArgsForLooseSchema({ file_path: "x.ts" }, schema)).toEqual({ path: "x.ts" });
	});

	it("does NOT rename when the server's real param IS the alias", () => {
		const s = { properties: { file_path: { type: "string" } } };
		expect(prepareArgsForLooseSchema({ file_path: "x.ts" }, s)).toEqual({ file_path: "x.ts" });
	});

	it("does NOT clobber a canonical the model already supplied", () => {
		expect(prepareArgsForLooseSchema({ file_path: "a", path: "b" }, schema)).toEqual({ file_path: "a", path: "b" });
	});

	it("coerces a JSON-stringified array into an array-typed field", () => {
		expect(prepareArgsForLooseSchema({ items: "[1,2]" }, schema)).toEqual({ items: [1, 2] });
	});

	it("leaves a string field that is not array-typed untouched", () => {
		expect(prepareArgsForLooseSchema({ path: "[1,2]" }, schema)).toEqual({ path: "[1,2]" });
	});

	it("no-ops (same reference) when the schema has no properties", () => {
		const input = { file_path: "x" };
		expect(prepareArgsForLooseSchema(input, undefined)).toBe(input);
	});
});

describe("extractEdits / extractEditOldTexts — JSON-stringified edits coercion", () => {
	it("extracts oldTexts when edits arrive as a JSON-encoded string", () => {
		const input = { path: "f.ts", edits: JSON.stringify([{ oldText: "a", newText: "b" }]) };
		expect(extractEditOldTexts(input)).toEqual(["a"]);
		expect(extractEdits(input)).toEqual([{ oldText: "a", newText: "b" }]);
	});

	it("still handles a real array", () => {
		const input = { path: "f.ts", edits: [{ oldText: "x", newText: "y" }] };
		expect(extractEditOldTexts(input)).toEqual(["x"]);
	});

	it("is a no-op for a non-array string (fail-open)", () => {
		const input = { path: "f.ts", edits: "not json" };
		expect(extractEditOldTexts(input)).toEqual([]);
		expect(extractEdits(input)).toBeNull();
	});
});

describe("applyKeyAliases", () => {
	it("renames aliases to canonical keys", () => {
		const input = { file_path: "/a/b", offset: 0 };
		const out = applyKeyAliases(input, PATH_KEY_ALIASES);
		expect(out).toEqual({ path: "/a/b", offset: 0 });
		expect(out).not.toBe(input);
	});

	it("returns same reference when nothing changes", () => {
		const input = { path: "/a/b", offset: 0 };
		const out = applyKeyAliases(input, PATH_KEY_ALIASES);
		expect(out).toBe(input);
	});

	it("canonical key wins over alias when both are present", () => {
		const input = { path: "/canon", file_path: "/alias" };
		const out = applyKeyAliases(input, PATH_KEY_ALIASES);
		expect(out).toEqual({ path: "/canon" });
	});

	it("normalizes every supported alias", () => {
		const aliases = ["file_path", "filepath", "filename", "file"] as const;
		for (const alias of aliases) {
			const out = applyKeyAliases({ [alias]: "/x" }, PATH_KEY_ALIASES);
			expect(out).toEqual({ path: "/x" });
		}
	});
});

describe("coerceJsonArrayField", () => {
	it("parses JSON-encoded arrays", () => {
		const input = { edits: JSON.stringify([{ oldText: "a", newText: "b" }]) };
		const out = coerceJsonArrayField(input, "edits");
		expect(out.edits).toEqual([{ oldText: "a", newText: "b" }]);
	});

	it("leaves non-array JSON untouched", () => {
		const input = { edits: JSON.stringify({ oldText: "a" }) };
		const out = coerceJsonArrayField(input, "edits");
		expect(out).toBe(input);
	});

	it("leaves invalid JSON untouched", () => {
		const input = { edits: "not json" };
		const out = coerceJsonArrayField(input, "edits");
		expect(out).toBe(input);
	});

	it("ignores non-string values", () => {
		const input = { edits: [{ oldText: "a", newText: "b" }] };
		const out = coerceJsonArrayField(input, "edits");
		expect(out).toBe(input);
	});
});

describe("prepareWithPathAliases", () => {
	it("normalizes a plain object", () => {
		expect(prepareWithPathAliases({ file_path: "/x" })).toEqual({ path: "/x" });
	});

	it("passes through non-objects", () => {
		expect(prepareWithPathAliases(null)).toBeNull();
		expect(prepareWithPathAliases(undefined)).toBeUndefined();
		expect(prepareWithPathAliases("str")).toBe("str");
		expect(prepareWithPathAliases([1, 2])).toEqual([1, 2]);
	});
});

describe("composePreparers", () => {
	it("runs preparers in order", () => {
		const trace: string[] = [];
		const step = (label: string) => (input: Record<string, unknown>) => {
			trace.push(label);
			return { ...input, [label]: true };
		};
		const prep = composePreparers<Record<string, unknown>>(step("a"), step("b"));
		const out = prep({});
		expect(trace).toEqual(["a", "b"]);
		expect(out).toEqual({ a: true, b: true });
	});
});
