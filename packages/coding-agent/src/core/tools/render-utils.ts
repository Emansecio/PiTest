import * as os from "node:os";
import type { ImageContent, TextContent } from "@pit/ai";
import { getCapabilities, getImageDimensions, imageFallback, Text } from "@pit/tui";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

const IS_WINDOWS = process.platform === "win32";

/**
 * Normalize a path string for prefix comparison. On Windows the filesystem is
 * case-insensitive and forward slashes are interchangeable with backslashes,
 * so we collapse both axes before string-comparing. On POSIX we leave the
 * value untouched.
 */
function normalizeForCompare(p: string): string {
	if (!IS_WINDOWS) return p;
	return p.replace(/\//g, "\\").toLowerCase();
}

/**
 * True iff `p` is `prefix` itself or starts with `prefix` followed by a path
 * separator. Avoids the classic `C:\Users\User` vs `C:\Users\Userino` false
 * positive that bare `startsWith` produces.
 */
function hasPathPrefix(p: string, prefix: string): boolean {
	if (prefix.length === 0 || p.length < prefix.length) return false;
	const pNorm = normalizeForCompare(p);
	const prefixNorm = normalizeForCompare(prefix);
	if (!pNorm.startsWith(prefixNorm)) return false;
	if (pNorm.length === prefixNorm.length) return true;
	const next = pNorm[prefixNorm.length];
	return next === "/" || next === "\\";
}

/**
 * Tilde- or cwd-relative-render an absolute filesystem path for tool titles.
 *
 * Home prefix wins over `cwd` because `~` is recognizable anywhere on the
 * screen while `./` is contextual to wherever pit happens to be running.
 * Comparison is Windows-aware (separator-agnostic and case-insensitive)
 * because LLM tool-callers routinely emit forward slashes and lowercase
 * drive letters on Windows, which the previous implementation silently
 * failed to shorten.
 *
 * The output preserves whatever separator style the caller passed in — we
 * only slice, never rewrite, so a Unix-flavored Windows path stays
 * Unix-flavored.
 */
export function shortenPath(rawPath: unknown, cwd?: string): string {
	if (typeof rawPath !== "string") return "";
	const home = os.homedir();
	if (hasPathPrefix(rawPath, home)) {
		const rest = rawPath.slice(home.length);
		return rest ? `~${rest}` : "~";
	}
	if (cwd && hasPathPrefix(rawPath, cwd)) {
		const rest = rawPath.slice(cwd.length).replace(/^[/\\]+/, "");
		return rest || ".";
	}
	return rawPath;
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

type PathArgs = {
	path?: unknown;
	file_path?: unknown;
	filepath?: unknown;
	filename?: unknown;
	file?: unknown;
};

/**
 * Resolve the path argument for a tool-call DISPLAY using the same precedence
 * the path-bearing tools apply at EXECUTION time: the canonical `path` wins over
 * the aliases (`file_path`/`filepath`/`filename`/`file`) — see PATH_KEY_ALIASES
 * in argument-prep.ts and the read-guard's extractPathArg, both path-first.
 *
 * Renderers run on the RAW tool_call args (before prepareArguments normalizes
 * aliases), so each one must reproduce that precedence itself. Routing every
 * renderer through this keeps the rendered file in sync with the file the tool
 * actually operates on: a call carrying both `path` and `file_path` is never
 * labeled with the one execution discards. Returns "" for missing args and null
 * for a present-but-non-string value (rendered as "[invalid arg]"), matching str.
 */
export function getFilePathArg(args: PathArgs | undefined): string | null {
	return str(args?.path ?? args?.file_path ?? args?.filepath ?? args?.filename ?? args?.file);
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Drop trailing all-empty lines from a rendered line array so a file/content
 * preview doesn't show a tail of blank rows (e.g. a file ending in a newline
 * splits to a final ""). Shared by the read and write result renderers.
 */
export function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

	const caps = getCapabilities();
	if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
		const imageIndicators = imageBlocks
			.map((img) => {
				const mimeType = img.mimeType ?? "image/unknown";
				const dims =
					img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				return imageFallback(mimeType, dims);
			})
			.join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

export function invalidArgText(theme: { fg: (name: any, text: string) => string }): string {
	return theme.fg("error", "[invalid arg]");
}

export function nonEmptyDetails<T extends object>(d: T): T | undefined {
	return Object.keys(d).length > 0 ? d : undefined;
}

/**
 * Reuse the previously-rendered Text component for this tool row when present,
 * otherwise allocate a fresh empty one. Every tool whose result render is a
 * single Text node threads its component through `context.lastComponent`; this
 * centralizes that `(lastComponent as Text) ?? new Text(...)` idiom.
 */
export function reuseText(context: { lastComponent?: unknown }): Text {
	return (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
}

/**
 * Default tool-result renderer: dump the (trimmed) textual output into a single
 * Text node, prefixed with a blank line so the result detaches from the call
 * title, and render nothing when there is no output. This is the byte-identical
 * body that the hindsight, plan-adjacent, and utility tools all repeated inline
 * (reflect/recall/retain/resolve/eval/search_tool_bm25/recipe/inspect_image/
 * render_mermaid/recall_tool_output/goal_complete/forget). Tools whose body
 * differs (no leading newline, custom prefix, error-only) keep their own.
 *
 * Signature mirrors ToolDefinition.renderResult — (result, options, theme,
 * context) — so it drops straight into `renderResult: renderToolOutput`. The
 * `options` slot is unused. Loosely typed because it is shared across tools with
 * distinct param/detail schemas; only `content`, `showImages`, `lastComponent`,
 * and `theme.fg` are touched.
 */
export function renderToolOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> },
	_options: unknown,
	theme: { fg: (name: any, text: string) => string },
	context: { lastComponent?: unknown; showImages: boolean },
): Text {
	const text = reuseText(context);
	const output = getTextOutput(result, context.showImages).trim();
	text.setText(output ? `\n${theme.fg("toolOutput", output)}` : "");
	return text;
}
