import { describe, expect, it } from "vitest";
import { preparePlanArguments } from "../src/core/tools/plan.ts";

describe("preparePlanArguments — JSON-stringified steps", () => {
	it("parses steps from a JSON string", () => {
		const steps = [
			{ id: "s1", intent: "scaffold" },
			{ id: "s2", intent: "wire", depends_on: ["s1"] },
		];
		expect(
			preparePlanArguments({
				op: "propose",
				steps: JSON.stringify(steps),
			}),
		).toEqual({
			op: "propose",
			steps,
		});
	});

	it("leaves steps alone when the string is not valid JSON", () => {
		const input = { op: "propose", steps: "not json" };
		expect(preparePlanArguments(input)).toEqual(input);
	});

	it("leaves steps alone when JSON parses to a non-array", () => {
		const input = { op: "propose", steps: JSON.stringify({ id: "s1", intent: "x" }) };
		expect(preparePlanArguments(input)).toEqual(input);
	});

	it("keeps the same reference when steps is already an array", () => {
		const input = { op: "propose", steps: [{ id: "s1", intent: "scaffold" }] };
		expect(preparePlanArguments(input)).toBe(input);
	});

	it("passes through non-object input untouched", () => {
		expect(preparePlanArguments(null)).toBe(null);
		expect(preparePlanArguments(undefined)).toBe(undefined);
	});
});
