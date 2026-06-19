import { describe, expect, it } from "vitest";
import { createCalcToolDefinition } from "../src/core/tools/calc.ts";

const def = createCalcToolDefinition("/tmp");

async function calc(expression: string): Promise<number> {
	const ctx = {} as Parameters<typeof def.execute>[4];
	const res = (await def.execute("t", { expression }, undefined, undefined, ctx)) as {
		details?: { value: number };
	};
	return res.details?.value ?? Number.NaN;
}

/**
 * Regression for #22: unary minus must bind LOOSER than exponentiation, matching
 * math/Python convention: -2^2 = -(2^2) = -4, not (-2)^2 = 4.
 */
describe("calc unary-minus vs exponent precedence", () => {
	it("evaluates -2^2 as -4", async () => {
		expect(await calc("-2^2")).toBe(-4);
	});

	it("evaluates -3**2 as -9", async () => {
		expect(await calc("-3**2")).toBe(-9);
	});

	it("keeps a parenthesized base negative: (-2)^2 = 4", async () => {
		expect(await calc("(-2)^2")).toBe(4);
	});

	it("allows a signed exponent: 2^-2 = 0.25", async () => {
		expect(await calc("2^-2")).toBe(0.25);
	});

	it("stays right-associative: 2^3^2 = 512", async () => {
		expect(await calc("2^3^2")).toBe(512);
	});

	it("does not regress ordinary arithmetic: 2*3+1 = 7", async () => {
		expect(await calc("2*3+1")).toBe(7);
	});
});
