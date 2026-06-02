/**
 * `chrome_devtools_*` tools — control a running Chrome via the Chrome DevTools
 * Protocol (native, no external deps; see core/chrome/). Connects to a Chrome
 * started with --remote-debugging-port and can open a new tab. All tools degrade
 * with a clear error when Chrome is not reachable or no page is selected.
 */

import type { AgentTool } from "@pit/agent-core";
import type { ImageContent, TextContent } from "@pit/ai";
import { Text } from "@pit/tui";
import { type Static, type TSchema, Type } from "typebox";
import { getCurrentChromeDevtoolsManager } from "../chrome/chrome-devtools-manager.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { getTextOutput } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export interface ChromeDevtoolsToolOptions {}

export interface ChromeToolDetails {
	ok: boolean;
	error?: string;
}

type Content = TextContent | ImageContent;
type ChromeResult = { content: Content[]; details: ChromeToolDetails };

function ok(content: Content[]): ChromeResult {
	return { content, details: { ok: true } };
}
function fail(message: string): ChromeResult {
	return { content: [{ type: "text", text: message }], details: { ok: false, error: message } };
}
function textResult(text: string): ChromeResult {
	return ok([{ type: "text", text: text || "(empty)" }]);
}

type Manager = NonNullable<ReturnType<typeof getCurrentChromeDevtoolsManager>>;

interface ChromeToolSpec<S extends TSchema> {
	name: string;
	description: string;
	snippet: string;
	guidelines: string[];
	schema: S;
	run: (mgr: Manager, input: Static<S>, signal: AbortSignal | undefined) => Promise<ChromeResult>;
}

function buildChromeTool<S extends TSchema>(spec: ChromeToolSpec<S>): ToolDefinition<S, ChromeToolDetails> {
	return {
		name: spec.name,
		label: spec.name,
		description: spec.description,
		promptSnippet: spec.snippet,
		promptGuidelines: spec.guidelines,
		parameters: spec.schema,
		async execute(_toolCallId: string, input: Static<S>, signal: AbortSignal | undefined) {
			const mgr = getCurrentChromeDevtoolsManager();
			if (!mgr) {
				return fail("Chrome DevTools is not enabled. Enable it in settings (chromeDevtools.enabled).");
			}
			try {
				return await spec.run(mgr, input, signal);
			} catch (err) {
				return fail((err as Error).message);
			}
		},
		renderCall(_args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold(spec.name)));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result as any, context.showImages).trim();
			text.setText(output ? `${theme.fg("toolOutput", output)}` : "");
			return text;
		},
	};
}

// --- Schemas ---------------------------------------------------------------

const emptySchema = Type.Object({}, { additionalProperties: false });
const selectSchema = Type.Object(
	{ id: Type.String({ description: "Target/page id from chrome_devtools_list_pages." }) },
	{ additionalProperties: false },
);
const navigateSchema = Type.Object(
	{
		url: Type.String({ description: "URL to open." }),
		newTab: Type.Optional(Type.Boolean({ description: "Open a new tab (default true when no page is selected)." })),
	},
	{ additionalProperties: false },
);
const evaluateSchema = Type.Object(
	{ expression: Type.String({ description: "JavaScript to evaluate in the selected page." }) },
	{ additionalProperties: false },
);
const screenshotSchema = Type.Object(
	{ fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page (default false)." })) },
	{ additionalProperties: false },
);
const consoleSchema = Type.Object(
	{
		limit: Type.Optional(Type.Number({ description: "Max lines to return (default 50)." })),
		level: Type.Optional(Type.String({ description: "Filter by level, e.g. 'error', 'warning', 'log'." })),
	},
	{ additionalProperties: false },
);
const networkSchema = Type.Object(
	{ limit: Type.Optional(Type.Number({ description: "Max requests to return (default 50)." })) },
	{ additionalProperties: false },
);

// --- Tool definitions ------------------------------------------------------

export function createChromeListPagesDefinition(): ToolDefinition<typeof emptySchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_list_pages",
		description: "List the inspectable Chrome tabs/pages (id, title, url).",
		snippet: "List open Chrome tabs",
		guidelines: ["Use to find a page id before chrome_devtools_select_page."],
		schema: emptySchema,
		run: async (mgr, _input, signal) => {
			const pages = await mgr.listPages(signal);
			if (pages.length === 0) return textResult("No open pages.");
			return textResult(pages.map((p) => `${p.id}  ${p.title || "(untitled)"}  —  ${p.url}`).join("\n"));
		},
	});
}

export function createChromeSelectPageDefinition(): ToolDefinition<typeof selectSchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_select_page",
		description: "Select the active page for subsequent chrome_devtools operations.",
		snippet: "Select the active Chrome page",
		guidelines: ["Pass an id from chrome_devtools_list_pages."],
		schema: selectSchema,
		run: async (mgr, input, signal) => {
			const t = await mgr.selectPage(input.id, signal);
			return textResult(`Selected ${t.id}: ${t.title || t.url}`);
		},
	});
}

