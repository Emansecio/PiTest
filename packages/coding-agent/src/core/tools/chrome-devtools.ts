/**
 * `chrome_devtools_*` tools — control a running Chrome via the Chrome DevTools
 * Protocol (native, no external deps; see core/chrome/). Connects to a Chrome
 * started with --remote-debugging-port and can open a new tab. All tools degrade
 * with a clear error when Chrome is not reachable or no page is selected.
 */

import * as path from "node:path";
import type { ImageContent, TextContent } from "@pit/ai";
import { Text } from "@pit/tui";
import { type Static, type TSchema, Type } from "typebox";
import { getCurrentChromeDevtoolsManager } from "../chrome/chrome-devtools-manager.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { getTextOutput } from "./render-utils.ts";

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
	activity?: "navigation" | "action";
	description: string;
	snippet: string;
	guidelines: string[];
	schema: S;
	run: (mgr: Manager, input: Static<S>, signal: AbortSignal | undefined) => Promise<ChromeResult>;
}

function buildChromeTool<S extends TSchema>(spec: ChromeToolSpec<S>): ToolDefinition<S, ChromeToolDetails> {
	return {
		name: spec.name,
		...(spec.activity !== undefined ? { activity: spec.activity } : {}),
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
			const output = getTextOutput(result, context.showImages).trim();
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
const clickSchema = Type.Object(
	{ selector: Type.String({ description: "CSS selector of the element to click." }) },
	{ additionalProperties: false },
);
const fillSchema = Type.Object(
	{
		selector: Type.String({ description: "CSS selector of the input/textarea/contenteditable to fill." }),
		value: Type.String({ description: "Text to type. Replaces the current content." }),
	},
	{ additionalProperties: false },
);
const pressKeySchema = Type.Object(
	{
		key: Type.String({
			description:
				"Named key (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown) or a single character.",
		}),
	},
	{ additionalProperties: false },
);
const getTextSchema = Type.Object(
	{ limit: Type.Optional(Type.Number({ description: "Max characters to return (default 20000)." })) },
	{ additionalProperties: false },
);
const waitForSchema = Type.Object(
	{
		selector: Type.Optional(Type.String({ description: "CSS selector to wait for (visible)." })),
		text: Type.Optional(Type.String({ description: "Text to wait for in the page body." })),
		timeoutMs: Type.Optional(Type.Number({ description: "Max wait in ms (default 5000, cap 30000)." })),
	},
	{ additionalProperties: false },
);

const hoverSchema = Type.Object(
	{ selector: Type.String({ description: "CSS selector of the element to hover." }) },
	{ additionalProperties: false },
);
const selectOptionSchema = Type.Object(
	{
		selector: Type.String({ description: "CSS selector of the <select> element." }),
		value: Type.String({ description: "Option to select, matched by value, label or visible text." }),
	},
	{ additionalProperties: false },
);
const uploadFileSchema = Type.Object(
	{
		selector: Type.String({ description: 'CSS selector of the <input type="file"> element.' }),
		files: Type.Array(Type.String(), {
			description: "Local file paths to attach (relative paths resolve from cwd).",
		}),
	},
	{ additionalProperties: false },
);
const snapshotSchema = Type.Object(
	{
		selector: Type.Optional(
			Type.String({ description: "CSS selector to scope the snapshot to one element's subtree." }),
		),
	},
	{ additionalProperties: false },
);
const networkBodySchema = Type.Object(
	{
		requestId: Type.String({ description: "Request id from chrome_devtools_read_network." }),
		limit: Type.Optional(Type.Number({ description: "Max characters of body to return (default 20000)." })),
	},
	{ additionalProperties: false },
);

const GET_TEXT_DEFAULT_LIMIT = 20_000;

// --- Tool definitions ------------------------------------------------------

export function createChromeListPagesDefinition(): ToolDefinition<typeof emptySchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_list_pages",
		activity: "navigation",
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
			"After loading, chrome_devtools_snapshot shows the page structure — use it to pick selectors for chrome_devtools_click / chrome_devtools_fill.",
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
		activity: "navigation",
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
		activity: "navigation",
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
		activity: "navigation",
		description: "Read buffered network requests from the selected page.",
		snippet: "Read network requests",
		guidelines: ["Shows recent requests with method, url and status."],
		schema: networkSchema,
		run: async (mgr, input) => {
			const entries = mgr.readNetwork({ limit: input.limit });
			if (entries.length === 0) return textResult("No network requests.");
			return textResult(
				entries
					.map((e) => {
						const mime = e.mimeType ? `  ${e.mimeType}` : "";
						return `[${e.requestId}]  ${e.status ?? "..."}  ${e.method}  ${e.url}${mime}`;
					})
					.join("\n"),
			);
		},
	});
}

