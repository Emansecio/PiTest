import { describe, expect, it } from "vitest";
import { scoreSkillForQuery } from "../src/core/tools/search-skills.js";

describe("search_skills scoring", () => {
	it("ranks by term overlap on name + full description (late triggers count)", () => {
		// trigger keywords live AFTER the first sentence — still matchable
		expect(scoreSkillForQuery("idor bola", "emansec", "Web pentest. Triggers: IDOR, BOLA, GraphQL")).toBeGreaterThan(
			0,
		);
	});

	it("returns 0 when nothing overlaps", () => {
		expect(scoreSkillForQuery("kubernetes helm", "emansec", "IDOR, BOLA")).toBe(0);
	});
});
