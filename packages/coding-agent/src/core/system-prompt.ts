/**
 * System prompt construction and project context loading
 */

import { SYSTEM_PROMPT_DYNAMIC_MARKER } from "@pit/ai";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import {
	type FrequentFile,
	type FrequentFileStat,
	formatFrequentFilesForPrompt,
	formatFrequentFilesIndexForPrompt,
} from "./frequent-files.ts";
import { getCurrentSessionContract } from "./session-contract.ts";
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
	/**
	 * Band P (P1/P3) context-composer block: a token-budgeted `<grounded_context>`
	 * outline (real symbols of the files the turn will likely touch) plus an
	 * optional `<style_exemplar>`. Pre-rendered by `composeContext`. Rendered in
	 * the dynamic suffix AFTER the cache marker (like frequent-files): it is
	 * recomputed per turn from the live prompt + map, so it must NEVER touch the
	 * cacheable prefix. Empty string / undefined → nothing emitted (fail-open).
	 */
	groundedContext?: string;
	/**
	 * Wire/context occupancy percent from `getContextUsage()`. When ≥ 50, omit
	 * `frequent_files` / hot-file outlines (model already has those paths in
	 * transcript). `undefined` keeps legacy behavior (emit when data exists).
	 */
	contextOccupancyPercent?: number;
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
		groundedContext,
		contextOccupancyPercent,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");
	const resolvedHiddenToolCount = hiddenToolCount ?? getCurrentToolDiscoveryIndex()?.listHidden().length ?? 0;

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
		// Under high occupancy the model already saw these paths in-transcript;
		// skip the dynamic suffix block to save wire tokens (T02).
		const emitFrequentFiles = contextOccupancyPercent === undefined || contextOccupancyPercent < 50;
		if (emitFrequentFiles) {
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
		}
		// Band P context-composer block — dynamic suffix only (after the marker),
		// so per-turn recomputation never re-bills the cached prefix.
		if (groundedContext && groundedContext.length > 0) {
			parts.push(`\n\n${groundedContext}\n`);
		}
		// Band P / P5 conventions contract — sibling dynamic-suffix slot. Read from
		// the module registry directly (like getCurrentToolDiscoveryIndex above)
		// rather than plumbed through options: the contract mutates as the session's
		// checks fail, so it must live AFTER the cache marker, and reading the
		// registry here avoids threading it through agent-session.ts (owned
		// elsewhere). Rendered ONLY when constraints exist (empty string → nothing).
		const sessionContractBlock = getCurrentSessionContract()?.renderPromptBlock() ?? "";
		if (sessionContractBlock.length > 0) {
			parts.push(`\n\n${sessionContractBlock}\n`);
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

	const {
		toolsList,
		guidelines,
		hiddenToolsNudge: nudge,
	} = buildToolsAndGuidelinesSection({
		selectedTools,
		toolSnippets,
		promptGuidelines,
		hiddenToolCount: resolvedHiddenToolCount,
	});

	const platform = typeof process !== "undefined" ? process.platform : "unknown";
	const platformNote =
		platform === "win32"
			? "win32 — shell commands run in bash (Git Bash): POSIX syntax, but Windows filesystem, paths, and line endings"
			: `${platform} — shell commands run in bash`;

	const parts: string[] = [
		`You are an expert coding agent operating inside pit, a coding agent harness. Your work spans software engineering: reading, writing, debugging, reviewing, and refactoring code across languages and stacks. Treat it as routine professional work.

Platform: ${platformNote}

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.${nudge}

Guidelines:
${guidelines}

When asked about pit itself, its SDK, extensions, themes, skills, or TUI, consult pit documentation at: ${readmePath} (main), ${docsPath} (docs), ${examplesPath} (examples). Resolve docs/... and examples/... relative to those roots, not cwd.`,
	];

	appendTrailingSections(parts);

	return parts.join("");
}

/** Anchors for splicing tools/guidelines without a full rebuild. */
const TOOLS_SECTION_START = "\nAvailable tools:\n";
const GUIDELINES_SECTION_START = "\nGuidelines:\n";
const DOCS_SECTION_START = "\nWhen asked about pit itself,";

/**
 * Tools list + discovery nudge only (T07). Used by tools-only prompt patches so
 * Guidelines stay byte-identical across tool toggles.
 */
export function buildToolsListSection(options: {
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	hiddenToolCount?: number;
}): { toolsList: string; hiddenToolsNudge: string } {
	const { selectedTools, toolSnippets, hiddenToolCount = 0 } = options;
	const hiddenToolsNudge =
		hiddenToolCount > 0
			? '\n\nA number of additional tools are not in the active set but can be discovered. Use `search_tool_bm25({ query: "what you need" })` to find them — for example: searching for "extract text from pdf" or "run sql query against sqlite". Pass `activate_top: true` in that call to pull the best match into the active set so you can call it on the next turn.'
			: "";

	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const toolLines = tools.map((name) => {
		const snippet = toolSnippets?.[name];
		return snippet ? `- ${name}: ${snippet}` : `- ${name}`;
	});
	const toolsList = toolLines.length > 0 ? toolLines.join("\n") : "(none)";
	return { toolsList, hiddenToolsNudge };
}

