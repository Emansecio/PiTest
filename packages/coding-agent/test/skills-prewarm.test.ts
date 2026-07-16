import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkills, prewarmSkillFrontmatter } from "../src/core/skills.js";

const NO_PREWARM_ENV = "PIT_NO_SKILL_PREWARM";

/**
 * A fixed whole-second mtime that round-trips exactly through utimesSync, so
 * two writes can share the exact same cache key (mtimeMs) on purpose. Whether
 * the frontmatter cache was seeded by the prewarm is then observable: rewrite
 * the file with different content but the SAME mtime — a seeded cache keeps
 * serving the prewarmed parse, an unseeded one reads the new bytes.
 */
const FIXED_MTIME = new Date("2020-01-02T03:04:05Z");

describe("prewarmSkillFrontmatter", () => {
	let root: string;
	let skillsDir: string;
	let originalNoPrewarm: string | undefined;

	beforeEach(() => {
		originalNoPrewarm = process.env[NO_PREWARM_ENV];
		delete process.env[NO_PREWARM_ENV];
		root = mkdtempSync(join(tmpdir(), "pit-skills-prewarm-"));
		skillsDir = join(root, "skills");
		mkdirSync(skillsDir, { recursive: true });
	});

	afterEach(() => {
		if (originalNoPrewarm === undefined) {
			delete process.env[NO_PREWARM_ENV];
		} else {
			process.env[NO_PREWARM_ENV] = originalNoPrewarm;
		}
		rmSync(root, { recursive: true, force: true });
	});

	function writeSkill(name: string, description: string, mtime?: Date): string {
		const dir = join(skillsDir, name);
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "SKILL.md");
		writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n---\n\nbody of ${name}\n`, "utf8");
		if (mtime) {
			utimesSync(filePath, mtime, mtime);
		}
		return filePath;
	}

	function load() {
		return loadSkills({ cwd: root, agentDir: join(root, "agent"), skillPaths: [skillsDir], includeDefaults: false });
	}

	it("prewarm + load yields the same skills as a cold load", async () => {
		writeSkill("alpha", "first skill");
		writeSkill("beta", "second skill");
		const cold = load();
		await prewarmSkillFrontmatter({
			cwd: root,
			agentDir: join(root, "agent"),
			skillPaths: [skillsDir],
			includeDefaults: false,
		});
		const warmed = load();
		expect(warmed.skills.map((s) => [s.name, s.description, s.filePath])).toEqual(
			cold.skills.map((s) => [s.name, s.description, s.filePath]),
		);
		expect(warmed.diagnostics).toEqual(cold.diagnostics);
	});

	it("actually seeds the frontmatter cache (same-mtime rewrite is served from cache)", async () => {
		const filePath = writeSkill("gamma", "prewarmed description", FIXED_MTIME);
		await prewarmSkillFrontmatter({
			cwd: root,
			agentDir: join(root, "agent"),
			skillPaths: [skillsDir],
			includeDefaults: false,
		});
		// Rewrite with different content but the identical mtime: only a seeded
		// cache can still answer with the prewarmed description.
		writeFileSync(filePath, "---\nname: gamma\ndescription: rewritten description\n---\n", "utf8");
		utimesSync(filePath, FIXED_MTIME, FIXED_MTIME);
		const result = load();
		expect(result.skills.find((s) => s.name === "gamma")?.description).toBe("prewarmed description");
	});

	it("a genuinely changed file (new mtime) is re-read after prewarm", async () => {
		const filePath = writeSkill("delta", "old description", FIXED_MTIME);
		await prewarmSkillFrontmatter({
			cwd: root,
			agentDir: join(root, "agent"),
			skillPaths: [skillsDir],
			includeDefaults: false,
		});
		writeFileSync(filePath, "---\nname: delta\ndescription: new description\n---\n", "utf8");
		const later = new Date(FIXED_MTIME.getTime() + 60_000);
		utimesSync(filePath, later, later);
		const result = load();
		expect(result.skills.find((s) => s.name === "delta")?.description).toBe("new description");
	});

	it("PIT_NO_SKILL_PREWARM=1 skips the warm-up entirely", async () => {
		process.env[NO_PREWARM_ENV] = "1";
		const filePath = writeSkill("epsilon", "should not be cached", FIXED_MTIME);
		await prewarmSkillFrontmatter({
			cwd: root,
			agentDir: join(root, "agent"),
			skillPaths: [skillsDir],
			includeDefaults: false,
		});
		// Same-mtime rewrite: with the prewarm disabled nothing was seeded, so the
		// sync load reads the rewritten bytes.
		writeFileSync(filePath, "---\nname: epsilon\ndescription: fresh read\n---\n", "utf8");
		utimesSync(filePath, FIXED_MTIME, FIXED_MTIME);
		const result = load();
		expect(result.skills.find((s) => s.name === "epsilon")?.description).toBe("fresh read");
	});

	it("tolerates unreadable/vanished paths without throwing", async () => {
		await expect(
			prewarmSkillFrontmatter({
				cwd: root,
				agentDir: join(root, "agent"),
				skillPaths: [join(root, "does-not-exist"), join(skillsDir, "nope.md")],
				includeDefaults: false,
			}),
		).resolves.toBeUndefined();
	});
});
