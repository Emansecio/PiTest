import { splitSystemPromptOnDynamic } from "@pit/ai";
import { afterEach, describe, expect, test } from "vitest";
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

		test("shows path citation guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Cite code locations as path:line");
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

		test("lists custom tools by bare name when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool");
			expect(prompt).not.toContain("- dynamic_tool:");
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

			expect(prompt).toContain("After a non-trivial code change, run the affected test/build/lint");
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

			expect(prompt).toContain("a screenshot alone is not a verified functional UI");
		});

		test("included with a chrome_devtools tool as the visual surface", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["edit", "chrome_devtools_screenshot"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("a screenshot alone is not a verified functional UI");
		});

		test("omitted when edit/write exist but no preview/browser tool is reachable", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash", "edit", "write"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("a screenshot alone is not a verified functional UI");
		});

		test("omitted in a read-only session even when a preview tool is present", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash", "preview"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("a screenshot alone is not a verified functional UI");
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

	describe("frequent-files index placement (prompt-cache stability)", () => {
		const freqFiles = [
			{ path: "src/a.ts", count: 5, source: "git" as const },
			{ path: "src/b.ts", count: 3, source: "git" as const },
		];

		test("renders the frequent-files block in the dynamic suffix, after the cache marker", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				frequentFiles: freqFiles,
			});

			const { staticPart, dynamicPart } = splitSystemPromptOnDynamic(prompt);
			expect(staticPart).not.toContain("<frequent_files>");
			expect(dynamicPart).toContain("<frequent_files>");
			expect(dynamicPart).toContain("src/a.ts");
		});

		test("cacheable prefix is byte-identical with and without the late-arriving index", () => {
			const base = {
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			};

			const withoutIndex = splitSystemPromptOnDynamic(buildSystemPrompt(base)).staticPart;
			const withIndex = splitSystemPromptOnDynamic(
				buildSystemPrompt({ ...base, frequentFiles: freqFiles }),
			).staticPart;

			// The boot compute resolves async and triggers a rebuild WITH the index;
			// if the index lived in the prefix, this rebuild would re-bill the whole
			// cached prefix. Identical prefixes prove the late arrival is cache-free.
			expect(withIndex).toBe(withoutIndex);
		});

		test("omits frequent_files when context occupancy is at or above 50%", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				frequentFiles: freqFiles,
				contextOccupancyPercent: 60,
			});
			expect(prompt).not.toContain("<frequent_files>");
		});

		test("emits frequent_files when context occupancy is below 50%", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				frequentFiles: freqFiles,
				contextOccupancyPercent: 40,
			});
			expect(prompt).toContain("<frequent_files>");
			expect(prompt).toContain("src/a.ts");
		});

		test("omits hotFileOutlines when context occupancy is at or above 50%", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				hotFileOutlines: [{ path: "src/a.ts", symbols: ["foo", "bar"] }],
				contextOccupancyPercent: 50,
			});
			expect(prompt).not.toContain("<frequent_files_outline>");
		});
	});

	describe("PIT_NARRATION", () => {
		const prev = process.env.PIT_NARRATION;
		afterEach(() => {
			if (prev === undefined) delete process.env.PIT_NARRATION;
			else process.env.PIT_NARRATION = prev;
		});

		const base = {
			selectedTools: [] as string[],
			contextFiles: [] as [],
			skills: [] as [],
			cwd: process.cwd(),
		};

		test("default guideline suppresses narration between tool calls", () => {
			delete process.env.PIT_NARRATION;
			const prompt = buildSystemPrompt(base);
			expect(prompt).toContain("Respond only when done or asked a question");
			expect(prompt).not.toContain("Keep terminal responses concise");
		});

		test.each(["1", "true", "yes", "TRUE", "Yes"] as const)(
			"enables narration guideline when PIT_NARRATION=%s",
			(value) => {
				process.env.PIT_NARRATION = value;
				const prompt = buildSystemPrompt(base);
				expect(prompt).toContain("Keep terminal responses concise");
				expect(prompt).not.toContain("Respond only when done or asked a question");
			},
		);
	});

	describe("git state placement (prompt-cache stability)", () => {
		test("renders the git branch in the dynamic suffix, after the cache marker", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				gitState: { branch: "main" },
			});

			const { staticPart, dynamicPart } = splitSystemPromptOnDynamic(prompt);
			expect(staticPart).not.toContain("Git branch:");
			expect(dynamicPart).toContain("Git branch: main");
		});

		test("cacheable prefix is byte-identical with and without the git branch", () => {
			const base = {
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			};

			const without = splitSystemPromptOnDynamic(buildSystemPrompt(base)).staticPart;
			const withState = splitSystemPromptOnDynamic(
				buildSystemPrompt({ ...base, gitState: { branch: "main" } }),
			).staticPart;

			expect(withState).toBe(without);
		});
	});
});
