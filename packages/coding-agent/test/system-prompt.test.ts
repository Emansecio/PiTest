import { splitSystemPromptOnDynamic } from "@pit/ai";
import { afterEach, describe, expect, test } from "vitest";
import { buildSystemPrompt, OCCUPANCY_GATE_PERCENT, resolvePromptProfile } from "../src/core/system-prompt.js";

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
		const VISUAL = "After a change that affects rendered UI, inspect it with `preview` or Chrome DevTools";

		test("included when an edit/write tool and a preview tool are available", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash", "edit", "write", "preview"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(VISUAL);
		});

		test("included with a chrome_devtools tool as the visual surface", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["edit", "chrome_devtools_screenshot"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(VISUAL);
		});

		test("omitted when no UI surface is on the tool set (backend/CLI session)", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash", "edit", "write"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain(VISUAL);
			// the rest of the edit/write contract is unaffected
			expect(prompt).toContain("Use edit for surgical changes to an existing file");
		});

		test("omitted in a read-only session even when a preview tool is present", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash", "preview"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain(VISUAL);
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

		test("omits frequent_files when context occupancy is at or above the gate", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				frequentFiles: freqFiles,
				contextOccupancyPercent: OCCUPANCY_GATE_PERCENT + 10,
			});
			expect(prompt).not.toContain("<frequent_files>");
		});

		test("emits frequent_files when context occupancy is below the gate", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				frequentFiles: freqFiles,
				contextOccupancyPercent: OCCUPANCY_GATE_PERCENT - 10,
			});
			expect(prompt).toContain("<frequent_files>");
			expect(prompt).toContain("src/a.ts");
		});

		test("omits hotFileOutlines when context occupancy is at or above the gate", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				hotFileOutlines: [{ path: "src/a.ts", symbols: ["foo", "bar"] }],
				contextOccupancyPercent: OCCUPANCY_GATE_PERCENT,
			});
			expect(prompt).not.toContain("<frequent_files_outline>");
		});

		test("omits groundedContext when context occupancy is at or above the gate", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				groundedContext: "<grounded_context>\nsrc/a.ts: foo, bar\n</grounded_context>",
				contextOccupancyPercent: OCCUPANCY_GATE_PERCENT,
			});
			expect(prompt).not.toContain("<grounded_context>");
		});

		test("emits groundedContext when context occupancy is below the gate or undefined", () => {
			const promptBelow = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				groundedContext: "<grounded_context>\nsrc/a.ts: foo, bar\n</grounded_context>",
				contextOccupancyPercent: OCCUPANCY_GATE_PERCENT - 10,
			});
			expect(promptBelow).toContain("<grounded_context>");
			expect(promptBelow).toContain("src/a.ts: foo, bar");

			const promptUndefined = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
				groundedContext: "<grounded_context>\nsrc/a.ts: foo, bar\n</grounded_context>",
			});
			expect(promptUndefined).toContain("<grounded_context>");
		});

		test("the gate trips well below half-full (the block is re-billed per request)", () => {
			// Guards the value itself: everything after the marker is relocated past
			// the cache breakpoint, so it costs cap × (tool rounds), not cap × turns.
			expect(OCCUPANCY_GATE_PERCENT).toBeLessThan(50);
		});
	});

	describe("cacheable-prefix session state", () => {
		const base = {
			selectedTools: ["read", "todo"],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		};

		test("goal persistence rules land in the prefix, never the suffix", () => {
			const rules = "<goal_rules>\nKeep working until the goal is fully resolved\n</goal_rules>";
			const { staticPart, dynamicPart } = splitSystemPromptOnDynamic(
				buildSystemPrompt({ ...base, goalRulesSection: rules }),
			);
			expect(staticPart).toContain("<goal_rules>");
			expect(dynamicPart).not.toContain("<goal_rules>");
		});

		test("prefix section order is fixed regardless of caller ordering", () => {
			const built = buildSystemPrompt({
				...base,
				permissionModeSection: "<plan_mode>P</plan_mode>",
				goalRulesSection: "<goal_rules>G</goal_rules>",
			});
			expect(built.indexOf("<plan_mode>")).toBeLessThan(built.indexOf("<goal_rules>"));
			// Both sit between the guidelines/docs block and project context/skills.
			expect(built.indexOf("consult pit documentation")).toBeLessThan(built.indexOf("<plan_mode>"));
		});

		test("todo usage instructions ride the prefix and do not depend on the list", () => {
			// Unconditional on the tool being present: gating them on a non-empty list
			// would invalidate the cached prefix the moment the first todo is created.
			const { staticPart } = splitSystemPromptOnDynamic(buildSystemPrompt(base));
			expect(staticPart).toContain('todo{action:"set"}');
			expect(staticPart).toContain("in_progress");
			expect(staticPart).toContain("activeForm");
			// Without the tool, nothing about todos is emitted at all.
			const noTodo = buildSystemPrompt({ ...base, selectedTools: ["read"] });
			expect(noTodo).not.toContain('todo{action:"set"}');
		});

		test("the compact tier keeps the todo how-to (weak models need it most)", () => {
			const compact = buildSystemPrompt({ ...base, profile: "compact" });
			expect(compact).toContain('todo{action:"set"}');
			expect(splitSystemPromptOnDynamic(compact).staticPart).toContain('todo{action:"set"}');
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

	describe("profile: compact (P7 tiered system prompt)", () => {
		const base = {
			selectedTools: ["read", "grep", "find", "ls", "todo", "bash", "edit", "write"],
			contextFiles: [] as [],
			skills: [] as [],
			cwd: process.cwd(),
		};

		test("default (no profile option) is byte-identical to explicit profile: 'full'", () => {
			const implicit = buildSystemPrompt(base);
			const explicit = buildSystemPrompt({ ...base, profile: "full" });
			expect(implicit).toBe(explicit);
		});

		test("keeps the essential contract integral: identity, Platform, tools, edit-vs-write, run-tests, docs pointer", () => {
			const prompt = buildSystemPrompt({ ...base, profile: "compact" });

			expect(prompt).toContain("You are an expert coding agent operating inside pit, a coding agent harness.");
			expect(prompt).toContain("Platform:");
			expect(prompt).toContain("Available tools:\n- read");
			expect(prompt).toContain(
				"Use edit for surgical changes to an existing file (multiple edits[] entries in one call). Use write only for new files or full rewrites.",
			);
			expect(prompt).toContain(
				"After a non-trivial code change, run the affected test/build/lint (or re-read); report exactly what passed, failed, or was skipped. Verify each step of multi-step work.",
			);
			expect(prompt).toContain(
				"When asked about pit itself, its SDK, extensions, themes, skills, or TUI, consult pit documentation",
			);
		});

		test("keeps report-outcomes integral in a read-only session (no bash)", () => {
			const prompt = buildSystemPrompt({
				...base,
				selectedTools: ["read", "edit", "write"],
				profile: "compact",
			});
			expect(prompt).toContain(
				"Report outcomes faithfully; never imply a check passed if it failed, was skipped, or was not run.",
			);
		});

		test("keeps the discovery nudge integral when hidden tools exist", () => {
			const prompt = buildSystemPrompt({ ...base, profile: "compact", hiddenToolCount: 3 });
			expect(prompt).toContain("not in the active set but can be discovered");
			expect(prompt).toContain("search_tool_bm25({ query:");
		});

		test("drops the long-form nuance bullets present in the full profile", () => {
			const prompt = buildSystemPrompt({ ...base, profile: "compact" });

			expect(prompt).not.toContain(
				"Todo-first: at the very start of your reasoning, decide whether this task needs more than one step",
			);
			expect(prompt).not.toContain(
				"Treat the user as an experienced professional: deliver the requested work directly",
			);
			expect(prompt).not.toContain("Prefer grep/find/ls over bash for file exploration");
			expect(prompt).not.toContain("Use bash for file operations like ls, rg, find");
			expect(prompt).not.toContain(
				"Match each file's existing style and reuse project utilities; before using a library, confirm it is already a dependency.",
			);
			expect(prompt).not.toContain(
				"Tool batching: emit independent tool calls in the same turn; sequence calls whose arguments depend on earlier results.",
			);
			expect(prompt).not.toContain("Cite code locations as path:line when referencing code.");
			expect(prompt).not.toContain(
				"Add code comments only for non-obvious *why*; never narrate the diff in comments.",
			);
			expect(prompt).not.toContain("If the user's premise is wrong, say so directly and briefly");
		});

		test("condenses the dropped nuance into a handful of imperative lines", () => {
			const prompt = buildSystemPrompt({ ...base, profile: "compact" });

			expect(prompt).toContain("Todo-first: create a todo before any multi-step or investigative task");
			expect(prompt).toContain("Treat the user as an experienced professional: act directly on routine steps");
			expect(prompt).toContain("Explore with the least tool needed");
			expect(prompt).toContain("cite code as path:line");
			expect(prompt).toContain("Comment code only for non-obvious why.");
		});

		test("keeps visual verification in the compact profile", () => {
			const prompt = buildSystemPrompt({
				...base,
				selectedTools: [...base.selectedTools, "preview"],
				profile: "compact",
			});
			expect(prompt).toContain(
				"After a change that affects rendered UI, inspect it with `preview` or Chrome DevTools",
			);
		});

		test("respects PIT_NARRATION in the condensed narration line", () => {
			const prevNarration = process.env.PIT_NARRATION;
			try {
				process.env.PIT_NARRATION = "1";
				const prompt = buildSystemPrompt({ ...base, profile: "compact" });
				expect(prompt).toContain("Keep terminal responses concise; prefer short lists and avoid wide tables.");
				expect(prompt).not.toContain("No preamble, tool-call narration");
			} finally {
				if (prevNarration === undefined) delete process.env.PIT_NARRATION;
				else process.env.PIT_NARRATION = prevNarration;
			}
		});

		test("leaves <project_context>, appendSystemPrompt, and Skills untouched by the profile", () => {
			const options = {
				...base,
				appendSystemPrompt: "extra instructions from an extension",
				contextFiles: [{ path: "AGENTS.md", content: "project rule: no emojis" }],
			};
			const full = buildSystemPrompt({ ...options, profile: "full" });
			const compact = buildSystemPrompt({ ...options, profile: "compact" });

			for (const prompt of [full, compact]) {
				expect(prompt).toContain("extra instructions from an extension");
				expect(prompt).toContain('<project_instructions path="AGENTS.md">');
				expect(prompt).toContain("project rule: no emojis");
			}
		});
	});

	describe("resolvePromptProfile", () => {
		const prevTiered = process.env.PIT_TIERED_PROMPT;
		const prevNoTiered = process.env.PIT_NO_TIERED_PROMPT;
		afterEach(() => {
			if (prevTiered === undefined) delete process.env.PIT_TIERED_PROMPT;
			else process.env.PIT_TIERED_PROMPT = prevTiered;
			if (prevNoTiered === undefined) delete process.env.PIT_NO_TIERED_PROMPT;
			else process.env.PIT_NO_TIERED_PROMPT = prevNoTiered;
		});

		test("auto rule: compact for a weak/open model, full for a native frontier model", () => {
			delete process.env.PIT_TIERED_PROMPT;
			delete process.env.PIT_NO_TIERED_PROMPT;
			expect(resolvePromptProfile({ provider: "opencode", id: "deepseek/deepseek-chat" })).toBe("compact");
			expect(resolvePromptProfile({ provider: "anthropic" })).toBe("full");
			expect(resolvePromptProfile({ provider: "opencode", id: "anthropic/claude-3.5-sonnet" })).toBe("full");
		});

		test("PIT_TIERED_PROMPT forces a tier regardless of the auto rule", () => {
			delete process.env.PIT_NO_TIERED_PROMPT;
			process.env.PIT_TIERED_PROMPT = "compact";
			expect(resolvePromptProfile({ provider: "anthropic" })).toBe("compact");
			process.env.PIT_TIERED_PROMPT = "full";
			expect(resolvePromptProfile({ provider: "opencode", id: "deepseek/deepseek-chat" })).toBe("full");
			process.env.PIT_TIERED_PROMPT = "COMPACT";
			expect(resolvePromptProfile({ provider: "anthropic" })).toBe("compact");
		});

		test("an invalid PIT_TIERED_PROMPT value falls back to the auto rule", () => {
			delete process.env.PIT_NO_TIERED_PROMPT;
			process.env.PIT_TIERED_PROMPT = "bogus";
			expect(resolvePromptProfile({ provider: "anthropic" })).toBe("full");
			expect(resolvePromptProfile({ provider: "opencode", id: "deepseek/deepseek-chat" })).toBe("compact");
		});

		test("PIT_NO_TIERED_PROMPT disables tiering (always full), overriding PIT_TIERED_PROMPT", () => {
			process.env.PIT_NO_TIERED_PROMPT = "1";
			process.env.PIT_TIERED_PROMPT = "compact";
			expect(resolvePromptProfile({ provider: "opencode", id: "deepseek/deepseek-chat" })).toBe("full");
		});
	});
});
