export { createLspTool, createLspToolDefinition, type LspToolInput, type LspToolOptions } from "../lsp/tool.ts";
export {
	type AskToolDetails,
	type AskToolInput,
	type AskToolOptions,
	createAskTool,
	createAskToolDefinition,
} from "./ask.ts";
export {
	type AstEditToolDetails,
	type AstEditToolInput,
	type AstEditToolOptions,
	createAstEditTool,
	createAstEditToolDefinition,
} from "./ast-edit.ts";
export {
	type AstGrepToolDetails,
	type AstGrepToolInput,
	type AstGrepToolOptions,
	createAstGrepTool,
	createAstGrepToolDefinition,
} from "./ast-grep.ts";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	type CalcToolDetails,
	type CalcToolInput,
	type CalcToolOptions,
	createCalcTool,
	createCalcToolDefinition,
} from "./calc.ts";
export { createDebugTool, createDebugToolDefinition, type DebugToolInput, type DebugToolOptions } from "./debug.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export {
	createEditHashlineTool,
	createEditHashlineToolDefinition,
	type EditHashlineToolInput,
	type EditHashlineToolOptions,
} from "./edit-hashline.ts";
export {
	createEvalTool,
	createEvalToolDefinition,
	type EvalToolDetails,
	type EvalToolInput,
	type EvalToolOptions,
} from "./eval.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createForgetTool,
	createForgetToolDefinition,
	type ForgetToolDetails,
	type ForgetToolInput,
	type ForgetToolOptions,
} from "./forget.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createInspectImageTool,
	createInspectImageToolDefinition,
	type InspectImageToolDetails,
	type InspectImageToolInput,
	type InspectImageToolOptions,
} from "./inspect-image.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	createRecallTool,
	createRecallToolDefinition,
	type RecallToolDetails,
	type RecallToolInput,
	type RecallToolOptions,
} from "./recall.ts";
export {
	createRecallToolOutputDefinition,
	createRecallToolOutputTool,
	type RecallToolOutputDetails,
	type RecallToolOutputInput,
} from "./recall-tool-output.ts";
export {
	createRecipeTool,
	createRecipeToolDefinition,
	type RecipeToolDetails,
	type RecipeToolInput,
	type RecipeToolOptions,
} from "./recipe.ts";
export {
	createReflectTool,
	createReflectToolDefinition,
	type ReflectToolDetails,
	type ReflectToolInput,
	type ReflectToolOptions,
} from "./reflect.ts";
export {
	createRenderMermaidTool,
	createRenderMermaidToolDefinition,
	type RenderMermaidToolDetails,
	type RenderMermaidToolInput,
	type RenderMermaidToolOptions,
} from "./render-mermaid.ts";
export {
	createResolveTool,
	createResolveToolDefinition,
	type ResolveToolDetails,
	type ResolveToolInput,
	type ResolveToolOptions,
} from "./resolve.ts";
export {
	createRetainTool,
	createRetainToolDefinition,
	type RetainToolDetails,
	type RetainToolInput,
	type RetainToolOptions,
} from "./retain.ts";
export {
	createSearchToolBm25Definition,
	createSearchToolBm25Tool,
	type SearchToolBm25Details,
	type SearchToolBm25Input,
	type SearchToolBm25Options,
} from "./search-tool-bm25.ts";
export {
	createSymbolTool,
	createSymbolToolDefinition,
	type SymbolOperations,
	type SymbolToolDetails,
	type SymbolToolInput,
	type SymbolToolOptions,
} from "./symbol.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWebSearchTool,
	createWebSearchToolDefinition,
	type WebSearchToolDetails,
	type WebSearchToolInput,
	type WebSearchToolOptions,
} from "./web-search.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@pit/agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { createLspTool, createLspToolDefinition, type LspToolOptions } from "../lsp/tool.ts";
import { type AskToolOptions, createAskTool, createAskToolDefinition } from "./ask.ts";
import { type AstEditToolOptions, createAstEditTool, createAstEditToolDefinition } from "./ast-edit.ts";
import { type AstGrepToolOptions, createAstGrepTool, createAstGrepToolDefinition } from "./ast-grep.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { type CalcToolOptions, createCalcTool, createCalcToolDefinition } from "./calc.ts";
import {
	type ChromeDevtoolsToolOptions,
	createChromeClickToolDefinition,
	createChromeEvaluateToolDefinition,
	createChromeFillToolDefinition,
	createChromeGetNetworkBodyToolDefinition,
	createChromeGetTextToolDefinition,
	createChromeHoverToolDefinition,
	createChromeListPagesToolDefinition,
	createChromeNavigateToolDefinition,
	createChromePressKeyToolDefinition,
	createChromeReadConsoleToolDefinition,
	createChromeReadNetworkToolDefinition,
	createChromeScreenshotToolDefinition,
	createChromeSelectOptionToolDefinition,
	createChromeSelectPageToolDefinition,
	createChromeSnapshotToolDefinition,
	createChromeUploadFileToolDefinition,
	createChromeWaitForToolDefinition,
} from "./chrome-devtools.ts";
import { createDebugTool, createDebugToolDefinition, type DebugToolOptions } from "./debug.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import {
	createEditHashlineTool,
	createEditHashlineToolDefinition,
	type EditHashlineToolOptions,
} from "./edit-hashline.ts";
import { createEvalTool, createEvalToolDefinition, type EvalToolOptions } from "./eval.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createFindSymbolTool, createFindSymbolToolDefinition, type FindSymbolToolOptions } from "./find-symbol.ts";
import { createForgetTool, createForgetToolDefinition, type ForgetToolOptions } from "./forget.ts";
import {
	createGoalCompleteTool,
	createGoalCompleteToolDefinition,
	type GoalCompleteToolOptions,
} from "./goal-complete.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import {
	createInspectImageTool,
	createInspectImageToolDefinition,
	type InspectImageToolOptions,
} from "./inspect-image.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createPlanTool, createPlanToolDefinition, type PlanToolOptions } from "./plan.ts";
import { createPreviewTool, createPreviewToolDefinition } from "./preview.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createRecallTool, createRecallToolDefinition, type RecallToolOptions } from "./recall.ts";
import { createRecallToolOutputDefinition, createRecallToolOutputTool } from "./recall-tool-output.ts";
import { createRecipeTool, createRecipeToolDefinition, type RecipeToolOptions } from "./recipe.ts";
import { createReflectTool, createReflectToolDefinition, type ReflectToolOptions } from "./reflect.ts";
import {
	createRenderMermaidTool,
	createRenderMermaidToolDefinition,
	type RenderMermaidToolOptions,
} from "./render-mermaid.ts";
import { createRepoMapTool, createRepoMapToolDefinition, type RepoMapToolOptions } from "./repo-map.ts";
import { createResolveTool, createResolveToolDefinition, type ResolveToolOptions } from "./resolve.ts";
import { createRetainTool, createRetainToolDefinition, type RetainToolOptions } from "./retain.ts";
import {
	createSearchSkillsTool,
	createSearchSkillsToolDefinition,
	type SearchSkillsToolOptions,
} from "./search-skills.ts";
import {
	createSearchToolBm25Definition,
	createSearchToolBm25Tool,
	type SearchToolBm25Options,
} from "./search-tool-bm25.ts";
import { createSymbolTool, createSymbolToolDefinition, type SymbolToolOptions } from "./symbol.ts";
import { createTodoTool, createTodoToolDefinition, type TodoToolOptions } from "./todo.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createWebSearchTool, createWebSearchToolDefinition, type WebSearchToolOptions } from "./web-search.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
/** A coding tool's membership/gate in the default coding surface. */
type CodingGate = "always" | "native" | "webSearch" | "eval" | "hindsight" | "chromeDevtools" | "lsp" | "debug";

