/**
 * Public re-export surface for `./core/tools/index.ts`. Only families with a
 * real consumer (repo-internal or, via `src/index.ts`, external SDK embedders)
 * get a named export here — every other registry-only tool is reachable
 * through the generic `createTool`/`createAllTools`/`createCodingTools`
 * builders below instead of a dedicated `createXTool` export (verified
 * zero-consumer repo-wide before trimming; see `src/index.ts`, the actual
 * public surface, which re-exports a further subset of this list).
 */
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
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue, withFileMutationQueues } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
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
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@pit/agent-core";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import { requireOptional } from "../../utils/optional-require.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { LspToolOptions } from "../lsp/tool.ts";
import { BUILTIN_TOOL_SIDE_EFFECTS } from "../permissions/checker.ts";
import { type AskToolOptions, createAskToolDefinition } from "./ask.ts";
import { type AstEditToolOptions, createAstEditToolDefinition } from "./ast-edit.ts";
import { type AstGrepToolOptions, createAstGrepToolDefinition } from "./ast-grep.ts";
import { type BashToolOptions, createBashToolDefinition } from "./bash.ts";
import { type CalcToolOptions, createCalcToolDefinition } from "./calc.ts";
import type { ChromeDevtoolsToolOptions } from "./chrome-devtools.ts";
import { type CodeModeToolOptions, createCodeModeToolDefinition } from "./code-mode.ts";
import type { DebugToolOptions } from "./debug.ts";
import { createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createEditHashlineToolDefinition, type EditHashlineToolOptions } from "./edit-hashline.ts";
import { createEvalToolDefinition, type EvalToolOptions } from "./eval.ts";
import { createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createFindSymbolToolDefinition, type FindSymbolToolOptions } from "./find-symbol.ts";
import { createForgetToolDefinition, type ForgetToolOptions } from "./forget.ts";
import { createGoalCompleteToolDefinition, type GoalCompleteToolOptions } from "./goal-complete.ts";
import { createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createInspectImageToolDefinition, type InspectImageToolOptions } from "./inspect-image.ts";
import { createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createPlanToolDefinition, type PlanToolOptions } from "./plan.ts";
import { createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createRecallToolDefinition, type RecallToolOptions } from "./recall.ts";
import { createRecallHistoryDefinition } from "./recall-history.ts";
import { createRecallToolOutputDefinition } from "./recall-tool-output.ts";
import { createRecipeToolDefinition, type RecipeToolOptions } from "./recipe.ts";
import { createReflectToolDefinition, type ReflectToolOptions } from "./reflect.ts";
import { createRenderMermaidToolDefinition, type RenderMermaidToolOptions } from "./render-mermaid.ts";
import { createRepoMapToolDefinition, type RepoMapToolOptions } from "./repo-map.ts";
import { createResolveToolDefinition, type ResolveToolOptions } from "./resolve.ts";
import { createRetainToolDefinition, type RetainToolOptions } from "./retain.ts";
import { createSearchSkillsToolDefinition, type SearchSkillsToolOptions } from "./search-skills.ts";
import { createSearchToolBm25Definition, type SearchToolBm25Options } from "./search-tool-bm25.ts";
import { createSymbolToolDefinition, type SymbolToolOptions } from "./symbol.ts";
import { createTodoToolDefinition, type TodoToolOptions } from "./todo.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createWebSearchToolDefinition, type WebSearchToolOptions } from "./web-search.ts";
import { createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

type ChromeMod = typeof import("./chrome-devtools.ts");
let chromeMod: ChromeMod | undefined;
function loadChrome(): ChromeMod {
	if (!chromeMod) chromeMod = requireOptional<ChromeMod>(import.meta.url, "./chrome-devtools.ts");
	return chromeMod;
}

type LspToolMod = typeof import("../lsp/tool.ts");
let lspToolMod: LspToolMod | undefined;
function loadLspTool(): LspToolMod {
	if (!lspToolMod) lspToolMod = requireOptional<LspToolMod>(import.meta.url, "../lsp/tool.ts");
	return lspToolMod;
}

type DebugMod = typeof import("./debug.ts");
let debugMod: DebugMod | undefined;
function loadDebug(): DebugMod {
	if (!debugMod) debugMod = requireOptional<DebugMod>(import.meta.url, "./debug.ts");
	return debugMod;
}

type PreviewMod = typeof import("./preview.ts");
let previewMod: PreviewMod | undefined;
function loadPreview(): PreviewMod {
	if (!previewMod) previewMod = requireOptional<PreviewMod>(import.meta.url, "./preview.ts");
	return previewMod;
}

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
/** A coding tool's membership/gate in the default coding surface. */
type CodingGate =
	| "always"
	| "native"
	| "webSearch"
	| "eval"
	| "hindsight"
	| "chromeDevtools"
	| "lsp"
	| "debug"
	| "code";

interface ToolRegistryEntry {
	/**
	 * Builds the executable tool. Optional: every built-in factory was exactly
	 * `wrapToolDefinition(definitionFactory(cwd, options))`, so every entry omits
	 * this and lets `buildTool` derive it from `definitionFactory` instead of
	 * repeating a one-line pass-through wrapper per tool. Kept as an escape
	 * hatch for a future tool whose `AgentTool` factory needs to do more than
	 * wrap the definition.
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
 *
 * Scope: the `coding` gates here govern the SDK export `createCodingTools`
 * (which tools land in a coding-surface build). They do NOT decide the TUI's
 * active surface — that is `_defaultActiveToolNames` in agent-session.ts, which
 * can gate differently (e.g. `code` additionally requires eval to be enabled).
 */
const TOOL_REGISTRY = {
	read: {
		definitionFactory: createReadToolDefinition,
		optionsKey: "read",
		readOnly: true,
		coding: "always",
	},
	bash: {
		definitionFactory: createBashToolDefinition,
		optionsKey: "bash",
		readOnly: false,
		coding: "always",
	},
	edit: {
		definitionFactory: createEditToolDefinition,
		optionsKey: "edit",
		readOnly: false,
		coding: "always",
	},
	edit_v2: {
		definitionFactory: createEditHashlineToolDefinition,
		optionsKey: "edit_v2",
		readOnly: false,
		coding: "always",
	},
	write: {
		definitionFactory: createWriteToolDefinition,
		optionsKey: "write",
		readOnly: false,
		coding: "always",
	},
	grep: {
		definitionFactory: createGrepToolDefinition,
		optionsKey: "grep",
		readOnly: true,
		// Aligned with the TUI's core surface (_defaultActiveToolNames), which has
		// always included grep unconditionally — the SDK's createCodingTools was the
		// one place a coding agent shipped without it.
		coding: "always",
	},
	find: {
		definitionFactory: createFindToolDefinition,
		optionsKey: "find",
		readOnly: true,
		// Aligned with the TUI's core surface (_defaultActiveToolNames); see `grep`.
		coding: "always",
	},
	ls: {
		definitionFactory: createLsToolDefinition,
		optionsKey: "ls",
		readOnly: true,
		// Aligned with the TUI's core surface (_defaultActiveToolNames); see `grep`.
		coding: "always",
	},
	symbol: {
		definitionFactory: createSymbolToolDefinition,
		optionsKey: "symbol",
		readOnly: true,
		coding: "always",
	},
	find_symbol: {
		definitionFactory: createFindSymbolToolDefinition,
		optionsKey: "find_symbol",
		readOnly: true,
		coding: "always",
	},
	repo_map: {
		definitionFactory: createRepoMapToolDefinition,
		optionsKey: "repo_map",
		readOnly: true,
		coding: false,
	},
	search_skills: {
		definitionFactory: createSearchSkillsToolDefinition,
		optionsKey: "search_skills",
		readOnly: true,
		coding: "always",
	},
	ask: {
		definitionFactory: createAskToolDefinition,
		optionsKey: "ask",
		readOnly: false,
		coding: "always",
	},
	resolve: {
		definitionFactory: createResolveToolDefinition,
		optionsKey: "resolve",
		readOnly: false,
		coding: "always",
	},
	search_tool_bm25: {
		definitionFactory: createSearchToolBm25Definition,
		optionsKey: "searchToolBm25",
		readOnly: false,
		coding: "always",
	},
	ast_grep: {
		definitionFactory: createAstGrepToolDefinition,
		optionsKey: "ast_grep",
		readOnly: false,
		coding: "always",
	},
	ast_edit: {
		definitionFactory: createAstEditToolDefinition,
		optionsKey: "ast_edit",
		readOnly: false,
		coding: "always",
	},
	web_search: {
		definitionFactory: createWebSearchToolDefinition,
		optionsKey: "web_search",
		readOnly: false,
		coding: "webSearch",
	},
	eval: {
		definitionFactory: createEvalToolDefinition,
		optionsKey: "eval",
		readOnly: false,
		coding: "eval",
	},
	code: {
		definitionFactory: createCodeModeToolDefinition,
		optionsKey: "code",
		readOnly: false,
		// Default-on coding surface. Functional only once the agent-session injects
		// the harness-routed dispatcher + getActiveToolNames via `options.code`
		// (see core/tools/code-mode.ts wiring comment). Opt out via
		// `code.enabled: false` -> gate handled below.
		coding: "code",
	},
	retain: {
		definitionFactory: createRetainToolDefinition,
		optionsKey: "retain",
		readOnly: false,
		coding: "hindsight",
	},
	recall: {
		definitionFactory: createRecallToolDefinition,
		optionsKey: "recall",
		// Pure read (bank search, no mutation) — belongs in the read-only surface.
		readOnly: true,
		coding: "hindsight",
	},
	reflect: {
		definitionFactory: createReflectToolDefinition,
		optionsKey: "reflect",
		// Pure read (bank digest, no mutation) — belongs in the read-only surface.
		readOnly: true,
		coding: "hindsight",
	},
	forget: {
		definitionFactory: createForgetToolDefinition,
		optionsKey: "forget",
		readOnly: false,
		coding: "hindsight",
	},
	calc: {
		definitionFactory: createCalcToolDefinition,
		optionsKey: "calc",
		readOnly: false,
		coding: "native",
	},
	recipe: {
		definitionFactory: createRecipeToolDefinition,
		optionsKey: "recipe",
		readOnly: false,
		coding: "native",
	},
	inspect_image: {
		definitionFactory: createInspectImageToolDefinition,
		optionsKey: "inspect_image",
		readOnly: false,
		coding: "native",
	},
	render_mermaid: {
		definitionFactory: createRenderMermaidToolDefinition,
		optionsKey: "render_mermaid",
		readOnly: false,
		coding: "native",
	},
	goal_complete: {
		definitionFactory: createGoalCompleteToolDefinition,
		optionsKey: "goal_complete",
		readOnly: false,
		// Off the default surface; activated dynamically while a goal is active.
		coding: false,
	},
	todo: {
		definitionFactory: createTodoToolDefinition,
		optionsKey: "todo",
		readOnly: false,
		coding: "always",
	},
	plan: {
		definitionFactory: createPlanToolDefinition,
		optionsKey: "plan",
		readOnly: false,
		coding: "always",
	},
	lsp: {
		definitionFactory: (cwd, opts) => loadLspTool().createLspToolDefinition(cwd, opts),
		optionsKey: "lsp",
		// Has write-tier actions (rename, code_actions apply, rename_file).
		readOnly: false,
		coding: "lsp",
	},
	debug: {
		definitionFactory: (cwd, opts) => loadDebug().createDebugToolDefinition(cwd, opts),
		optionsKey: "debug",
		// Exec-tier actions (launch/attach/continue/step/breakpoints).
		readOnly: false,
		coding: "debug",
	},
	chrome_devtools_list_pages: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeListPagesToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	chrome_devtools_select_page: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeSelectPageToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_navigate: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeNavigateToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_close_page: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeClosePageToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_evaluate: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeEvaluateToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_screenshot: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeScreenshotToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	chrome_devtools_read_console: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeReadConsoleToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	chrome_devtools_read_network: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeReadNetworkToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	chrome_devtools_click: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeClickToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_fill: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeFillToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_press_key: {
		definitionFactory: (cwd, opts) => loadChrome().createChromePressKeyToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_get_text: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeGetTextToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	chrome_devtools_wait_for: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeWaitForToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	chrome_devtools_hover: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeHoverToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_select_option: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeSelectOptionToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_upload_file: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeUploadFileToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: false,
		coding: "chromeDevtools",
	},
	chrome_devtools_snapshot: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeSnapshotToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	chrome_devtools_get_network_body: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeGetNetworkBodyToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	chrome_devtools_element_to_source: {
		definitionFactory: (cwd, opts) => loadChrome().createChromeElementToSourceToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		readOnly: true,
		coding: "chromeDevtools",
	},
	preview: {
		definitionFactory: (cwd, opts) => loadPreview().createPreviewToolDefinition(cwd, opts),
		optionsKey: "chromeDevtools",
		// Starts a local HTTP server + navigates the user's Chrome — a real side
		// effect, not a read. Must NOT leak into createReadOnlyTools.
		readOnly: false,
		coding: "chromeDevtools",
	},
	recall_tool_output: {
		definitionFactory: createRecallToolOutputDefinition,
		optionsKey: "recallToolOutput",
		readOnly: true,
		coding: false,
	},
	recall_history: {
		definitionFactory: createRecallHistoryDefinition,
		optionsKey: "recallHistory",
		readOnly: true,
		coding: false,
	},
} satisfies Record<string, ToolRegistryEntry>;

export type ToolName = keyof typeof TOOL_REGISTRY;

export const allToolNames: Set<ToolName> = new Set(Object.keys(TOOL_REGISTRY) as ToolName[]);

/**
 * Uniformly-typed view of the registry. `satisfies` above preserves each
 * entry's precise `definitionFactory` type (great for inference), but that
 * makes `registry[name].definitionFactory` a union of many distinct
 * signatures — calling it would demand the intersection of every options
 * type. Reading through this widened `Record` view gives every entry the
 * uniform `(cwd, options?) => ToolDef` signature the generic builders below
 * rely on.
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

/**
 * The hindsight memory family (retain/recall/reflect/forget), derived from the
 * registry so `hindsight-scope.ts`'s per-subagent scope rebinding stays in
 * sync with the registry's `hindsight` gate instead of hardcoding the name
 * list a second time.
 */
export const hindsightToolNames: ToolName[] = toolNamesInOrder().filter(
	(name) => registry[name].coding === "hindsight",
);

/**
 * Whether a coding-surface gate is open given the supplied options.
 *
 * Gate convention: `code` honors env PIT_NO_CODE_MODE + settings code.enabled
 * (and requires eval.enabled); `debug`/`lsp` are settings-only
 * (debug.enabled/lsp.enabled). No env opt-out for the latter two.
 */
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
		case "code":
			// Default ON: opt out via `code.enabled: false` (or env PIT_NO_CODE_MODE).
			// Also requires eval: code-mode rides on the JS eval kernel for its
			// bidirectional tool channel, matching the TUI surface gate in
			// agent-session._defaultActiveToolNames (code is gated on eval being on).
			if (isTruthyEnvFlag(process.env.PIT_NO_CODE_MODE)) return false;
			if (options?.eval?.enabled === false) return false;
			// SDK-only tightening: without a harness-routed dispatcher the tool is a
			// functional no-op (see code-mode.ts's "not wired" execute path) — the TUI
			// never hits this gate at all (its own surface always injects one in
			// _buildRuntime), so this only keeps a dispatcher-less SDK build from
			// advertising a tool that can never actually run.
			if (!options?.code?.dispatcher) return false;
			return options?.code?.enabled !== false;
	}
}

