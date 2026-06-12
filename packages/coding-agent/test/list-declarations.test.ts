import { describe, expect, it } from "vitest";
import { listDeclarations } from "../src/core/tools/symbol.js";

describe("listDeclarations", () => {
	it("enumerates top-level brace declarations with ranges", () => {
		const src = [
			"export function foo() {",
			"  return 1;",
			"}",
			"class Bar {",
			"  method() {}", // member — must NOT be listed (indented)
			"}",
			"export const baz = 3;",
		].join("\n");
		const decls = listDeclarations(src, "x.ts");
		expect(decls.map((d) => d.name)).toEqual(["foo", "Bar", "baz"]);
		expect(decls[0]).toMatchObject({ name: "foo", line: 1, kind: "function" });
		expect(decls[1]!.endLine).toBe(6); // class Bar closes at line 6
	});

	it("enumerates python def/class by indentation", () => {
		const src = "def a():\n    pass\nclass B:\n    def m(self):\n        pass\n";
		const decls = listDeclarations(src, "x.py");
		expect(decls.map((d) => d.name)).toEqual(["a", "B"]);
	});

	it("returns [] for unknown languages", () => {
		expect(listDeclarations("# title", "x.md")).toEqual([]);
	});

	it("ignores braces inside template literals (trap)", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${x} is the template-literal fixture under test
		const src = "export const t = `${x}`;\nexport function real() {}\n";
		const names = listDeclarations(src, "x.ts").map((d) => d.name);
		expect(names).toContain("t");
		expect(names).toContain("real");
	});
});
