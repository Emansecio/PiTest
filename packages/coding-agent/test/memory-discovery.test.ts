import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendMemory,
	discoverMemoryFiles,
	formatMemoryForPrompt,
	formatMemoryHintForPrompt,
} from "../src/core/memory/index.js";

describe("memory discovery + format + append", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	const configDirName = ".pit";

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-"));
		cwd = path.join(tempDir, "proj");
		agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("discovers global and project MEMORY.md", () => {
		fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
		fs.mkdirSync(path.join(cwd, configDirName, "memory"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "memory", "MEMORY.md"), "global content");
		fs.writeFileSync(path.join(cwd, configDirName, "memory", "MEMORY.md"), "project content");

		const files = discoverMemoryFiles({ cwd, agentDir, configDirName });
		expect(files.map((f) => f.scope).sort()).toEqual(["global", "project"]);
		expect(files.find((f) => f.scope === "global")?.content).toBe("global content");
	});

	it("falls back to top-level MEMORY.md", () => {
		fs.writeFileSync(path.join(cwd, "MEMORY.md"), "top");
		const files = discoverMemoryFiles({ cwd, agentDir, configDirName });
		expect(files.find((f) => f.scope === "project")?.content).toBe("top");
	});

	it("returns empty array when no files exist", () => {
		expect(discoverMemoryFiles({ cwd, agentDir, configDirName })).toEqual([]);
	});

	it("formats memory under <persistent_memory> tag", () => {
		const text = formatMemoryForPrompt([{ scope: "project", path: "/p/MEMORY.md", content: "hello" }]);
		expect(text).toContain("<persistent_memory>");
		expect(text).toContain('<memory_entry scope="project"');
		expect(text).toContain("hello");
	});

	it("returns empty string for no memory files", () => {
		expect(formatMemoryForPrompt([])).toBe("");
	});

	it("formatMemoryHintForPrompt emits on-demand hint without full body (E3)", () => {
		const body = `${"padding ".repeat(40)}secret fact at end`;
		const text = formatMemoryHintForPrompt([{ scope: "project", path: "/p/MEMORY.md", content: body }], cwd);
		expect(text).toContain("<persistent_memory_hint>");
		expect(text).toContain("read({ path:");
		expect(text).not.toContain("secret fact at end");
		expect(text).toContain("padding");
	});

	it("appendMemory creates project file with date stamp", () => {
		const result = appendMemory({
			scope: "project",
			cwd,
			agentDir,
			configDirName,
			entry: "remember to lint",
		});
		expect(result.created).toBe(true);
		const content = fs.readFileSync(result.path, "utf-8");
		expect(content).toContain("remember to lint");
		expect(content).toMatch(/\d{4}-\d{2}-\d{2}/);
	});

	it("appendMemory uses heading when provided", () => {
		const result = appendMemory({
			scope: "global",
			cwd,
			agentDir,
			configDirName,
			entry: "the body",
			heading: "Workflow",
		});
		const content = fs.readFileSync(result.path, "utf-8");
		expect(content).toMatch(/## Workflow \(\d{4}-\d{2}-\d{2}\)/);
		expect(content).toContain("the body");
	});
});
