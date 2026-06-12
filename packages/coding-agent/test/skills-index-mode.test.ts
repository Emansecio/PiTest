import { describe, expect, it } from "vitest";
import { formatSkillsForPrompt, type Skill } from "../src/core/skills.js";

function fakeSkill(n: number): Skill {
	return {
		name: `skill${n}`,
		description: `First sentence ${n}. Trigger keywords: alpha${n}, beta${n}.`,
		filePath: `/skills/skill${n}/SKILL.md`,
		baseDir: `/skills/skill${n}`,
		sourceInfo: {} as Skill["sourceInfo"],
		disableModelInvocation: false,
	};
}

describe("formatSkillsForPrompt auto index-mode", () => {
	it("keeps the first 15 full and shrinks the rest to an index line", () => {
		const skills = Array.from({ length: 20 }, (_, i) => fakeSkill(i));
		const out = formatSkillsForPrompt(skills);
		// full skills keep their complete description (trigger keywords present)
		expect(out).toContain("Trigger keywords: alpha0");
		// 16th+ skill is index-only: name present, trailing trigger list dropped
		expect(out).toContain("skill16");
		expect(out).not.toContain("alpha16");
		expect(out.toLowerCase()).toContain("search_skills");
	});

	it("is byte-stable for small installs (<=15 skills): all full, no nudge", () => {
		const skills = Array.from({ length: 3 }, (_, i) => fakeSkill(i));
		const out = formatSkillsForPrompt(skills);
		expect(out).toContain("alpha0");
		expect(out).toContain("alpha2");
		expect(out.toLowerCase()).not.toContain("search_skills");
	});
});
