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
import { sliceSafe } from "../../utils/surrogate.ts";
import { getCurrentChromeDevtoolsManager } from "../chrome/chrome-devtools-manager.ts";
import type { ElementToSourceResult } from "../chrome/element-to-source.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { redactSecrets } from "../secret-redactor.ts";
import { isJsonCrushEnabled, maybeCrushJsonOutput } from "./json-crush.ts";
import { getTextOutput } from "./render-utils.ts";
import { withOutputCap } from "./tool-definition-wrapper.ts";
import { collapseRepeatedLines } from "./truncate.ts";

export interface ChromeDevtoolsToolOptions {}

export interface ChromeToolDetails {
	ok: boolean;
	error?: string;
}

type Content = TextContent | ImageContent;
// `isError` is the flag the execution pipeline (and TUI) reads to treat a result
// as a failure — mirrors how `plan`/`todo` mark their fail paths. `details.ok` is
// kept purely for structured logging; nothing keys retry/loop-detection off it.
type ChromeResult = { content: Content[]; details: ChromeToolDetails; isError?: boolean };

function ok(content: Content[]): ChromeResult {
	return { content, details: { ok: true } };
}
function fail(message: string): ChromeResult {
	return { content: [{ type: "text", text: message }], isError: true, details: { ok: false, error: message } };
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
				return fail(
					"Chrome DevTools unavailable in this session. Ensure Chrome is reachable (chromeDevtools is on by default) and retry.",
				);
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

const GET_TEXT_DEFAULT_LIMIT = 20_000;
// Dedicated output ceiling for the two big text readers (get_text and
// get_network_body), mirroring recall_tool_output's RECALL_OUTPUT_CAP_BYTES:
// page text and API bodies are exactly the outputs whose useful signal often
// exceeds the generic 64KB head-only net. Both definitions opt in via
// withOutputCap (head+tail), so the wrapper bounds their BYTES at 256KB while
// keeping head AND tail instead of head-cutting at 64KB with a second,
// contradictory truncation note.
const GET_TEXT_OUTPUT_CAP_BYTES = 256 * 1024;
// Advertised `limit` ceiling (chars), kept equal to the byte cap so the schema
// promise stays honest for ASCII-dominated text; multi-byte overflow is caught
// by the SAME dedicated 256KB head+tail cap, never by a divergent second cut.
const GET_TEXT_MAX_LIMIT = GET_TEXT_OUTPUT_CAP_BYTES;

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
const closePageSchema = Type.Object(
	{
		id: Type.Optional(
			Type.String({
				description: "Target/page id to close (from chrome_devtools_list_pages). Defaults to the selected page.",
			}),
		),
	},
	{ additionalProperties: false },
);
const evaluateSchema = Type.Object(
	{ expression: Type.String({ description: "JavaScript to evaluate in the selected page." }) },
	{ additionalProperties: false },
);
const screenshotSchema = Type.Object(
	{
		fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page (default false)." })),
		format: Type.Optional(
			Type.Union([Type.Literal("jpeg"), Type.Literal("png")], {
				description:
					"Image format. Default jpeg (compact). Use png only when you need pixel-exact / lossless detail.",
			}),
		),
		quality: Type.Optional(
			Type.Number({
				description: "JPEG quality 1-100 (default 60; ignored for png).",
				minimum: 1,
				maximum: 100,
			}),
		),
	},
	{ additionalProperties: false },
);
const consoleSchema = Type.Object(
	{
		limit: Type.Optional(Type.Number({ description: "Max lines to return (default 50)." })),
		// Free string, not a closed enum: the buffer mixes two CDP vocabularies
		// (Runtime.consoleAPICalled `type` + Log.entryAdded `level`) so the produced
		// set is open-ended (log, info, warning, error, debug, verbose, …). Matched
		// case-insensitively; document the common values instead of risking a schema
		// false-negative on a level CDP legitimately emits.
		level: Type.Optional(
			Type.String({
				description: "Filter by level (case-insensitive): error, warning, info, log, debug, verbose.",
			}),
		),
	},
	{ additionalProperties: false },
);
const networkSchema = Type.Object(
	{
		requestId: Type.Optional(
			Type.String({ description: "Return full detail for this buffered CDP request id instead of a compact list." }),
		),
		hop: Type.Optional(
			Type.Number({ description: "Redirect hop to inspect (0-based). Defaults to the latest hop.", minimum: 0 }),
		),
		includeResponseBody: Type.Optional(
			Type.Boolean({ description: "Include the bounded cached response body in detail mode (default false)." }),
		),
		limit: Type.Optional(Type.Number({ description: "Max requests to return (default 50)." })),
		urlPattern: Type.Optional(
			Type.String({ description: "Keep only requests whose URL contains this substring (case-insensitive)." }),
		),
		method: Type.Optional(Type.String({ description: "Keep only this HTTP method (GET/POST/…, case-insensitive)." })),
		type: Type.Optional(
			Type.String({
				description:
					"Keep only this resource type (case-insensitive): Document, Stylesheet, Image, Media, Font, Script, XHR, Fetch, WebSocket, Other.",
			}),
		),
		status: Type.Optional(
			Type.Union([Type.Number(), Type.String()], {
				description:
					'Keep only matching statuses: a number (404), a class ("4xx"), or a comparison (">=400", "<300").',
			}),
		),
	},
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
	{
		limit: Type.Optional(
			Type.Number({
				description: "Max characters to return (default 20000; capped at 256KB — this tool's output ceiling).",
				minimum: 1,
				maximum: GET_TEXT_MAX_LIMIT,
			}),
		),
	},
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
		limit: Type.Optional(
			Type.Number({
				description:
					"Max characters of body to return (default 20000; capped at 256KB — this tool's output ceiling).",
				minimum: 1,
				maximum: GET_TEXT_MAX_LIMIT,
			}),
		),
	},
	{ additionalProperties: false },
);

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
			"Full cycle: navigate (auto-launches Chrome) -> snapshot/get_text -> interact (click/fill/press_key) -> when the browser task is done, call chrome_devtools_close_page to close the tab, then answer the user.",
			"After loading, chrome_devtools_snapshot shows the page structure — use it to pick selectors for chrome_devtools_click / chrome_devtools_fill.",
		],
		schema: navigateSchema,
		run: async (mgr, input, signal) => {
			const r = await mgr.navigate({ url: input.url, newTab: input.newTab }, signal);
			return textResult(`${r.created ? "Opened new tab" : "Navigated"} → ${r.target.url || input.url}`);
		},
	});
}

