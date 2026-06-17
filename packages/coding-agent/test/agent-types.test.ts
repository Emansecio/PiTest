import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentTypes } from "../src/core/coordinator/agent-types.js";

describe("loadAgentTypes", () => {
	let root: string;
	let home: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pit-at-cwd-"));
		home = mkdtempSync(join(tmpdir(), "pit-at-home-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});
	function writeAgent(base: string, file: string, content: string): void {
		const dir = join(base, ".pit", "agents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, file), content);
	}

	it("parses frontmatter fields and the body as the system prompt", () => {
		writeAgent(
			root,
			"explorer.md",
			`---
name: explorer
description: Read-only exploration
tools: read, grep, find
model: haiku
thinking: low
---
You are a read-only explorer.`,
		);
		const types = loadAgentTypes(root, home);
		expect(types).toHaveLength(1);
		const t = types[0];
		expect(t.name).toBe("explorer");
		expect(t.description).toBe("Read-only exploration");
		expect(t.tools).toEqual(["read", "grep", "find"]);
		expect(t.model).toBe("haiku");
		expect(t.thinkingLevel).toBe("low");
		expect(t.systemPrompt).toBe("You are a read-only explorer.");
		expect(t.source).toBe("project");
	});

	it("lets a project type shadow a user type of the same name", () => {
		writeAgent(home, "dup.md", `---\nname: dup\ndescription: user version\n---\nuser body`);
		writeAgent(root, "dup.md", `---\nname: dup\ndescription: project version\n---\nproject body`);
		const types = loadAgentTypes(root, home);
		expect(types).toHaveLength(1);
		expect(types[0].description).toBe("project version");
		expect(types[0].source).toBe("project");
	});

	it("falls back to the basename when name is absent and accepts a YAML tools list", () => {
		writeAgent(
			root,
			"planner.md",
			`---
description: planning
tools:
  - read
  - write
---
Plan things.`,
		);
		const types = loadAgentTypes(root, home);
		expect(types[0].name).toBe("planner");
		expect(types[0].tools).toEqual(["read", "write"]);
	});

	it("returns empty when there is no agents dir, and skips invalid-YAML files", () => {
		expect(loadAgentTypes(root, home)).toEqual([]);
		writeAgent(root, "good.md", `---\nname: good\n---\nbody`);
		writeAgent(root, "broken.md", `---\nname: "unterminated\n---\nbody`);
		expect(loadAgentTypes(root, home).map((t) => t.name)).toEqual(["good"]);
	});
});