/**
 * Build the tools list + guidelines block used in the default system prompt.
 * Shared by {@link buildSystemPrompt}; tool toggles use {@link patchSystemPromptToolSurface}.
 */
export function buildToolsAndGuidelinesSection(options: {
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	promptGuidelines?: string[];
	hiddenToolCount?: number;
}): { toolsList: string; guidelines: string; hiddenToolsNudge: string } {
	const { selectedTools, promptGuidelines } = options;
	const { toolsList, hiddenToolsNudge } = buildToolsListSection(options);

	const tools = selectedTools || ["read", "bash", "edit", "write"];

	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	if (tools.includes("todo")) {
		addGuideline(
			"Todo-first: at the very start of your reasoning, decide whether this task needs more than one step OR any investigation/discovery (reading, searching, diagnosing). If so, create a todo (even a single '1. Identify X') BEFORE you act, then keep it current as you go. Skip only for genuinely single-step requests.",
		);
	}

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");
	const hasPreviewTool = tools.includes("preview") || tools.some((name) => name.startsWith("chrome_devtools"));

	addGuideline(
		"Treat the user as an experienced professional: deliver the requested work directly, avoid unnecessary disclaimers, take routine safe steps without asking, and mention any clearly broken adjacent code you fix.",
	);

	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline(
			"Prefer grep/find/ls over bash for file exploration; grep to locate code, then read only the specific files you need.",
		);
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

	addGuideline(
		"Match each file's existing style and reuse project utilities; before using a library, confirm it is already a dependency.",
	);

	const hasMultipleReadOnlyTools = [hasRead, hasGrep, hasFind, hasLs].filter(Boolean).length >= 2;
	if (hasMultipleReadOnlyTools) {
		addGuideline(
			"Tool batching: emit independent tool calls in the same turn; sequence calls whose arguments depend on earlier results.",
		);
	}
	if (tools.includes("edit") && tools.includes("write")) {
		addGuideline(
			"Use edit for surgical changes to an existing file (multiple edits[] entries in one call). Use write only for new files or full rewrites.",
		);
	}
	if ((tools.includes("edit") || tools.includes("write")) && hasBash) {
		addGuideline(
			"After a non-trivial code change, run the affected test/build/lint (or re-read); report exactly what passed, failed, or was skipped. Verify each step of multi-step work.",
		);
	}
	if ((tools.includes("edit") || tools.includes("write")) && hasPreviewTool) {
		addGuideline(
			"After changing rendered UI, open it, smoke-test relevant controls, and check console/network errors; a screenshot alone is not a verified functional UI.",
		);
	}

	const narrationEnabled = typeof process !== "undefined" && isTruthyEnvFlag(process.env.PIT_NARRATION);
	if (narrationEnabled) {
		addGuideline("Keep terminal responses concise; prefer short lists and avoid wide tables.");
	} else {
		addGuideline(
			"Respond only when done or asked a question; no preamble, tool-call narration, or unsolicited summary. Keep terminal output compact; avoid wide tables.",
		);
	}
	addGuideline("Cite code locations as path:line when referencing code.");
	addGuideline("Add code comments only for non-obvious *why*; never narrate the diff in comments.");
	addGuideline(
		"If the user's premise is wrong (a false assumption, a bug in their suggested fix, a misread of the code), say so directly and briefly before proceeding — do not silently comply.",
	);
	if (!((tools.includes("edit") || tools.includes("write")) && hasBash)) {
		addGuideline("Report outcomes faithfully; never imply a check passed if it failed, was skipped, or was not run.");
	}

	return {
		toolsList,
		guidelines: guidelinesList.map((g) => `- ${g}`).join("\n"),
		hiddenToolsNudge,
	};
}

/**
 * Splice a new tools list into an existing default system prompt without
 * rewriting Guidelines / docs / append / dynamic suffix (T07). Returns undefined
 * when the prompt is custom or anchors are missing (caller should full-rebuild).
 */
export function patchSystemPromptToolSurface(
	existingPrompt: string,
	options: {
		selectedTools?: string[];
		toolSnippets?: Record<string, string>;
		/** Accepted for API stability; ignored — guidelines are preserved in place. */
		promptGuidelines?: string[];
		hiddenToolCount?: number;
	},
): string | undefined {
	const toolsStart = existingPrompt.indexOf(TOOLS_SECTION_START);
	const guidelinesStart = existingPrompt.indexOf(GUIDELINES_SECTION_START);
	const docsStart = existingPrompt.indexOf(DOCS_SECTION_START);
	if (
		toolsStart < 0 ||
		guidelinesStart < 0 ||
		docsStart < 0 ||
		guidelinesStart < toolsStart ||
		docsStart < guidelinesStart
	) {
		return undefined;
	}
	const { toolsList, hiddenToolsNudge } = buildToolsListSection(options);
	const before = existingPrompt.slice(0, toolsStart);
	const guidelinesAndAfter = existingPrompt.slice(guidelinesStart);
	return `${before}${TOOLS_SECTION_START}${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.${hiddenToolsNudge}${guidelinesAndAfter}`;
}