export function createChromeClosePageDefinition(): ToolDefinition<typeof closePageSchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_close_page",
		activity: "action",
		description:
			"Close a Chrome tab/page (the selected one by default, or a given id). Use to finish a browser task and return to a clean state.",
		snippet: "Close a Chrome tab",
		guidelines: [
			"Close the tab when you are done with the browser task so tabs do not pile up, then just answer the user -- Chrome itself stays available for the next use.",
			"Omit id to close the currently selected page; pass an id from chrome_devtools_list_pages to close a specific one.",
		],
		schema: closePageSchema,
		run: async (mgr, input, signal) => {
			const r = await mgr.closePage(input.id, signal);
			return textResult(`Closed page ${r.closedId}; no page selected now -- navigate to open one.`);
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
		description:
			"Capture a screenshot of the selected page (optionally the full page). Defaults to a compact JPEG at CSS-pixel resolution; pass format:'png' (and/or a quality) for lossless/pixel-exact detail.",
		snippet: "Screenshot the page",
		guidelines: [
			"Select or navigate to a page first.",
			"Default is jpeg q60 — request format:'png' only when you truly need lossless pixels.",
		],
		schema: screenshotSchema,
		run: async (mgr, input, signal) => {
			const shot = await mgr.screenshot(
				{ fullPage: input.fullPage, format: input.format, quality: input.quality },
				signal,
			);
			const scope = input.fullPage ? "full page" : "viewport";
			const text = `Screenshot captured (${scope}).${shot.note ? ` ${shot.note}` : ""}`;
			return ok([
				{ type: "image", data: shot.data, mimeType: shot.mimeType },
				{ type: "text", text },
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
			// CDP stores levels lowercase; normalize the filter so 'Error'/'WARNING'
			// match instead of silently returning zero lines (the manager compares
			// with a strict `===`).
			const level = input.level?.toLowerCase();
			const lines = mgr.readConsole({ limit: input.limit, level });
			if (lines.length === 0) return textResult("No console messages.");
			return textResult(lines.map((l) => `[${l.level}] ${l.text}`).join("\n"));
		},
	});
}