export function createChromeClickDefinition(): ToolDefinition<typeof clickSchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_click",
		activity: "action",
		description: "Click an element in the selected page by CSS selector (real mouse events).",
		snippet: "Click an element",
		guidelines: [
			"The element is scrolled into view and clicked at its center.",
			"Use chrome_devtools_snapshot (or chrome_devtools_get_text) to discover selectors first.",
		],
		schema: clickSchema,
		run: async (mgr, input, signal) => {
			await mgr.click(input.selector, signal);
			return textResult(`Clicked ${input.selector}`);
		},
	});
}

export function createChromeFillDefinition(): ToolDefinition<typeof fillSchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_fill",
		activity: "action",
		description: "Fill an input/textarea/contenteditable in the selected page (replaces current content).",
		snippet: "Fill a form field",
		guidelines: ["Focuses the element, selects existing content and types the value (input events fire normally)."],
		schema: fillSchema,
		run: async (mgr, input, signal) => {
			await mgr.fill(input.selector, input.value, signal);
			return textResult(`Filled ${input.selector}`);
		},
	});
}

export function createChromePressKeyDefinition(): ToolDefinition<typeof pressKeySchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_press_key",
		activity: "action",
		description: "Press a key on the focused element of the selected page (e.g. Enter to submit).",
		snippet: "Press a key in the page",
		guidelines: ["Focus a field first (chrome_devtools_fill or chrome_devtools_click), then press e.g. Enter."],
		schema: pressKeySchema,
		run: async (mgr, input, signal) => {
			await mgr.pressKey(input.key, signal);
			return textResult(`Pressed ${input.key}`);
		},
	});
}

export function createChromeGetTextDefinition(): ToolDefinition<typeof getTextSchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_get_text",
		activity: "navigation",
		description: "Read the visible text of the selected page (cheaper than a screenshot for content checks).",
		snippet: "Read the page text",
		guidelines: ["Prefer this over screenshot when you only need the text content."],
		schema: getTextSchema,
		run: async (mgr, input, signal) => {
			const text = await mgr.getPageText(signal);
			const limit = input.limit ?? GET_TEXT_DEFAULT_LIMIT;
			if (text.length <= limit) return textResult(text);
			return textResult(`${text.slice(0, limit)}\n… [truncated ${text.length - limit} of ${text.length} chars]`);
		},
	});
}

export function createChromeWaitForDefinition(): ToolDefinition<typeof waitForSchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_wait_for",
		activity: "navigation",
		description: "Wait until a CSS selector is visible or a text appears in the selected page.",
		snippet: "Wait for an element/text",
		guidelines: ["Use after navigate/click on dynamic pages before reading or interacting."],
		schema: waitForSchema,
		run: async (mgr, input, signal) => {
			const r = await mgr.waitFor(
				{ selector: input.selector, text: input.text, timeoutMs: input.timeoutMs },
				signal,
			);
			const what = input.selector ?? JSON.stringify(input.text);
			if (r.found) return textResult(`Found ${what} after ${r.elapsedMs}ms.`);
			return fail(`Timed out after ${r.elapsedMs}ms waiting for ${what}.`);
		},
	});
}

