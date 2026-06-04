import { describe, expect, test } from "vitest";
import { summarizeArgsOneLine } from "../src/modes/interactive/components/arg-summary.js";

describe("summarizeArgsOneLine", () => {
	test("formats scalar object entries as key: value", () => {
		expect(summarizeArgsOneLine({ path: "a.ts", count: 3 })).toBe("path: a.ts  count: 3");
	});

	test("collapses arrays and objects", () => {
		expect(summarizeArgsOneLine({ items: [1, 2], nested: { a: 1 } })).toBe("items: [2]  nested: {…}");
	});

	test("clamps long strings with an ellipsis", () => {
		const out = summarizeArgsOneLine("x".repeat(200));
		expect(out.length).toBe(80);
		expect(out.endsWith("…")).toBe(true);
	});
});
