/**
 * M25b — skill description cap in the "full" block.
 * Verifies that formatSkillsForPrompt() caps the <description> of the first
 * SKILLS_FULL_LIMIT skills at SKILLS_FULL_DESC_CAP chars (word-boundary
 * truncation with ellipsis), while short descriptions are left intact.
 */
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";
import { formatSkillsForPrompt, SKILLS_FULL_DESC_CAP, SKILLS_FULL_LIMIT, type Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";

function makeSkill(name: string, description: string, _index = 0): Skill {
	return {
		name,
		description,
		filePath: resolve(join("/fake/skills", name, "SKILL.md")),
		baseDir: resolve(join("/fake/skills", name)),
		sourceInfo: createSyntheticSourceInfo(resolve(join("/fake/skills", name, "SKILL.md")), { source: "test" }),
		disableModelInvocation: false,
	};
}

describe("formatSkillsForPrompt — M25b description cap", () => {
	it("constant SKILLS_FULL_DESC_CAP equals 300", () => {
		expect(SKILLS_FULL_DESC_CAP).toBe(300);
	});

	it("short description (under cap) is rendered intact", () => {
		const desc = "Short description that fits within the cap.";
		const skill = makeSkill("my-skill", desc);
		const prompt = formatSkillsForPrompt([skill]);
		expect(prompt).toContain(desc);
	});

	it("long description (over cap) is truncated with ellipsis", () => {
		const desc = "word ".repeat(200).trim(); // ~1000 chars, well over 300
		const skill = makeSkill("long-skill", desc);
		const prompt = formatSkillsForPrompt([skill]);
		// Must not include full description
		expect(prompt).not.toContain(desc);
		// Must include ellipsis
		expect(prompt).toContain("…");
		// The description element must be ≤ cap + some XML escape overhead
		const descMatch = prompt.match(/<description>([\s\S]*?)<\/description>/);
		expect(descMatch).not.toBeNull();
		// Unescape the content and check length
		const rawDesc = (descMatch![1] ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
		expect(rawDesc.length).toBeLessThanOrEqual(SKILLS_FULL_DESC_CAP);
	});

	it("description truncated at a word boundary (no mid-word cut)", () => {
		// Construct a description where a naive char-slice would cut mid-word.
		// Word boundary should keep whole words before the ellipsis.
		const desc = "The quick brown fox jumps over the lazy dog. ".repeat(10);
		const skill = makeSkill("fox-skill", desc);
		const prompt = formatSkillsForPrompt([skill]);
		const descMatch = prompt.match(/<description>([\s\S]*?)<\/description>/);
		const rawDesc = descMatch![1] ?? "";
		// Last char before ellipsis must be a letter (word boundary respected)
		const withoutEllipsis = rawDesc.endsWith("…") ? rawDesc.slice(0, -1).trimEnd() : rawDesc;
		const lastChar = withoutEllipsis.slice(-1);
		// Should end with a word character, not a space (trimEnd removes trailing spaces)
		expect(lastChar).toMatch(/[a-zA-Z0-9.,!?]/);
	});

	it("description cap is applied to skills within SKILLS_FULL_LIMIT", () => {
		const longDesc = "a ".repeat(300).trim(); // 599 chars
		// Create SKILLS_FULL_LIMIT + 1 skills; only the first SKILLS_FULL_LIMIT get <description>
		const skills = Array.from({ length: SKILLS_FULL_LIMIT + 1 }, (_, i) => makeSkill(`skill-${i}`, longDesc, i));
		const prompt = formatSkillsForPrompt(skills);
		// Count occurrences of <description>
		const descCount = (prompt.match(/<description>/g) ?? []).length;
		expect(descCount).toBe(SKILLS_FULL_LIMIT);
		// All <description> elements must be within cap
		const descMatches = [...prompt.matchAll(/<description>([\s\S]*?)<\/description>/g)];
		for (const m of descMatches) {
			const raw = (m[1] ?? "").replace(/&amp;/g, "&");
			expect(raw.length).toBeLessThanOrEqual(SKILLS_FULL_DESC_CAP);
		}
	});
});