export function createChromeHoverDefinition(): ToolDefinition<typeof hoverSchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_hover",
		activity: "action",
		description: "Hover an element in the selected page by CSS selector (triggers mouseover/tooltips/menus).",
		snippet: "Hover an element",
		guidelines: ["Use before clicking items inside hover-only menus."],
		schema: hoverSchema,
		run: async (mgr, input, signal) => {
			await mgr.hover(input.selector, signal);
			return textResult(`Hovering ${input.selector}`);
		},
	});
}

export function createChromeSelectOptionDefinition(): ToolDefinition<typeof selectOptionSchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_select_option",
		activity: "action",
		description: "Select an option of a <select> element by value, label or visible text.",
		snippet: "Select a dropdown option",
		guidelines: ["Fires input/change events so framework bindings update."],
		schema: selectOptionSchema,
		run: async (mgr, input, signal) => {
			const r = await mgr.selectOption(input.selector, input.value, signal);
			return textResult(`Selected ${JSON.stringify(r.label || r.value)} in ${input.selector}`);
		},
	});
}

export function createChromeUploadFileDefinition(
	cwd?: string,
): ToolDefinition<typeof uploadFileSchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_upload_file",
		activity: "action",
		description: 'Attach local files to an <input type="file"> in the selected page.',
		snippet: "Upload files to a file input",
		guidelines: ["Paths are validated locally before being attached; relative paths resolve from the session cwd."],
		schema: uploadFileSchema,
		run: async (mgr, input, signal) => {
			const resolved = input.files.map((f) => path.resolve(cwd ?? process.cwd(), f));
			await mgr.uploadFile(input.selector, resolved, signal);
			return textResult(`Attached ${resolved.length} file(s) to ${input.selector}`);
		},
	});
}

export function createChromeSnapshotDefinition(): ToolDefinition<typeof snapshotSchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_snapshot",
		activity: "navigation",
		description:
			"Accessibility-tree snapshot of the selected page (roles + names, indented). Cheaper than a screenshot for understanding structure and finding targets.",
		snippet: "Snapshot the page structure",
		guidelines: [
			"Prefer this over screenshot to discover what is clickable/fillable.",
			"Pass selector to scope a big page down to one region (e.g. 'form', '#main').",
		],
		schema: snapshotSchema,
		run: async (mgr, input, signal) => {
			return textResult(await mgr.a11ySnapshot(input.selector, signal));
		},
	});
}

export function createChromeGetNetworkBodyDefinition(): ToolDefinition<typeof networkBodySchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_get_network_body",
		activity: "navigation",
		description: "Fetch the response body of a request listed by chrome_devtools_read_network.",
		snippet: "Read a network response body",
		guidelines: ["Get the requestId from chrome_devtools_read_network first."],
		schema: networkBodySchema,
		run: async (mgr, input, signal) => {
			const r = await mgr.getResponseBody(input.requestId, signal);
			if (r.base64Encoded) {
				return textResult(`(binary body, ${r.body.length} base64 chars — not shown)`);
			}
			const limit = input.limit ?? GET_TEXT_DEFAULT_LIMIT;
			if (r.body.length <= limit) return textResult(r.body);
			return textResult(
				`${r.body.slice(0, limit)}\n… [truncated ${r.body.length - limit} of ${r.body.length} chars]`,
			);
		},
	});
}

// Definition-factory wrappers (registry expects (cwd, options) => ToolDef).
// The registry derives each executable tool from these via wrapToolDefinition
// (see buildTool in tools/index.ts), so no per-tool `create*Tool` wrapper is needed.
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
export const createChromeClickToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeClickDefinition();
export const createChromeFillToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeFillDefinition();
export const createChromePressKeyToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromePressKeyDefinition();
export const createChromeGetTextToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeGetTextDefinition();
export const createChromeWaitForToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeWaitForDefinition();
export const createChromeHoverToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeHoverDefinition();
export const createChromeSelectOptionToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeSelectOptionDefinition();
export const createChromeUploadFileToolDefinition = (cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeUploadFileDefinition(cwd);
export const createChromeSnapshotToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeSnapshotDefinition();
export const createChromeGetNetworkBodyToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeGetNetworkBodyDefinition();
