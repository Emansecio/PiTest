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

	it("caps the rule at the default reading width on wide terminals", () => {
		for (const width of [200, 120, 80, 12]) {
			const lines = new TurnRule().render(width);
			expect(lines).toHaveLength(2);
			expect(lines[0]).toBe("");
			expect(visibleWidth(lines[1]!)).toBe(Math.min(width, 120));
		}
	});

	it("respects an explicit reading cap and 0 for full width", () => {
		expect(visibleWidth(new TurnRule(90).render(200)[1]!)).toBe(90);
		expect(visibleWidth(new TurnRule(0).render(200)[1]!)).toBe(200);
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
