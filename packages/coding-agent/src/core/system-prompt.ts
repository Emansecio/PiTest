/**
 * System prompt construction and project context loading
 */

import { SYSTEM_PROMPT_DYNAMIC_MARKER } from "@pit/ai";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { type FrequentFile, formatFrequentFilesIndexForPrompt } from "./frequent-files.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";
import { getCurrentToolDiscoveryIndex } from "./tool-discovery.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
	/**
	 * Optional override for the number of hidden tools discoverable via
	 * `search_tool_bm25`. When omitted, falls back to
	 * `getCurrentToolDiscoveryIndex()?.listHidden().length`. When greater than 0,
	 * a small nudge block is rendered to teach the model about discovery.
	 */
	hiddenToolCount?: number;
	/**
	 * Repo-level "frequent files" computed at session boot from git history (or
	 * mtime fallback). Surfaces hot files in the system prompt so the model
	 * anchors to known-relevant paths before broad search. Rendered AFTER the
	 * skills block and BEFORE the cache marker.
	 */
	frequentFiles?: FrequentFile[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		hiddenToolCount,
		frequentFiles,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");
	const resolvedHiddenToolCount = hiddenToolCount ?? getCurrentToolDiscoveryIndex()?.listHidden().length ?? 0;
	const hiddenToolsNudge =
		resolvedHiddenToolCount > 0
			? '\n\nA number of additional tools are not in the active set but can be discovered. Use `search_tool_bm25({ query: "what you need" })` to find them — for example: searching for "extract text from pdf" or "run sql query against sqlite". The top result will be activated automatically when score is high.'
			: "";

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];
	const hasRead = !selectedTools || selectedTools.includes("read");

	const appendTrailingSections = (parts: string[]): void => {
		if (appendSection) {
			parts.push(appendSection);
		}
		if (contextFiles.length > 0) {
			parts.push("\n\n<project_context>\n\nProject-specific instructions and guidelines:\n");
			for (const { path: filePath, content } of contextFiles) {
				parts.push(`<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n`);
			}
			parts.push("</project_context>\n");
		}
		if (hasRead && skills.length > 0) {
			parts.push(formatSkillsForPrompt(skills, undefined, cwd));
		}
		// Frequent-files block: rendered after skills, before the dynamic marker so
		// it lives in the cache-stable prefix (session boot value rarely changes).
		if (frequentFiles && frequentFiles.length > 0) {
			const block = formatFrequentFilesIndexForPrompt(frequentFiles);
			if (block.length > 0) {
				parts.push(`\n\n${block}\n`);
			}
		}
		// Marker separates cache-stable prefix from per-turn dynamic suffix.
		// Providers (anthropic, bedrock) split here and attach cache_control to prefix only.
		parts.push(SYSTEM_PROMPT_DYNAMIC_MARKER);
		parts.push(`\nCurrent date: ${date}`);
		parts.push(`\nCurrent working directory: ${promptCwd}`);
	};

	if (customPrompt) {
		const parts: string[] = [customPrompt];
		appendTrailingSections(parts);
		return parts.join("");
	}

	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Tool selection + batching guidelines.
	// These steer model away from common failure modes:
	// 1) reaching for bash when a dedicated tool exists
	// 2) serializing independent tool calls that could run in parallel
	const hasMultipleReadOnlyTools = [hasRead, hasGrep, hasFind, hasLs].filter(Boolean).length >= 2;
	if (hasMultipleReadOnlyTools) {
		addGuideline(
			"Tool batching: when you can predict multiple independent tool calls before seeing any result, emit them ALL in the same turn so the runtime runs them in parallel. Examples: reading several files you already know the paths of; greping for multiple distinct patterns; listing several directories. Each turn is a full network round-trip, so 5 reads in 1 turn is ~5x faster than 5 reads in 5 turns.",
		);
		addGuideline(
			"Do not batch when a call's arguments depend on a previous result (e.g., reading a file at a path you just discovered via grep). Sequence those normally.",
		);
	}
	if (hasRead && hasGrep) {
		addGuideline(
			"Use grep first to locate code by pattern; use read only to examine specific files you already identified.",
		);
	}
	if (tools.includes("edit") && tools.includes("write")) {
		addGuideline(
			"Use edit for surgical changes to an existing file (multiple edits[] entries in one call). Use write only for new files or full rewrites.",
		);
	}
	// Verify-after-change contract: when the model can both edit and run a check,
	// reporting "done" on a code change requires either citing the check that ran
	// or stating plainly it was not verified — no silent, unverified "done". Folds
	// in a condensed "check per step" (the strong form lives in the karpathy pack).
	if ((tools.includes("edit") || tools.includes("write")) && hasBash) {
		addGuideline(
			"After a non-trivial code change, verify before reporting done: run the affected test/build/lint (or read the file itself), then either cite the check you ran or state plainly that you did not verify — never report a code change as done on a silent, unverified assumption. For multi-step work, attach a check to each step and keep iterating until every check passes.",
		);
	}
	// Visual Definition-of-Done (F1): valid code is not a verified visual. Self-gates
	// in-text on the model actually having changed a rendered artifact and a browser
	// tool being reachable, so it stays inert for backend-only work.
	if (tools.includes("edit") || tools.includes("write")) {
		addGuideline(
			"If you changed a rendered visual artifact (HTML/CSS, canvas, SVG, a UI component, a chart) and a browser or preview tool is available, it is not done until you render it, screenshot it, and check the console/network for errors — valid code is not a verified visual. If no browser tool is reachable, report it as visually unverified rather than implying it was checked.",
		);
	}

	// Always include these.
	// Concise default trims output tokens (5× cost of input). Set PIT_NARRATION=1
	// to re-enable per-step narration between tool calls.
	const narrationEnabled = typeof process !== "undefined" && process.env.PIT_NARRATION === "1";
	if (narrationEnabled) {
		addGuideline("Be concise in your responses");
	} else {
		addGuideline(
			"Respond only when the task is done or a question is asked. No preamble, no narration between tool calls, no end-of-turn summary unless requested.",
		);
	}
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	const parts: string[] = [
		`You are an expert coding assistant operating inside pit, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.${hiddenToolsNudge}

Guidelines:
${guidelines}

When asked about pi itself, its SDK, extensions, themes, skills, or TUI, consult pi documentation at: ${readmePath} (main), ${docsPath} (docs), ${examplesPath} (examples). Resolve docs/... and examples/... relative to those roots, not cwd.`,
	];

	appendTrailingSections(parts);

	return parts.join("");
}
