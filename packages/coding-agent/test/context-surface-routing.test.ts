import { describe, expect, it } from "vitest";
import { routeBrowserTools } from "../src/core/built-ins/browser-tool-routing-extension.js";
import {
	formatSelectedSkillsForPrompt,
	formatSkillsHintForPrompt,
	type Skill,
	selectSkillsForPrompt,
} from "../src/core/skills.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

function skill(name: string, description: string): Skill {
	return {
		name,
		description,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: {} as Skill["sourceInfo"],
		disableModelInvocation: false,
	};
}

describe("context surface routing", () => {
	it("renders a short hint instead of the full catalog", () => {
		const skills = [skill("browser", "Inspect browser pages and rendered UI.")];
		const prompt = buildSystemPrompt({
			cwd: process.cwd(),
			selectedTools: ["read", "search_skills"],
			skills,
			skillsMode: "hint",
			contextFiles: [],
		});

		expect(prompt).toContain("Specialized skills are available on demand.");
		expect(prompt).not.toContain("<available_skills>");
	});

	it("selects at most three relevant skills and renders compact cards", () => {
		const skills = [
			skill("browser", "Inspect browser pages and rendered UI."),
			skill("database", "Review SQL queries and database schemas."),
			skill("writing", "Draft and revise technical documents."),
			skill("unrelated", "Manage unrelated release notes."),
		];
		const selected = selectSkillsForPrompt(skills, "Inspect the browser DOM and take a screenshot");

		expect(selected.map((item) => item.name)).toEqual(["browser"]);
		expect(formatSkillsHintForPrompt()).toContain("search_skills");
		expect(formatSelectedSkillsForPrompt(selected)).toContain("<relevant_skills>");
	});

	it("activates a small browser subset and keeps it on the next normal turn", () => {
		const available = [
			"read",
			"bash",
			"chrome_devtools_list_pages",
			"chrome_devtools_navigate",
			"chrome_devtools_screenshot",
			"chrome_devtools_click",
			"chrome_devtools_fill",
			"chrome_devtools_read_console",
			"chrome_devtools_snapshot",
			"chrome_devtools_get_text",
			"preview",
		];
		const browser = routeBrowserTools(
			"Open the browser page, click the login button, and verify the screenshot",
			available,
			["read", "bash", "chrome_devtools_click"],
		);
		expect(browser).toContain("chrome_devtools_list_pages");
		expect(browser).toContain("chrome_devtools_click");
		expect(browser).not.toContain("chrome_devtools_read_console");

		// Append-only: a later turn without browser intent must not rewrite the surface.
		const normal = routeBrowserTools("Summarize this TypeScript function", available, browser);
		expect(normal).toEqual(browser);
	});
});