/**
 * Resolves the per-tool options object for ANY tool build path. `web_search`
 * merges its default provider from the gate config (`options.webSearch`) on
 * top of its own `options.web_search` slot; every other tool just reads its
 * `optionsKey` slot. Shared by every builder — `createTool`,
 * `createToolDefinition`, `createAllTools`/`createAllToolDefinitions` (which
 * delegate to the two above) and `createCodingTools` — so the merge isn't
 * SDK-coding-surface-only.
 */
function resolveToolOptions(name: ToolName, options?: ToolsOptions): unknown {
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
	code?: CodeModeToolOptions;
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
	recallHistory?: Record<string, never>;
	lsp?: LspToolOptions & { enabled?: boolean };
	debug?: DebugToolOptions & { enabled?: boolean };
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	const entry = registry[toolName];
	if (!entry) throw new Error(`Unknown tool name: ${toolName}`);
	const def = entry.definitionFactory(cwd, resolveToolOptions(toolName, options));
	if (def.sideEffect !== undefined) return def;
	const sideEffect = BUILTIN_TOOL_SIDE_EFFECTS[toolName];
	return sideEffect !== undefined ? { ...def, sideEffect } : def;
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	const entry = registry[toolName];
	if (!entry) throw new Error(`Unknown tool name: ${toolName}`);
	return buildTool(entry, cwd, resolveToolOptions(toolName, options));
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return Object.fromEntries(
		toolNamesInOrder()
			.filter((name) => {
				const gate = registry[name].coding;
				if (gate === "chromeDevtools" || gate === "lsp" || gate === "debug") {
					return codingGateOpen(gate, options);
				}
				return true;
			})
			.map((name) => [name, createToolDefinition(name, cwd, options)]),
	) as Record<ToolName, ToolDef>;
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	const tools: Tool[] = [];
	for (const name of toolNamesInOrder()) {
		const entry = registry[name];
		if (entry.coding === false || !codingGateOpen(entry.coding, options)) continue;
		tools.push(buildTool(entry, cwd, resolveToolOptions(name, options)));
	}
	return tools;
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	const tools: Tool[] = [];
	for (const name of toolNamesInOrder()) {
		const entry = registry[name];
		// Mirror createCodingTools: a read-only tool still lives behind its coding
		// gate (e.g. chrome_devtools_* need chromeDevtools.enabled) so a closed
		// feature gate can't leak its tools into a read-only surface just because
		// they happen to be non-mutating.
		if (!entry.readOnly) continue;
		if (entry.coding !== false && !codingGateOpen(entry.coding, options)) continue;
		tools.push(buildTool(entry, cwd, resolveToolOptions(name, options)));
	}
	return tools;
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return Object.fromEntries(toolNamesInOrder().map((name) => [name, createTool(name, cwd, options)])) as Record<
		ToolName,
		Tool
	>;
}