interface ToolRegistryEntry {
	/**
	 * Builds the executable tool. Optional: every built-in factory is exactly
	 * `wrapToolDefinition(definitionFactory(cwd, options))`, so an entry may omit
	 * this and let `buildTool` derive it from `definitionFactory` (used by the
	 * chrome_devtools_* tools to drop their pass-through factory wrappers).
	 */
	factory?: (cwd: string, options?: any) => Tool;
	/** Builds the lazy tool definition. */
	definitionFactory: (cwd: string, options?: any) => ToolDef;
	/**
	 * Key into `ToolsOptions` for this tool's per-tool options. Centralizes the
	 * snake_case tool-name vs camelCase options-key mismatch (e.g. tool
	 * `search_tool_bm25` -> options key `searchToolBm25`) in one place.
	 */
	optionsKey: keyof ToolsOptions;
	/** Member of the read-only tool surface (createReadOnly*). */
	readOnly: boolean;
	/**
	 * Membership + gate in the default coding surface (createCoding*).
	 * `false` = not a coding tool; a gate name = included only when enabled.
	 */
	coding: CodingGate | false;
}

/**
 * Single source of truth for every built-in tool. Insertion order IS the
 * canonical tool order: every derived artifact — the `ToolName` union,
 * `allToolNames`, the read-only/coding/all lists, and the name->factory
 * lookups — iterates this table, so adding a tool is a one-row change here
 * instead of edits across nine sites. Renaming a tool (e.g. `search_tool_bm25`)
 * is now a single key rename too; left as-is to avoid changing the
 * model-facing tool name and any settings that reference it.
 */
