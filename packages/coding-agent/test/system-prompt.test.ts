import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Resolve docs/... and examples/... relative to those roots, not cwd.");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	describe("verify-after-change nudge", () => {
		test("included when both an edit/write tool and bash are available", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash", "edit", "write"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("After a non-trivial code change, verify before reporting done");
		});

		test("omitted when there is no way to run a check (no bash)", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "edit", "write"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("After a non-trivial code change, verify before reporting done");
		});

		test("omitted in a read-only session (no edit/write)", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("After a non-trivial code change, verify before reporting done");
		});
	});

	describe("visual definition-of-done", () => {
		test("included when an edit/write tool and a preview tool are available", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash", "edit", "write", "preview"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("valid code is not a verified visual");
		});

		test("included with a chrome_devtools tool as the visual surface", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["edit", "chrome_devtools_screenshot"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("valid code is not a verified visual");
		});

		test("omitted when edit/write exist but no preview/browser tool is reachable", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash", "edit", "write"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("valid code is not a verified visual");
		});

		test("omitted in a read-only session even when a preview tool is present", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash", "preview"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("valid code is not a verified visual");
		});
	});

	describe("tool batching guideline", () => {
		test("uses the compressed batching guidance and drops the verbose form", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "grep", "find"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("emit independent tool calls in the same turn");
			expect(prompt).not.toContain("5 reads in 1 turn is ~5x faster");
		});
	});
});
