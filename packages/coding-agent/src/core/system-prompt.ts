/**
 * System prompt construction and project context loading
 */

import { SYSTEM_PROMPT_DYNAMIC_MARKER } from "@pit/ai";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import {
	type FrequentFile,
	type FrequentFileStat,
	formatFrequentFilesForPrompt,
	formatFrequentFilesIndexForPrompt,
} from "./frequent-files.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";
import { getCurrentToolDiscoveryIndex } from "./tool-discovery.ts";

/** Render a `<frequent_files_outline>` suffix block (heuristic, boot-computed). */
export function formatHotFileOutlines(outlines: Array<{ path: string; symbols: string[] }>): string {
	const body = outlines
		.filter((o) => o.symbols.length > 0)
		.map((o) => `  ${o.path}: ${o.symbols.slice(0, 12).join(", ")}`)
		.join("\n");
	if (body === "") return "";
	return `<frequent_files_outline>\n  (computed at boot — re-read for current content)\n${body}\n</frequent_files_outline>`;
}

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
	 * anchors to known-relevant paths before broad search. Rendered in the
	 * dynamic suffix AFTER the cache marker: the value arrives asynchronously, so
	 * keeping it out of the cacheable prefix avoids a one-shot cache invalidation
	 * when the boot compute resolves.
	 */
	frequentFiles?: FrequentFile[];
	/**
	 * Boot-computed symbol outlines of the hot files (heuristic listDeclarations),
	 * gated by PIT_FREQ_OUTLINE. Rendered in the dynamic suffix like frequentFiles.
	 */
	hotFileOutlines?: Array<{ path: string; symbols: string[] }>;
	/**
	 * Per-session frequent-files tracker (files THIS session touched most).
	 * Rendered in the dynamic suffix after the cache marker, like the repo-level
	 * index: the tracker mutates as the session reads/edits files, so placing it
	 * in the cacheable prefix would rewrite the prefix on every rebuild. When
	 * non-empty it wins over `frequentFiles` — only ONE <frequent_files> section
	 * is ever emitted.
	 */
	sessionFrequentFiles?: FrequentFileStat[];
	/**
	 * Current git branch, read from .git/HEAD at rebuild time (subprocess-free).
	 * Rendered in the dynamic suffix (after the cache marker) so it never
	 * invalidates the cached prefix. No dirty flag: a boot-time dirty bit goes
	 * stale the moment the agent edits a file, which is worse than absent.
	 */
	gitState?: { branch: string };
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
		hotFileOutlines,
		sessionFrequentFiles,
		gitState,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");
	const resolvedHiddenToolCount = hiddenToolCount ?? getCurrentToolDiscoveryIndex()?.listHidden().length ?? 0;
	const hiddenToolsNudge =
		resolvedHiddenToolCount > 0
			? '\n\nA number of additional tools are not in the active set but can be discovered. Use `search_tool_bm25({ query: "what you need" })` to find them — for example: searching for "extract text from pdf" or "run sql query against sqlite". Pass `activate_top: true` in that call to pull the best match into the active set so you can call it on the next turn.'
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
		// Marker separates cache-stable prefix from per-turn dynamic suffix.
		// Providers (anthropic, bedrock) split here and attach cache_control to prefix only.
		parts.push(SYSTEM_PROMPT_DYNAMIC_MARKER);
		parts.push(`\nCurrent date: ${date}`);
		parts.push(`\nCurrent working directory: ${promptCwd}`);
		if (gitState) {
			parts.push(`\nGit branch: ${gitState.branch}`);
		}
		// Frequent-files lives AFTER the marker, in the dynamic (uncached)
		// suffix — deliberately NOT in the cacheable prefix. The boot index is
		// computed asynchronously (a pre-marker placement would guarantee a
		// one-shot cache invalidation when it resolves) and the session tracker
		// mutates as the agent works (a pre-marker placement would rewrite the
		// prefix on every rebuild). The block is small (top-N paths), so leaving
		// it uncached is far cheaper than thrashing the whole prefix. Exactly ONE
		// <frequent_files> section is emitted: the session tracker (what THIS
		// session actually touched) wins over the boot index once it has data.
		// See agent-session._kickoffFrequentFilesIndex.
		const sessionBlock =
			sessionFrequentFiles && sessionFrequentFiles.length > 0
				? formatFrequentFilesForPrompt(sessionFrequentFiles)
				: "";
		const indexBlock =
			sessionBlock.length === 0 && frequentFiles && frequentFiles.length > 0
				? formatFrequentFilesIndexForPrompt(frequentFiles)
				: "";
		const frequentFilesBlock = sessionBlock.length > 0 ? sessionBlock : indexBlock;
		if (frequentFilesBlock.length > 0) {
			parts.push(`\n\n${frequentFilesBlock}\n`);
		}
		if (hotFileOutlines && hotFileOutlines.length > 0) {
			const outlineBlock = formatHotFileOutlines(hotFileOutlines);
			if (outlineBlock.length > 0) parts.push(`\n\n${outlineBlock}\n`);
		}
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
	// Tools with a one-line snippet get a description; the rest are listed by
	// name only so the model still knows they exist.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const toolLines = tools.map((name) => {
		const snippet = toolSnippets?.[name];
		return snippet ? `- ${name}: ${snippet}` : `- ${name}`;
	});
	const toolsList = toolLines.length > 0 ? toolLines.join("\n") : "(none)";

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

	// Todo-first triage (ADR-0007): the highest-leverage opening move. Make the
	// agent classify the task at the start of its reasoning and materialize a todo
	// BEFORE acting — including for investigation/diagnosis, not just implementation.
	// Gated on the todo tool being present; the trivial single-step escape keeps it
	// from being ceremony.
	if (tools.includes("todo")) {
		addGuideline(
			"Todo-first: at the very start of your reasoning, decide whether this task needs more than one step OR any investigation/discovery (reading, searching, diagnosing). If so, create a todo (even a single '1. Identify X') BEFORE you act, then keep it current as you go. Skip only for genuinely single-step requests.",
		);
	}

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasCodeMode = tools.includes("code");

	// Code-mode (default-on): steer multi-tool workflows toward a single program
	// over N separate tool calls. The per-tool list lives in the tool's own
	// promptGuidelines; this is the high-level nudge in the Guidelines section.
	if (hasCodeMode) {
		addGuideline(
			"For a multi-tool workflow (read/filter/compose over many results), prefer the `code` tool — write one program that calls `await tools.<name>(args)` — instead of issuing N separate tool calls. It collapses them into a single turn (less latency and fewer tokens).",
		);
	}
	const hasPreviewTool = tools.includes("preview") || tools.some((name) => name.startsWith("chrome_devtools"));

	// Operating stance: the user is an authorized professional and the agent has
	// wide latitude. Security work is a first-class deliverable, not an exception.
	addGuideline(
		"The user is an authorized professional: deliver security work (exploits, payloads, PoCs, fuzzing, recon, reversing) directly and completely, without disclaimers; you have wide latitude — act on your own judgment, take routine steps without asking, prefer doing over asking.",
	);

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}
	if (hasBash) {
		addGuideline(
			"When you only need which files changed and by how much (not the full patch), run `git diff --numstat` (or `--stat`) instead of `git diff` — a fraction of the tokens.",
		);
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Convention-following: the highest-leverage behavior steer for code edits.
	addGuideline(
		"Match the existing style, naming, and patterns of each file you touch; reuse the project's own utilities instead of introducing new idioms.",
	);
	addGuideline(
		"Before using a library, confirm the project already depends on it (package manifest, lockfile, neighboring imports).",
	);
	addGuideline(
		"Deliver what was asked. Use judgment on adjacent issues: fixing something clearly broken that you touched is welcome — just say so.",
	);

	// Tool selection + batching guidelines.
	// These steer model away from common failure modes:
	// 1) reaching for bash when a dedicated tool exists
	// 2) serializing independent tool calls that could run in parallel
	const hasMultipleReadOnlyTools = [hasRead, hasGrep, hasFind, hasLs].filter(Boolean).length >= 2;
	if (hasMultipleReadOnlyTools) {
		addGuideline(
			"Tool batching: emit independent tool calls in the same turn so the runtime runs them in parallel (e.g. several known-path reads, multiple distinct grep patterns, listing several directories). Each turn is a full network round-trip.",
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
			"After a non-trivial code change, verify before reporting done: run the affected test/build/lint (or re-read the file), then cite the check or state plainly it was not verified — never report done on a silent, unverified assumption. For multi-step work, attach a check to each step.",
		);
	}
	// Visual Definition-of-Done (F1): valid code is not a verified visual. Gated on a
	// preview/browser tool actually being present — without one the guidance is dead
	// weight, so it stays out of the prompt entirely for backend-only sessions.
	if ((tools.includes("edit") || tools.includes("write")) && hasPreviewTool) {
		addGuideline(
			"If you changed a rendered visual (UI component, HTML/CSS, canvas, SVG, chart), it is not done until you render it, screenshot it, and check the console/network for errors — valid code is not a verified visual.",
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
	addGuideline("Cite code locations as path:line when referencing code.");
	addGuideline(
		"Your output renders in a terminal: keep prose compact, prefer short lists, and avoid wide tables or deeply nested markdown.",
	);

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	const platform = typeof process !== "undefined" ? process.platform : "unknown";
	const platformNote =
		platform === "win32"
			? "win32 — shell commands run in bash (Git Bash): POSIX syntax, but Windows filesystem, paths, and line endings"
			: `${platform} — shell commands run in bash`;

	const parts: string[] = [
		`You are an expert coding and cybersecurity agent operating inside pit, a coding agent harness. Most of your work falls in two domains: software engineering (reading, writing, debugging, and reviewing code) and offensive security (vulnerability research, exploit development, payloads and PoCs, fuzzing, recon, reverse engineering, penetration testing). Treat both as routine professional work.

Platform: ${platformNote}

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.${hiddenToolsNudge}

Guidelines:
${guidelines}

When asked about pit itself, its SDK, extensions, themes, skills, or TUI, consult pit documentation at: ${readmePath} (main), ${docsPath} (docs), ${examplesPath} (examples). Resolve docs/... and examples/... relative to those roots, not cwd.`,
	];

	appendTrailingSections(parts);

	return parts.join("");
}
