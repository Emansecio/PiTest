import { describe, expect, it } from "vitest";
import { crushJson } from "../src/core/tools/json-crush.js";

const bigArray = (n: number): string =>
	JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i, name: `name-${i}`, status: i % 2 ? "ok" : "err" })));

describe("crushJson", () => {
	it("collapses a large homogeneous array, preserving schema + head + tail + count", () => {
		const out = crushJson(bigArray(100), { targetChars: 600 });
		expect(out).toBeDefined();
		const s = out ?? "";
		expect(s.length).toBeLessThanOrEqual(600);
		expect(s).toContain('"status"'); // schema preserved
		expect(s).toContain('"id"');
		expect(s).toContain("name-0"); // head sample
		expect(s).toContain("name-99"); // tail sample
		expect(s).toMatch(/\+9\d items elided/); // omitted count (~95)
	});

	it("returns undefined for non-JSON (caller falls back)", () => {
		expect(crushJson("x".repeat(5000), { targetChars: 1000 })).toBeUndefined();
	});

	it("returns undefined when the text already fits (no-op)", () => {
		const text = bigArray(2);
		expect(crushJson(text, { targetChars: text.length + 10 })).toBeUndefined();
	});

	it("collapses a large nested array inside an object, keeping siblings", () => {
		const text = JSON.stringify({ meta: { count: 500 }, items: Array.from({ length: 500 }, (_, i) => i) });
		const out = crushJson(text, { targetChars: 400 });
		expect(out).toBeDefined();
		const s = out ?? "";
		expect(s).toContain('"meta"'); // sibling object preserved
		expect(s).toContain('"count"');
		expect(s).toContain("items elided");
	});

	it("crushes NDJSON logs preserving head + tail", () => {
		const text = Array.from({ length: 50 }, (_, i) => JSON.stringify({ ts: i, msg: `line ${i}` })).join("\n");
		const out = crushJson(text, { targetChars: 300 });
		expect(out).toBeDefined();
		const s = out ?? "";
		expect(s).toContain("line 0");
		expect(s).toContain("line 49");
		expect(s).toContain("items elided");
	});

	it("returns undefined for malformed / truncated JSON", () => {
		const text = `[{"a":1}, {"b": ${"x".repeat(3000)}`;
		expect(crushJson(text, { targetChars: 500 })).toBeUndefined();
	});

	it("truncates long string values", () => {
		const text = JSON.stringify({ blob: "y".repeat(5000), arr: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
		const out = crushJson(text, { targetChars: 400, maxStringChars: 100 });
		expect(out).toBeDefined();
		const s = out ?? "";
		expect(s).toContain("chars)"); // string-truncation marker …(+N chars)
		expect(s).not.toContain("y".repeat(200));
	});

	it("is deterministic", () => {
		const text = bigArray(100);
		expect(crushJson(text, { targetChars: 600 })).toBe(crushJson(text, { targetChars: 600 }));
	});

	it("never exceeds the target budget when it returns a value", () => {
		for (const n of [10, 100, 1000]) {
			const out = crushJson(bigArray(n), { targetChars: 800 });
			if (out !== undefined) expect(out.length).toBeLessThanOrEqual(800);
		}
	});
});