const TOOL_REGISTRY = {
	read: {
		factory: createReadTool,
		definitionFactory: createReadToolDefinition,
		optionsKey: "read",
		readOnly: true,
		coding: "always",
	},
	bash: {
		factory: createBashTool,
		definitionFactory: createBashToolDefinition,
		optionsKey: "bash",
		readOnly: false,
		coding: "always",
	},
	edit: {
		factory: createEditTool,
		definitionFactory: createEditToolDefinition,
		optionsKey: "edit",
		readOnly: false,
		coding: "always",
	},
	edit_v2: {
		factory: createEditHashlineTool,
		definitionFactory: createEditHashlineToolDefinition,
		optionsKey: "edit_v2",
		readOnly: false,
		coding: "always",
	},
	write: {
		factory: createWriteTool,
		definitionFactory: createWriteToolDefinition,
		optionsKey: "write",
		readOnly: false,
		coding: "always",
	},
	grep: {
		factory: createGrepTool,
		definitionFactory: createGrepToolDefinition,
		optionsKey: "grep",
		readOnly: true,
		coding: false,
	},
	find: {
		factory: createFindTool,
		definitionFactory: createFindToolDefinition,
		optionsKey: "find",
		readOnly: true,
		coding: false,
	},
	ls: {
		factory: createLsTool,
		definitionFactory: createLsToolDefinition,
		optionsKey: "ls",
		readOnly: true,
		coding: false,
	},
	symbol: {
		factory: createSymbolTool,
		definitionFactory: createSymbolToolDefinition,
		optionsKey: "symbol",
		readOnly: true,
		coding: "always",
	},
	find_symbol: {
		factory: createFindSymbolTool,
		definitionFactory: createFindSymbolToolDefinition,
		optionsKey: "find_symbol",
		readOnly: true,
		coding: "always",
	},
	repo_map: {
		factory: createRepoMapTool,
		definitionFactory: createRepoMapToolDefinition,
		optionsKey: "repo_map",
		readOnly: true,
		coding: false,
	},
	search_skills: {
		factory: createSearchSkillsTool,
		definitionFactory: createSearchSkillsToolDefinition,
		optionsKey: "search_skills",
		readOnly: true,
		coding: "always",
	},
	ask: {
		factory: createAskTool,
		definitionFactory: createAskToolDefinition,
		optionsKey: "ask",
		readOnly: false,
		coding: "always",
	},
	resolve: {
		factory: createResolveTool,
		definitionFactory: createResolveToolDefinition,
		optionsKey: "resolve",
		readOnly: false,
		coding: "always",
	},
	search_tool_bm25: {
		factory: createSearchToolBm25Tool,
		definitionFactory: createSearchToolBm25Definition,
		optionsKey: "searchToolBm25",
		readOnly: false,
		coding: "always",
	},
	ast_grep: {
		factory: createAstGrepTool,
		definitionFactory: createAstGrepToolDefinition,
		optionsKey: "ast_grep",
		readOnly: false,
		coding: "always",
	},
	ast_edit: {
		factory: createAstEditTool,
		definitionFactory: createAstEditToolDefinition,
		optionsKey: "ast_edit",
		readOnly: false,
		coding: "always",
	},
	web_search: {
		factory: createWebSearchTool,
		definitionFactory: createWebSearchToolDefinition,
		optionsKey: "web_search",
		readOnly: false,
		coding: "webSearch",
	},
	eval: {
		factory: createEvalTool,
		definitionFactory: createEvalToolDefinition,
		optionsKey: "eval",
		readOnly: false,
		coding: "eval",
	},
	retain: {
		factory: createRetainTool,
		definitionFactory: createRetainToolDefinition,
		optionsKey: "retain",
		readOnly: false,
		coding: "hindsight",
	},
	recall: {
		factory: createRecallTool,
		definitionFactory: createRecallToolDefinition,
		optionsKey: "recall",
		readOnly: false,
		coding: "hindsight",
	},
	reflect: {
		factory: createReflectTool,
		definitionFactory: createReflectToolDefinition,
		optionsKey: "reflect",
		readOnly: false,
		coding: "hindsight",
	},
	forget: {
		factory: createForgetTool,
		definitionFactory: createForgetToolDefinition,
		optionsKey: "forget",
		readOnly: false,
		coding: "hindsight",
	},
	calc: {
		factory: createCalcTool,
		definitionFactory: createCalcToolDefinition,
		optionsKey: "calc",
		readOnly: false,
		coding: "native",
	},
	recipe: {
		factory: createRecipeTool,
		definitionFactory: createRecipeToolDefinition,
		optionsKey: "recipe",
		readOnly: false,
		coding: "native",
	},
	inspect_image: {
		factory: createInspectImageTool,
		definitionFactory: createInspectImageToolDefinition,
		optionsKey: "inspect_image",
		readOnly: false,
		coding: "native",
	},
	render_mermaid: {
		factory: createRenderMermaidTool,
		definitionFactory: createRenderMermaidToolDefinition,
		optionsKey: "render_mermaid",
		readOnly: false,
		coding: "native",
	},
	goal_complete: {
		factory: createGoalCompleteTool,
		definitionFactory: createGoalCompleteToolDefinition,
		optionsKey: "goal_complete",
		readOnly: false,
		// Off the default surface; activated dynamically while a goal is active.
		coding: false,
	},
	todo: {
		factory: createTodoTool,
		definitionFactory: createTodoToolDefinition,
		optionsKey: "todo",
		readOnly: false,
		coding: "always",
	},
	plan: {
		factory: createPlanTool,
		definitionFactory: createPlanToolDefinition,
		optionsKey: "plan",
		readOnly: false,
		coding: "always",
	},
	lsp: {
		factory: createLspTool,
		definitionFactory: createLspToolDefinition,
		optionsKey: "lsp",
		// Has write-tier actions (rename, code_actions apply, rename_file).
		readOnly: false,
		coding: "lsp",
	},
	debug: {
		factory: createDebugTool,
		definitionFactory: createDebugToolDefinition,
		optionsKey: "debug",
		// Exec-tier actions (launch/attach/continue/step/breakpoints).
		readOnly: false,
		coding: "debug",
	},
	chrome_devtools_list_pages: {
		definitionFactory: createChromeListPagesToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	chrome_devtools_select_page: {
		definitionFactory: createChromeSelectPageToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_navigate: {
		definitionFactory: createChromeNavigateToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_evaluate: {
		definitionFactory: createChromeEvaluateToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_screenshot: {
		definitionFactory: createChromeScreenshotToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	chrome_devtools_read_console: {
		definitionFactory: createChromeReadConsoleToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	chrome_devtools_read_network: {
		definitionFactory: createChromeReadNetworkToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	chrome_devtools_click: {
		definitionFactory: createChromeClickToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_fill: {
		definitionFactory: createChromeFillToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_press_key: {
		definitionFactory: createChromePressKeyToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_get_text: {
		definitionFactory: createChromeGetTextToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	chrome_devtools_wait_for: {
		definitionFactory: createChromeWaitForToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	chrome_devtools_hover: {
		definitionFactory: createChromeHoverToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_select_option: {
		definitionFactory: createChromeSelectOptionToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_upload_file: {
		definitionFactory: createChromeUploadFileToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_snapshot: {
		definitionFactory: createChromeSnapshotToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	chrome_devtools_get_network_body: {
		definitionFactory: createChromeGetNetworkBodyToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	preview: {
		factory: createPreviewTool,
		definitionFactory: createPreviewToolDefinition,
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	recall_tool_output: {
		factory: createRecallToolOutputTool,
		definitionFactory: createRecallToolOutputDefinition,
		optionsKey: "recallToolOutput",
		readOnly: true,
		coding: false,
	},
} satisfies Record<string, ToolRegistryEntry>;

export type ToolName = keyof typeof TOOL_REGISTRY;

export const allToolNames: Set<ToolName> = new Set(Object.keys(TOOL_REGISTRY) as ToolName[]);

/**
 * Uniformly-typed view of the registry. `satisfies` above preserves each
 * entry's precise factory types (great for inference), but that makes
 * `registry[name].factory` a union of 24 distinct signatures — calling it
 * would demand the intersection of every options type. Reading through this
 * widened `Record` view gives every entry the uniform `(cwd, options?) => Tool`
 * signature the generic builders below rely on.
 */
const registry: Record<ToolName, ToolRegistryEntry> = TOOL_REGISTRY;

/**
 * Build a tool from a registry entry. Uses the entry's explicit `factory` when
 * present; otherwise derives it from `definitionFactory` the same way every
 * built-in factory does — `wrapToolDefinition(definitionFactory(cwd, options))`.
 */
function buildTool(entry: ToolRegistryEntry, cwd: string, options?: unknown): Tool {
	if (entry.factory) return entry.factory(cwd, options);
	return wrapToolDefinition(entry.definitionFactory(cwd, options));
}

/** Every tool name in canonical (registry insertion) order. */
function toolNamesInOrder(): ToolName[] {
	return Object.keys(TOOL_REGISTRY) as ToolName[];
}

/**
 * The full chrome feature surface (the chrome_devtools_* CDP tools plus the
 * higher-level `preview` tool), derived from the registry so a new chrome tool
 * is automatically part of the default surface and the discovery exclude.
 * All entries share the `chromeDevtools` gate and the auto-launched Chrome,
 * so they activate and hide from discovery as one unit.
 */
export const chromeFeatureToolNames: ToolName[] = toolNamesInOrder().filter(
	(name) => registry[name].coding === "chromeDevtools",
);

/** Whether a coding-surface gate is open given the supplied options. */
function codingGateOpen(gate: CodingGate, options?: ToolsOptions): boolean {
	switch (gate) {
		case "always":
		case "native":
			return true;
		case "webSearch":
			return !!options?.webSearch?.enabled;
		case "eval":
			return !!options?.eval?.enabled;
		case "hindsight":
			return !!options?.hindsight?.enabled;
		case "chromeDevtools":
			return !!options?.chromeDevtools?.enabled;
		case "lsp":
			// Default ON: opt out via `lsp.enabled: false`.
			return options?.lsp?.enabled !== false;
		case "debug":
			// Default ON: opt out via `debug.enabled: false`.
			return options?.debug?.enabled !== false;
	}
}

/**
 * Resolves the per-tool options object for a coding-surface build. `web_search`
 * merges its default provider from the gate config, matching legacy behavior;
 * every other tool just reads its `optionsKey` slot.
 */
function codingToolOptions(name: ToolName, options?: ToolsOptions): unknown {
	if (name === "web_search") {
		return {
			...(options?.web_search ?? {}),
			defaultProvider: options?.web_search?.defaultProvider ?? options?.webSearch?.defaultProvider,
		};
	}
	return options?.[registry[name].optionsKey];
}

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	edit_v2?: EditHashlineToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	symbol?: SymbolToolOptions;
	find_symbol?: FindSymbolToolOptions;
	repo_map?: RepoMapToolOptions;
	search_skills?: SearchSkillsToolOptions;
	ask?: AskToolOptions;
	resolve?: ResolveToolOptions;
	searchToolBm25?: SearchToolBm25Options;
	ast_grep?: AstGrepToolOptions;
	ast_edit?: AstEditToolOptions;
	web_search?: WebSearchToolOptions;
	webSearch?: { enabled?: boolean; defaultProvider?: string };
	eval?: EvalToolOptions & { enabled?: boolean };
	retain?: RetainToolOptions;
	recall?: RecallToolOptions;
	reflect?: ReflectToolOptions;
	forget?: ForgetToolOptions;
	calc?: CalcToolOptions;
	recipe?: RecipeToolOptions;
	inspect_image?: InspectImageToolOptions;
	render_mermaid?: RenderMermaidToolOptions;
	goal_complete?: GoalCompleteToolOptions;
	todo?: TodoToolOptions;
	plan?: PlanToolOptions;
	chromeDevtools?: ChromeDevtoolsToolOptions & { enabled?: boolean };
	hindsight?: { enabled?: boolean };
	recallToolOutput?: Record<string, never>;
	lsp?: LspToolOptions & { enabled?: boolean };
	debug?: DebugToolOptions & { enabled?: boolean };
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	const entry = registry[toolName];
	if (!entry) throw new Error(`Unknown tool name: ${toolName}`);
	return entry.definitionFactory(cwd, options?.[entry.optionsKey]);
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	const entry = registry[toolName];
	if (!entry) throw new Error(`Unknown tool name: ${toolName}`);
	return buildTool(entry, cwd, options?.[entry.optionsKey]);
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return Object.fromEntries(
		toolNamesInOrder().map((name) => [name, createToolDefinition(name, cwd, options)]),
	) as Record<ToolName, ToolDef>;
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	const tools: Tool[] = [];
	for (const name of toolNamesInOrder()) {
		const entry = registry[name];
		if (entry.coding === false || !codingGateOpen(entry.coding, options)) continue;
		tools.push(buildTool(entry, cwd, codingToolOptions(name, options)));
	}
	return tools;
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return toolNamesInOrder()
		.filter((name) => registry[name].readOnly)
		.map((name) => createTool(name, cwd, options));
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return Object.fromEntries(toolNamesInOrder().map((name) => [name, createTool(name, cwd, options)])) as Record<
		ToolName,
		Tool
	>;
}
