import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { discoverLegacyResources } from "../src/core/legacy-discovery.ts";

let fixtureDir: string;
let agentDir: string;

beforeAll(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), "pi-legacy-test-"));
	agentDir = mkdtempSync(join(tmpdir(), "pi-legacy-agent-"));

	// Single rule files at cwd
	mkdirSync(join(fixtureDir, ".claude"), { recursive: true });
	writeFileSync(join(fixtureDir, ".claude", "CLAUDE.md"), "claude rule\n");
	writeFileSync(join(fixtureDir, ".cursorrules"), "cursor rule\n");
	writeFileSync(join(fixtureDir, ".clinerules"), "cline rule\n");
	mkdirSync(join(fixtureDir, ".gemini"), { recursive: true });
	writeFileSync(join(fixtureDir, ".gemini", "GEMINI.md"), "gemini rule\n");
	mkdirSync(join(fixtureDir, ".github"), { recursive: true });
	writeFileSync(join(fixtureDir, ".github", "copilot-instructions.md"), "copilot rule\n");

	// Dir-scanned rules
	mkdirSync(join(fixtureDir, ".cursor", "rules"), { recursive: true });
	writeFileSync(
		join(fixtureDir, ".cursor", "rules", "r1.mdc"),
		'---\nname: r1\nglobs: ["**/*"]\n---\nbody after frontmatter\n',
	);
	writeFileSync(join(fixtureDir, ".cursor", "rules", "r2.md"), "plain rule\n");
	mkdirSync(join(fixtureDir, ".windsurf", "rules"), { recursive: true });
	writeFileSync(join(fixtureDir, ".windsurf", "rules", "w1.md"), "windsurf rule\n");
	mkdirSync(join(fixtureDir, ".github", "instructions"), { recursive: true });
	writeFileSync(join(fixtureDir, ".github", "instructions", "foo.instructions.md"), "copilot path rule\n");
	writeFileSync(join(fixtureDir, ".github", "instructions", "ignored.md"), "missing .instructions.md suffix\n");
	mkdirSync(join(fixtureDir, ".vscode", "instructions"), { recursive: true });
	writeFileSync(join(fixtureDir, ".vscode", "instructions", "b.md"), "vscode rule\n");

	// Skill dirs
	mkdirSync(join(fixtureDir, ".claude", "skills", "demo"), { recursive: true });
	writeFileSync(
		join(fixtureDir, ".claude", "skills", "demo", "SKILL.md"),
		"---\nname: demo\ndescription: demo skill\n---\nbody\n",
	);
	mkdirSync(join(fixtureDir, ".cursor", "skills"), { recursive: true });
});

afterAll(() => {
	rmSync(fixtureDir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

describe("discoverLegacyResources", () => {
	test("collects single rule files with correct origins", () => {
		const result = discoverLegacyResources({ cwd: fixtureDir, agentDir });
		const origins = new Set(result.ruleFiles.map((r) => r.origin));
		expect(origins.has("claude")).toBe(true);
		expect(origins.has("cursor")).toBe(true);
		expect(origins.has("cline")).toBe(true);
		expect(origins.has("gemini")).toBe(true);
		expect(origins.has("copilot")).toBe(true);
		expect(origins.has("windsurf")).toBe(true);
		expect(origins.has("vscode")).toBe(true);
	});

	test("strips YAML frontmatter from .cursor/rules/*.mdc", () => {
		const result = discoverLegacyResources({ cwd: fixtureDir, agentDir });
		const cursorMdc = result.ruleFiles.find((r) => r.path.endsWith("r1.mdc"));
		expect(cursorMdc).toBeDefined();
		expect(cursorMdc?.content).toBe("body after frontmatter\n");
	});

	test("respects suffix filter on .github/instructions", () => {
		const result = discoverLegacyResources({ cwd: fixtureDir, agentDir });
		const paths = result.ruleFiles.map((r) => r.path);
		expect(paths.some((p) => p.endsWith("foo.instructions.md"))).toBe(true);
		expect(paths.some((p) => p.endsWith("ignored.md") && p.includes("instructions"))).toBe(false);
	});

	test("returns skill dirs that exist", () => {
		const result = discoverLegacyResources({ cwd: fixtureDir, agentDir });
		expect(result.skillDirs.some((d) => d.endsWith(join(".claude", "skills")))).toBe(true);
		expect(result.skillDirs.some((d) => d.endsWith(join(".cursor", "skills")))).toBe(true);
	});

	test("dedupes against seenPaths", () => {
		const seen = new Set<string>([join(fixtureDir, ".claude", "CLAUDE.md")]);
		const result = discoverLegacyResources({ cwd: fixtureDir, agentDir, seenPaths: seen });
		// Filter to fixture-scoped paths so ancestor-walked real env files do not pollute.
		const fixtureClaudeRules = result.ruleFiles.filter((r) => r.path.startsWith(fixtureDir) && r.origin === "claude");
		expect(fixtureClaudeRules.length).toBe(0);
	});

	test("missing paths skip silently", () => {
		const empty = mkdtempSync(join(tmpdir(), "pi-legacy-empty-"));
		try {
			const result = discoverLegacyResources({ cwd: empty, agentDir: empty });
			// Ancestor walk may pick up real env files outside the empty dir. Scope
			// the assertion to "nothing originated from the empty dir itself".
			const fromEmpty = result.ruleFiles.filter((r) => r.path.startsWith(empty));
			const skillsFromEmpty = result.skillDirs.filter((d) => d.startsWith(empty));
			expect(fromEmpty).toEqual([]);
			expect(skillsFromEmpty).toEqual([]);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});
