import { describe, expect, test } from "vitest";
import { detectNonErasableSyntax } from "../src/core/erasable-syntax-grounding.js";

describe("detectNonErasableSyntax", () => {
	test("flags a plain enum", () => {
		const f = detectNonErasableSyntax("export enum Color { Red, Blue }");
		expect(f?.construct).toBe("enum");
		expect(f?.hint).toContain("erasableSyntaxOnly");
	});

	test("flags const enum", () => {
		expect(detectNonErasableSyntax("const enum E { A }")?.construct).toBe("enum");
	});

	test("flags a namespace with a body", () => {
		expect(detectNonErasableSyntax("namespace N {\n const x = 1;\n}")?.construct).toBe("namespace");
	});

	test("flags a legacy module block", () => {
		expect(detectNonErasableSyntax("module Foo {\n export const y = 2;\n}")?.construct).toBe("namespace");
	});

	test("flags a constructor parameter property", () => {
		const src = "class C {\n constructor(private readonly db: Db) {}\n}";
		expect(detectNonErasableSyntax(src)?.construct).toBe("parameter-property");
	});

	test("flags a parameter property on a later line", () => {
		const src = "class C {\n constructor(\n  host: string,\n  public port: number,\n ) {}\n}";
		expect(detectNonErasableSyntax(src)?.construct).toBe("parameter-property");
	});

	test("does NOT flag declare enum (ambient, erased)", () => {
		expect(detectNonErasableSyntax("declare enum E { A }")).toBeUndefined();
	});

	test("does NOT flag declare namespace", () => {
		expect(detectNonErasableSyntax("declare namespace N { const x: number; }")).toBeUndefined();
	});

	test("does NOT flag a plain constructor", () => {
		expect(detectNonErasableSyntax("class C {\n constructor(host: string) { this.host = host; }\n}")).toBeUndefined();
	});

	test("does NOT flag the word enum inside a comment", () => {
		expect(detectNonErasableSyntax("// we used to have an enum here\nconst x = 1;")).toBeUndefined();
	});

	test("does NOT flag the word enum inside a string", () => {
		expect(detectNonErasableSyntax('const label = "pick an enum value";')).toBeUndefined();
	});

	test("does NOT flag enum-like identifiers", () => {
		expect(detectNonErasableSyntax("const enumValues = [1, 2]; obj.enum = 3;")).toBeUndefined();
	});

	test("does NOT flag readonly array type on a normal param", () => {
		expect(detectNonErasableSyntax("class C {\n constructor(items: readonly string[]) {}\n}")).toBeUndefined();
	});

	test("returns undefined for clean erasable code", () => {
		const src =
			"export const Color = { Red: 'red' } as const;\n" +
			"type Color = (typeof Color)[keyof typeof Color];\n" +
			"export function f(x: number): number { return x + 1; }";
		expect(detectNonErasableSyntax(src)).toBeUndefined();
	});

	test("empty content is undefined", () => {
		expect(detectNonErasableSyntax("")).toBeUndefined();
	});
});