export function createChromeNavigateDefinition(): ToolDefinition<typeof navigateSchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_navigate",
		description:
			"Navigate to a URL. Auto-starts Chrome if needed (no manual setup) and opens a new tab when newTab is set or no page is selected.",
		snippet: "Open a URL in Chrome (new tab)",
		guidelines: [
			"Just call this to use the browser — Chrome is launched automatically if it isn't already running.",
			"Set newTab to open a fresh tab instead of reusing the selected page.",
		],
		schema: navigateSchema,
		run: async (mgr, input, signal) => {
			const r = await mgr.navigate({ url: input.url, newTab: input.newTab }, signal);
			return textResult(`${r.created ? "Opened new tab" : "Navigated"} → ${r.target.url || input.url}`);
		},
	});
}

export function createChromeEvaluateDefinition(): ToolDefinition<typeof evaluateSchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_evaluate",
		description: "Evaluate JavaScript in the selected page and return the result.",
		snippet: "Evaluate JS in the page",
		guidelines: ["The expression runs in the page; the last value is returned (await is supported)."],
		schema: evaluateSchema,
		run: async (mgr, input, signal) => {
			const r = await mgr.evaluate(input.expression, signal);
			if (r.error) return textResult(`Error: ${r.error}`);
			const out = r.value !== undefined ? JSON.stringify(r.value) : (r.description ?? "undefined");
			return textResult(out);
		},
	});
}

export function createChromeScreenshotDefinition(): ToolDefinition<typeof screenshotSchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_screenshot",
		description: "Capture a PNG screenshot of the selected page (optionally the full page).",
		snippet: "Screenshot the page",
		guidelines: ["Select or navigate to a page first."],
		schema: screenshotSchema,
		run: async (mgr, input, signal) => {
			const data = await mgr.screenshot({ fullPage: input.fullPage }, signal);
			return ok([
				{ type: "image", data, mimeType: "image/png" },
				{ type: "text", text: `Screenshot captured (${input.fullPage ? "full page" : "viewport"}).` },
			]);
		},
	});
}

export function createChromeReadConsoleDefinition(): ToolDefinition<typeof consoleSchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_read_console",
		description: "Read buffered console messages from the selected page.",
		snippet: "Read the page console",
		guidelines: ["Filter by level (e.g. 'error') to focus on problems."],
		schema: consoleSchema,
		run: async (mgr, input) => {
			const lines = mgr.readConsole({ limit: input.limit, level: input.level });
			if (lines.length === 0) return textResult("No console messages.");
			return textResult(lines.map((l) => `[${l.level}] ${l.text}`).join("\n"));
		},
	});
}

export function createChromeReadNetworkDefinition(): ToolDefinition<typeof networkSchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_read_network",
		description: "Read buffered network requests from the selected page.",
		snippet: "Read network requests",
		guidelines: ["Shows recent requests with method, url and status."],
		schema: networkSchema,
		run: async (mgr, input) => {
			const entries = mgr.readNetwork({ limit: input.limit });
			if (entries.length === 0) return textResult("No network requests.");
			return textResult(entries.map((e) => `${e.status ?? "..."}  ${e.method}  ${e.url}`).join("\n"));
		},
	});
}

// Factory wrappers for the tool registry.
export const createChromeListPagesTool = (
	_cwd: string,
	_o?: ChromeDevtoolsToolOptions,
): AgentTool<typeof emptySchema> => wrapToolDefinition(createChromeListPagesDefinition());
export const createChromeSelectPageTool = (
	_cwd: string,
	_o?: ChromeDevtoolsToolOptions,
): AgentTool<typeof selectSchema> => wrapToolDefinition(createChromeSelectPageDefinition());
export const createChromeNavigateTool = (
	_cwd: string,
	_o?: ChromeDevtoolsToolOptions,
): AgentTool<typeof navigateSchema> => wrapToolDefinition(createChromeNavigateDefinition());
export const createChromeEvaluateTool = (
	_cwd: string,
	_o?: ChromeDevtoolsToolOptions,
): AgentTool<typeof evaluateSchema> => wrapToolDefinition(createChromeEvaluateDefinition());
export const createChromeScreenshotTool = (
	_cwd: string,
	_o?: ChromeDevtoolsToolOptions,
): AgentTool<typeof screenshotSchema> => wrapToolDefinition(createChromeScreenshotDefinition());
export const createChromeReadConsoleTool = (
	_cwd: string,
	_o?: ChromeDevtoolsToolOptions,
): AgentTool<typeof consoleSchema> => wrapToolDefinition(createChromeReadConsoleDefinition());
export const createChromeReadNetworkTool = (
	_cwd: string,
	_o?: ChromeDevtoolsToolOptions,
): AgentTool<typeof networkSchema> => wrapToolDefinition(createChromeReadNetworkDefinition());

// Definition-factory wrappers (registry expects (cwd, options) => ToolDef).
export const createChromeListPagesToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeListPagesDefinition();
export const createChromeSelectPageToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeSelectPageDefinition();
export const createChromeNavigateToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeNavigateDefinition();
export const createChromeEvaluateToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeEvaluateDefinition();
export const createChromeScreenshotToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeScreenshotDefinition();
export const createChromeReadConsoleToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeReadConsoleDefinition();
export const createChromeReadNetworkToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeReadNetworkDefinition();
