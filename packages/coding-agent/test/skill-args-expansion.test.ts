import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Skill } from "../src/core/skills.js";
import { createHarness, getMessageText, type Harness } from "./suite/harness.js";
import { createTestResourceLoader } from "./utilities.js";

/**
 * Audit fix (2026-06): `_expandSkillCommand` injected the raw skill body and
 * appended args verbatim, so `$ARGUMENTS` / `$1` placeholders in a skill body
 * were never substituted (unlike prompt templates). It now runs substituteArgs
 * when the body references placeholders, and otherwise keeps the legacy
 * append-args behavior so placeholder-free skills are unchanged.
 */
describe("skill command argument expansion", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	function writeSkill(name: string, body: string): Skill {
		const dir = join(tmpdir(), `pi-skill-args-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(dir, name), { recursive: true });
		const filePath = join(dir, name, "SKILL.md");
		writeFileSync(filePath, `---\nname: ${name}\ndescription: test skill ${name}.\n---\n\n${body}\n`, "utf-8");
		tempDirs.push(dir);
		return { name, description: `test skill ${name}.`, filePath, baseDir: join(dir, name) } as unknown as Skill;
	}

	async function harnessWithSkills(skills: Skill[]): Promise<Harness> {
		const byName = new Map(skills.map((s) => [s.name, s]));
		const resourceLoader = {
			...createTestResourceLoader(),
			getSkillByName: (n: string) => byName.get(n),
			getSkills: () => ({ skills, diagnostics: [] }),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);
		return harness;
	}

	it("substitutes $ARGUMENTS and $1 in a skill body that references them", async () => {
		const skill = writeSkill("argskill", "Target is $ARGUMENTS. First token is $1.");
		const harness = await harnessWithSkills([skill]);

		await harness.session.prompt("/argskill alpha beta");

		const userText = getMessageText(harness.session.messages[0]!);
		expect(userText).toContain("Target is alpha beta.");
		expect(userText).toContain("First token is alpha.");
		// Placeholders consumed: no literal markers, and args not appended again.
		expect(userText).not.toContain("$ARGUMENTS");
		expect(userText).not.toContain("$1");
		expect(userText).not.toMatch(/<\/skill>\s*\n\s*alpha beta/);
	});

	it("keeps legacy append behavior for a placeholder-free skill body", async () => {
		const skill = writeSkill("plainskill", "Do the thing.");
		const harness = await harnessWithSkills([skill]);

		await harness.session.prompt("/plainskill alpha beta");

		const userText = getMessageText(harness.session.messages[0]!);
		expect(userText).toContain("Do the thing.");
		// No placeholders → raw args appended after the skill block, as before.
		expect(userText).toContain("alpha beta");
		expect(userText).toMatch(/<\/skill>[\s\S]*alpha beta/);
	});
});
