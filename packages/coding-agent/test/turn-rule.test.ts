import { visibleWidth } from "@pit/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { TurnRule } from "../src/modes/interactive/components/turn-rule.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => initTheme("dark"));

describe("TurnRule", () => {
	it("renders a leading blank line then a rule", () => {
		const rule = new TurnRule();
		const lines = rule.render(80);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(""); // blank above; trailing gap comes from the next message
		expect(visibleWidth(lines[1]!)).toBeGreaterThan(0);
	});

	it("keeps the rule line within the viewport width (width-invariance)", () => {
		for (const width of [120, 80, 12]) {
			const lines = new TurnRule().render(width);
			expect(lines).toHaveLength(2);
			expect(lines[0]).toBe("");
			// The visible rule must never exceed the viewport at any width.
			expect(visibleWidth(lines[1]!)).toBeLessThanOrEqual(width);
			// ...and should fill it (full-width hairline).
			expect(visibleWidth(lines[1]!)).toBe(width);
		}
	});

	it("memoizes by width and reallocates after invalidate", () => {
		const rule = new TurnRule();
		const first = rule.render(80);
		expect(rule.render(80)).toBe(first); // same reference on width match
		expect(rule.render(40)).not.toBe(first); // width change → new array
		rule.invalidate();
		expect(rule.render(80)).not.toBe(first); // invalidate drops the cache
	});
});
