import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyContextRetrievalMode,
	dedupePointerContextFiles,
	isPointerEntryPoint,
	normalizeProjectContextFiles,
	PROJECT_CONTEXT_INLINE_MAX_CHARS,
} from "../src/core/context-files.js";
import { loadProjectContextFiles } from "../src/core/resource-loader.js";

describe("isPointerEntryPoint (E16)", () => {
	it("detects CLAUDE.md pointer stubs", () => {
		const content = `# CLAUDE.md\n\nSingle source of truth is **AGENTS.md**. Read it.\n`;
		expect(isPointerEntryPoint("C:/proj/CLAUDE.md", content)).toBe(true);
		expect(isPointerEntryPoint("C:/proj/AGENTS.md", content)).toBe(false);
	});
});

describe("dedupePointerContextFiles (E16)", () => {
	it("drops CLAUDE.md when AGENTS.md exists in the same directory", () => {
		const agents = { path: "C:/proj/AGENTS.md", content: "# Rules\n".repeat(200) };
		const claude = {
			path: "C:/proj/CLAUDE.md",
			content: "Single source of truth is AGENTS.md. Read it.",
		};
		const out = dedupePointerContextFiles([agents, claude]);
		expect(out).toHaveLength(1);
		expect(out[0].path).toContain("AGENTS.md");
	});
});

describe("applyContextRetrievalMode (E6)", () => {
	it("truncates oversized project context with a read hint", () => {
		const huge = "rule line\n".repeat(2000);
		const [out] = applyContextRetrievalMode([{ path: "C:/proj/AGENTS.md", content: huge }], "C:/proj");
		expect(out.content.length).toBeLessThan(huge.length);
		expect(out.content).toContain("read({ path:");
		expect(out.content.length).toBeLessThanOrEqual(PROJECT_CONTEXT_INLINE_MAX_CHARS + 200);
	});
});

describe("loadProjectContextFiles integration", () => {
	let tempDir: string;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads AGENTS.md only when CLAUDE.md is a pointer in the same dir", () => {
		tempDir = join(tmpdir(), `ctx-files-${Date.now()}`);
		const project = join(tempDir, "project");
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, "AGENTS.md"), "# Canonical rules\n".repeat(50));
		writeFileSync(join(project, "CLAUDE.md"), "# CLAUDE.md\n\nSingle source of truth: AGENTS.md. Read it.\n");

		const files = loadProjectContextFiles({ cwd: project, agentDir: join(tempDir, "agent") });
		const projectAgents = resolve(join(project, "AGENTS.md"));
		const projectClaude = resolve(join(project, "CLAUDE.md"));
		expect(files.some((f) => resolve(f.path).toLowerCase() === projectAgents.toLowerCase())).toBe(true);
		expect(files.some((f) => resolve(f.path).toLowerCase() === projectClaude.toLowerCase())).toBe(false);
	});
});

describe("normalizeProjectContextFiles", () => {
	it("dedupes by path and applies retrieval", () => {
		const huge = "x".repeat(PROJECT_CONTEXT_INLINE_MAX_CHARS + 500);
		const files = [
			{ path: "C:/a/AGENTS.md", content: huge },
			{ path: "C:/a/AGENTS.md", content: huge },
		];
		const out = normalizeProjectContextFiles(files, "C:/a");
		expect(out).toHaveLength(1);
		expect(out[0].content.length).toBeLessThan(huge.length);
	});
});