export function createChromeReadNetworkDefinition(): ToolDefinition<typeof networkSchema, ChromeToolDetails> {
	return buildChromeTool({
		name: "chrome_devtools_read_network",
		activity: "navigation",
		description:
			"Read buffered network requests from the selected page, or return full redacted request/response detail for one requestId and redirect hop.",
		snippet: "Read network requests",
		guidelines: [
			"List mode shows entry id, status, method, url, resource type and mime. Pass requestId (and optional hop) for headers, body, timing, initiator and redirect metadata.",
			'Filter to find the real call fast, e.g. type:"XHR" or type:"Fetch" for API calls, urlPattern:"/api", or status:">=400" for failures.',
		],
		schema: networkSchema,
		run: async (mgr, input) => {
			if (input.requestId) {
				const entry = mgr.getNetworkEntry(input.requestId, input.hop);
				const detail = input.includeResponseBody ? entry : { ...entry, responseBody: undefined };
				return textResult(redactSecrets(JSON.stringify(detail, null, 2)).redacted);
			}
			const entries = mgr.readNetwork({
				limit: input.limit,
				urlPattern: input.urlPattern,
				method: input.method,
				type: input.type,
				status: input.status,
			});
			if (entries.length === 0) return textResult("No network requests.");
			return textResult(
				entries
					.map((e) => {
						const type = e.resourceType ? `  ${e.resourceType}` : "";
						const mime = e.mimeType ? `  ${e.mimeType}` : "";
						return `[${e.entryId}]  ${e.status ?? "..."}  ${e.method}  ${e.url}${type}${mime}`;
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
	// Dedicated 256KB head+tail output cap (same opt-in mechanism as
	// recall_tool_output) so the advertised GET_TEXT_MAX_LIMIT is backed by the
	// wrapper instead of being silently re-cut by the generic 64KB head-only net.
	return withOutputCap(
		buildChromeTool({
			name: "chrome_devtools_get_text",
			activity: "navigation",
			description: "Read the visible text of the selected page (cheaper than a screenshot for content checks).",
			snippet: "Read the page text",
			guidelines: ["Prefer this over screenshot when you only need the text content."],
			schema: getTextSchema,
			run: async (mgr, input, signal) => {
				// N2: collapse repeated consecutive lines (duplicated nav/sidebar/footer
				// rows, list boilerplate) BEFORE the limit/cap, so the char budget is
				// spent on content instead of chrome. Upgrade-only: page text with no
				// repeated run is byte-identical (fast path returns the original), and the
				// fuzzy `×N similar` collapse (masked numeric/hex tokens) rides along for
				// free. Applied before the byte cap too, so a huge boilerplate-heavy page
				// keeps more real signal under the same 256KB head+tail ceiling.
				const text = collapseRepeatedLines(await mgr.getPageText(signal));
				const limit = Math.max(1, Math.min(GET_TEXT_MAX_LIMIT, input.limit ?? GET_TEXT_DEFAULT_LIMIT));
				if (text.length <= limit) return textResult(text);
				return textResult(
					`${sliceSafe(text, 0, limit)}\n… [truncated ${text.length - limit} of ${text.length} chars]`,
				);
			},
		}),
		{ maxBytes: GET_TEXT_OUTPUT_CAP_BYTES, mode: "headTail" },
	);
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
	// Shares get_text's dedicated 256KB head+tail cap: it advertises the same
	// GET_TEXT_MAX_LIMIT, so it must be backed by the same wrapper ceiling.
	return withOutputCap(
		buildChromeTool({
			name: "chrome_devtools_get_network_body",
			activity: "navigation",
			description:
				"Fetch the response body of a request listed by chrome_devtools_read_network. Text/JSON/XML bodies are captured when the request finishes, so they stay readable for the page's lifetime even after Chrome would have evicted them.",
			snippet: "Read a network response body",
			guidelines: [
				"Get the requestId from chrome_devtools_read_network first.",
				"Binary, oversized, or script/style bodies are not cached and fall back to a live fetch — which can fail if Chrome already evicted them.",
			],
			schema: networkBodySchema,
			run: async (mgr, input, signal) => {
				const r = await mgr.getResponseBody(input.requestId, signal);
				if (r.base64Encoded) {
					return textResult(`(binary body, ${r.body.length} base64 chars — not shown)`);
				}
				const limit = Math.max(1, Math.min(GET_TEXT_MAX_LIMIT, input.limit ?? GET_TEXT_DEFAULT_LIMIT));
				if (r.body.length <= limit) return textResult(r.body);
				// N2 note: collapseRepeatedLines is deliberately NOT applied to network
				// bodies. They are JSON API responses far more often than not, and inserting
				// a `… (×N)` marker into pretty-printed JSON breaks the parse — defeating the
				// structural crush below (which would then fall back to a blind char-cut, a
				// regression). The crush already handles repeated JSON array items
				// structurally, so line collapse offers no upgrade here.
				// Network bodies are JSON API responses far more often than not; prefer a
				// structural crush (schema + head/tail samples) over a blind char-cut.
				const crushed = maybeCrushJsonOutput({
					text: r.body,
					shouldAttempt: isJsonCrushEnabled(),
					// A larger limit is a dead end (output is capped at 256KB regardless) and
					// there is no offset param — point at extracting the one field you need.
					recoveryHint: "Body exceeds the 256KB cap; read a specific field via chrome_devtools_evaluate.",
				});
				if (crushed !== undefined) return textResult(crushed);
				return textResult(
					`${sliceSafe(r.body, 0, limit)}\n… [truncated ${r.body.length - limit} of ${r.body.length} chars]`,
				);
			},
		}),
		{ maxBytes: GET_TEXT_OUTPUT_CAP_BYTES, mode: "headTail" },
	);
}

const elementToSourceSchema = Type.Object(
	{ selector: Type.String({ description: "CSS selector of the element whose event handlers to locate." }) },
	{ additionalProperties: false },
);

function formatElementToSource(result: ElementToSourceResult): string {
	const lines: string[] = [];
	for (const listener of result.listeners) {
		const where = `${listener.source.file}:${listener.source.line}:${listener.source.column}`;
		const tag = listener.mapped ? "source" : "transpiled";
		const name = listener.name ? ` ${listener.name}` : "";
		const note = listener.note ? ` (${listener.note})` : "";
		lines.push(`${listener.type} → ${where} [${tag}]${name}${note}`);
	}
	if (result.note) lines.push(result.note);
	return lines.length > 0 ? lines.join("\n") : "(no handlers resolved)";
}

export function createChromeElementToSourceDefinition(): ToolDefinition<
	typeof elementToSourceSchema,
	ChromeToolDetails
> {
	return buildChromeTool({
		name: "chrome_devtools_element_to_source",
		activity: "navigation",
		description:
			"Map an element (CSS selector) to the source-code handler(s) bound to it: resolves each event listener to file:line in the ORIGINAL source via CDP getEventListeners + source maps. Degrades to the transpiled position when no dev source map exists.",
		snippet: "Locate an element's handler in source",
		guidelines: [
			"Use after a click/interaction to find WHERE a handler lives instead of grepping.",
			"Pass a specific selector (e.g. '#submit', 'button.save'); the first match is used.",
			"mapped:false means no source map was available — the position is the transpiled bundle.",
		],
		schema: elementToSourceSchema,
		run: async (mgr, input, signal) => {
			return textResult(formatElementToSource(await mgr.elementToSource(input.selector, signal)));
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
export const createChromeClosePageToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeClosePageDefinition();
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
export const createChromeElementToSourceToolDefinition = (_cwd: string, _o?: ChromeDevtoolsToolOptions) =>
	createChromeElementToSourceDefinition();
