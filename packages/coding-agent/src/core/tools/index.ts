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
import { type AskToolOptions, createAskTool, createAskToolDefinition } from "./ask.ts";
import { type AstEditToolOptions, createAstEditTool, createAstEditToolDefinition } from "./ast-edit.ts";
import { type AstGrepToolOptions, createAstGrepTool, createAstGrepToolDefinition } from "./ast-grep.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { type CalcToolOptions, createCalcTool, createCalcToolDefinition } from "./calc.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import {
	createEditHashlineTool,
	createEditHashlineToolDefinition,
	type EditHashlineToolOptions,
} from "./edit-hashline.ts";
import { createEvalTool, createEvalToolDefinition, type EvalToolOptions } from "./eval.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createForgetTool, createForgetToolDefinition, type ForgetToolOptions } from "./forget.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import {
	createInspectImageTool,
	createInspectImageToolDefinition,
	type InspectImageToolOptions,
} from "./inspect-image.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createRecallTool, createRecallToolDefinition, type RecallToolOptions } from "./recall.ts";
import { createRecipeTool, createRecipeToolDefinition, type RecipeToolOptions } from "./recipe.ts";
import { createReflectTool, createReflectToolDefinition, type ReflectToolOptions } from "./reflect.ts";
import {
	createRenderMermaidTool,
	createRenderMermaidToolDefinition,
	type RenderMermaidToolOptions,
} from "./render-mermaid.ts";
import { createResolveTool, createResolveToolDefinition, type ResolveToolOptions } from "./resolve.ts";
import { createRetainTool, createRetainToolDefinition, type RetainToolOptions } from "./retain.ts";
import {
	createSearchToolBm25Definition,
	createSearchToolBm25Tool,
	type SearchToolBm25Options,
} from "./search-tool-bm25.ts";
import { createSymbolTool, createSymbolToolDefinition, type SymbolToolOptions } from "./symbol.ts";
import { createWebSearchTool, createWebSearchToolDefinition, type WebSearchToolOptions } from "./web-search.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "edit"
	| "edit_v2"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "symbol"
	| "ask"
	| "resolve"
	| "search_tool_bm25"
	| "ast_grep"
	| "ast_edit"
	| "web_search"
	| "eval"
	| "retain"
	| "recall"
	| "reflect"
	| "forget"
	| "calc"
	| "recipe"
	| "inspect_image"
	| "render_mermaid";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"edit",
	"edit_v2",
	"write",
	"grep",
	"find",
	"ls",
	"symbol",
	"ask",
	"resolve",
	"search_tool_bm25",
	"ast_grep",
	"ast_edit",
	"web_search",
	"eval",
	"retain",
	"recall",
	"reflect",
	"forget",
	"calc",
	"recipe",
	"inspect_image",
	"render_mermaid",
]);

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
	hindsight?: { enabled?: boolean };
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "edit_v2":
			return createEditHashlineToolDefinition(cwd, options?.edit_v2);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "symbol":
			return createSymbolToolDefinition(cwd, options?.symbol);
		case "ask":
			return createAskToolDefinition(cwd, options?.ask);
		case "resolve":
			return createResolveToolDefinition(cwd, options?.resolve);
		case "search_tool_bm25":
			return createSearchToolBm25Definition(cwd, options?.searchToolBm25);
		case "ast_grep":
			return createAstGrepToolDefinition(cwd, options?.ast_grep);
		case "ast_edit":
			return createAstEditToolDefinition(cwd, options?.ast_edit);
		case "web_search":
			return createWebSearchToolDefinition(cwd, options?.web_search);
		case "eval":
			return createEvalToolDefinition(cwd, options?.eval);
		case "retain":
			return createRetainToolDefinition(cwd, options?.retain);
		case "recall":
			return createRecallToolDefinition(cwd, options?.recall);
		case "reflect":
			return createReflectToolDefinition(cwd, options?.reflect);
		case "forget":
			return createForgetToolDefinition(cwd, options?.forget);
		case "calc":
			return createCalcToolDefinition(cwd, options?.calc);
		case "recipe":
			return createRecipeToolDefinition(cwd, options?.recipe);
		case "inspect_image":
			return createInspectImageToolDefinition(cwd, options?.inspect_image);
		case "render_mermaid":
			return createRenderMermaidToolDefinition(cwd, options?.render_mermaid);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "edit_v2":
			return createEditHashlineTool(cwd, options?.edit_v2);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "symbol":
			return createSymbolTool(cwd, options?.symbol);
		case "ask":
			return createAskTool(cwd, options?.ask);
		case "resolve":
			return createResolveTool(cwd, options?.resolve);
		case "search_tool_bm25":
			return createSearchToolBm25Tool(cwd, options?.searchToolBm25);
		case "ast_grep":
			return createAstGrepTool(cwd, options?.ast_grep);
		case "ast_edit":
			return createAstEditTool(cwd, options?.ast_edit);
		case "web_search":
			return createWebSearchTool(cwd, options?.web_search);
		case "eval":
			return createEvalTool(cwd, options?.eval);
		case "retain":
			return createRetainTool(cwd, options?.retain);
		case "recall":
			return createRecallTool(cwd, options?.recall);
		case "reflect":
			return createReflectTool(cwd, options?.reflect);
		case "forget":
			return createForgetTool(cwd, options?.forget);
		case "calc":
			return createCalcTool(cwd, options?.calc);
		case "recipe":
			return createRecipeTool(cwd, options?.recipe);
		case "inspect_image":
			return createInspectImageTool(cwd, options?.inspect_image);
		case "render_mermaid":
			return createRenderMermaidTool(cwd, options?.render_mermaid);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	const tools: ToolDef[] = [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createEditHashlineToolDefinition(cwd, options?.edit_v2),
		createWriteToolDefinition(cwd, options?.write),
		createSymbolToolDefinition(cwd, options?.symbol),
		createAskToolDefinition(cwd, options?.ask),
		createResolveToolDefinition(cwd, options?.resolve),
		createSearchToolBm25Definition(cwd, options?.searchToolBm25),
		createAstGrepToolDefinition(cwd, options?.ast_grep),
		createAstEditToolDefinition(cwd, options?.ast_edit),
	];
	if (options?.webSearch?.enabled) {
		tools.push(
			createWebSearchToolDefinition(cwd, {
				...(options?.web_search ?? {}),
				defaultProvider: options?.web_search?.defaultProvider ?? options?.webSearch?.defaultProvider,
			}),
		);
	}
	if (options?.eval?.enabled) {
		tools.push(createEvalToolDefinition(cwd, options?.eval));
	}
	if (options?.hindsight?.enabled) {
		tools.push(
			createRetainToolDefinition(cwd, options?.retain),
			createRecallToolDefinition(cwd, options?.recall),
			createReflectToolDefinition(cwd, options?.reflect),
			createForgetToolDefinition(cwd, options?.forget),
		);
	}
	// Default-on native tools (no settings.json flag required).
	tools.push(
		createCalcToolDefinition(cwd, options?.calc),
		createRecipeToolDefinition(cwd, options?.recipe),
		createInspectImageToolDefinition(cwd, options?.inspect_image),
		createRenderMermaidToolDefinition(cwd, options?.render_mermaid),
	);
	return tools;
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
		createSymbolToolDefinition(cwd, options?.symbol),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd, options?.edit),
		edit_v2: createEditHashlineToolDefinition(cwd, options?.edit_v2),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		symbol: createSymbolToolDefinition(cwd, options?.symbol),
		ask: createAskToolDefinition(cwd, options?.ask),
		resolve: createResolveToolDefinition(cwd, options?.resolve),
		search_tool_bm25: createSearchToolBm25Definition(cwd, options?.searchToolBm25),
		ast_grep: createAstGrepToolDefinition(cwd, options?.ast_grep),
		ast_edit: createAstEditToolDefinition(cwd, options?.ast_edit),
		web_search: createWebSearchToolDefinition(cwd, options?.web_search),
		eval: createEvalToolDefinition(cwd, options?.eval),
		retain: createRetainToolDefinition(cwd, options?.retain),
		recall: createRecallToolDefinition(cwd, options?.recall),
		reflect: createReflectToolDefinition(cwd, options?.reflect),
		forget: createForgetToolDefinition(cwd, options?.forget),
		calc: createCalcToolDefinition(cwd, options?.calc),
		recipe: createRecipeToolDefinition(cwd, options?.recipe),
		inspect_image: createInspectImageToolDefinition(cwd, options?.inspect_image),
		render_mermaid: createRenderMermaidToolDefinition(cwd, options?.render_mermaid),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	const tools: Tool[] = [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createEditHashlineTool(cwd, options?.edit_v2),
		createWriteTool(cwd, options?.write),
		createSymbolTool(cwd, options?.symbol),
		createAskTool(cwd, options?.ask),
		createResolveTool(cwd, options?.resolve),
		createSearchToolBm25Tool(cwd, options?.searchToolBm25),
		createAstGrepTool(cwd, options?.ast_grep),
		createAstEditTool(cwd, options?.ast_edit),
	];
	if (options?.webSearch?.enabled) {
		tools.push(
			createWebSearchTool(cwd, {
				...(options?.web_search ?? {}),
				defaultProvider: options?.web_search?.defaultProvider ?? options?.webSearch?.defaultProvider,
			}),
		);
	}
	if (options?.eval?.enabled) {
		tools.push(createEvalTool(cwd, options?.eval));
	}
	if (options?.hindsight?.enabled) {
		tools.push(
			createRetainTool(cwd, options?.retain),
			createRecallTool(cwd, options?.recall),
			createReflectTool(cwd, options?.reflect),
			createForgetTool(cwd, options?.forget),
		);
	}
	// Default-on native tools (no settings.json flag required).
	tools.push(
		createCalcTool(cwd, options?.calc),
		createRecipeTool(cwd, options?.recipe),
		createInspectImageTool(cwd, options?.inspect_image),
		createRenderMermaidTool(cwd, options?.render_mermaid),
	);
	return tools;
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
		createSymbolTool(cwd, options?.symbol),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, options?.edit),
		edit_v2: createEditHashlineTool(cwd, options?.edit_v2),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		symbol: createSymbolTool(cwd, options?.symbol),
		ask: createAskTool(cwd, options?.ask),
		resolve: createResolveTool(cwd, options?.resolve),
		search_tool_bm25: createSearchToolBm25Tool(cwd, options?.searchToolBm25),
		ast_grep: createAstGrepTool(cwd, options?.ast_grep),
		ast_edit: createAstEditTool(cwd, options?.ast_edit),
		web_search: createWebSearchTool(cwd, options?.web_search),
		eval: createEvalTool(cwd, options?.eval),
		retain: createRetainTool(cwd, options?.retain),
		recall: createRecallTool(cwd, options?.recall),
		reflect: createReflectTool(cwd, options?.reflect),
		forget: createForgetTool(cwd, options?.forget),
		calc: createCalcTool(cwd, options?.calc),
		recipe: createRecipeTool(cwd, options?.recipe),
		inspect_image: createInspectImageTool(cwd, options?.inspect_image),
		render_mermaid: createRenderMermaidTool(cwd, options?.render_mermaid),
	};
}
