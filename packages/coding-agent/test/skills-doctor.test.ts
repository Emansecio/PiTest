import { homedir } from "node:os";
import { basename, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ResourceDiagnostic } from "../src/core/diagnostics.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	applySkillsDoctorFix,
	formatSkillsDoctorBrief,
	formatSkillsDoctorFixHint,
	formatSkillsDoctorReport,
	formatSkillsQuietStartupHint,
	planSkillsDoctorFix,
} from "../src/modes/interactive/skills-doctor.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

function collision(
	name: string,
	winnerPath: string,
	loserPath: string,
	winnerSource?: string,
	loserSource?: string,
): ResourceDiagnostic {
	return {
		type: "collision",
		message: `duplicate skill: ${name}`,
		collision: {
			resourceType: "skill",
			name,
			winnerPath,
			loserPath,
			winnerSource,
			loserSource,
		},
	};
}

function plain(text: string): string {
	return stripAnsi(text);
}

describe("skills-doctor", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("formatSkillsQuietStartupHint returns null when diagnostics are empty", () => {
		expect(formatSkillsQuietStartupHint([])).toBeNull();
	});

	it("formatSkillsQuietStartupHint surfaces a one-line doctor pointer", () => {
		const home = homedir();
		const hint = formatSkillsQuietStartupHint([
			collision(
				"commit",
				join(home, ".pit", "agent", "skills", "commit"),
				join(home, ".claude", "skills", "commit"),
			),
			collision("review", join(home, ".pit", "agent", "skills", "review"), join(home, ".codex", "skills", "review")),
		]);
		expect(hint).not.toBeNull();
		const text = plain(hint!);
		expect(text).toBe("2 dup — /skills doctor");
	});

	it("formatSkillsDoctorBrief summarizes loaded skills and duplicate counts", () => {
		const home = homedir();
		const cwd = join(home, "PiTest");
		const body = plain(
			formatSkillsDoctorBrief({
				cwd,
				skills: [{ filePath: join(cwd, ".pit", "skills", "commit", "SKILL.md"), name: "commit" } as never],
				diagnostics: [
					collision("commit", join(cwd, ".pit", "skills", "commit"), join(home, ".claude", "skills", "commit")),
				],
			}),
		);
		expect(body).toContain("Skills");
		expect(body).toContain("Loaded: 1");
		expect(body).toContain("Duplicates ignored: 1 (1 names)");
		expect(body).toContain("/skills doctor");
	});

	it("formatSkillsDoctorReport groups losers and recommends env cleanup", () => {
		const home = homedir();
		const body = plain(
			formatSkillsDoctorReport({
				cwd: home,
				discovery: { noClaudeCode: false, noLegacy: false },
				skills: [{ filePath: join(home, ".pit", "skills", "commit", "SKILL.md"), name: "commit" } as never],
				diagnostics: [
					collision(
						"commit",
						join(home, ".pit", "skills", "commit"),
						join(home, ".claude", "skills", "commit"),
						"project",
						"claude",
					),
					collision(
						"review",
						join(home, ".pit", "agent", "skills", "review"),
						join(home, ".codex", "skills", "review"),
						"user",
						"legacy",
					),
				],
			}),
		);
		expect(body).toContain("Skills doctor");
		expect(body).toContain("Collisions");
		expect(body).toContain("commit");
		expect(body).toContain("review");
		expect(body).toContain("ignored");
		expect(body).toContain("/skills doctor fix");
		expect(body).toContain("launch pit from the project repo");
		expect(body).toContain(`${basename(home)} (home)`);
		expect(body).toContain("Ignored by tree");
		expect(body).not.toContain("SKILL.md");
	});

	it("formatSkillsDoctorReport verbose includes winner and loser paths", () => {
		const home = homedir();
		const body = plain(
			formatSkillsDoctorReport({
				cwd: home,
				skills: [],
				verbose: true,
				diagnostics: [
					collision(
						"commit",
						join(home, ".pit", "agent", "skills", "commit", "SKILL.md"),
						join(home, ".codex", "skills", "commit", "SKILL.md"),
						"user",
						"path",
					),
				],
			}),
		);
		expect(body).toContain("~/.pit/agent/skills");
		expect(body).toContain("~/.codex/skills");
		expect(body).not.toContain("\\");
	});

	it("planSkillsDoctorFix proposes opt-outs for claude and legacy losers", () => {
		const home = homedir();
		const plan = planSkillsDoctorFix(
			[
				collision(
					"commit",
					join(home, ".pit", "agent", "skills", "commit"),
					join(home, ".claude", "skills", "commit"),
				),
				collision(
					"review",
					join(home, ".pit", "agent", "skills", "review"),
					join(home, ".codex", "skills", "review"),
				),
			],
			{ noClaudeCode: false, noLegacy: false },
		);
		expect(plan.actions).toEqual(["noLegacy", "noClaudeCode"]);
		expect(formatSkillsDoctorFixHint(plan)).toContain("/skills doctor fix");
	});

	it("applySkillsDoctorFix persists settings", async () => {
		const manager = SettingsManager.inMemory();
		const applied = applySkillsDoctorFix(manager, {
			actions: ["noLegacy", "noClaudeCode"],
			claudeLosers: 1,
			codexLosers: 1,
			geminiLosers: 0,
		});
		expect(applied).toHaveLength(2);
		expect(manager.getSkillDiscoverySettings().noLegacy).toBe(true);
		expect(manager.getSkillDiscoverySettings().noClaudeCode).toBe(true);
	});
});
