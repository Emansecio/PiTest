import * as os from "node:os";
import { type Component, getCapabilities, getImageDimensions, imageFallback, Text, truncateToWidth } from "@pit/tui";
import { collapseAnnotatedBlocks } from "../../modes/interactive/components/annotated-block-collapse.ts";
import { expandKeyHint, moreLinesTrailer } from "../../modes/interactive/components/tool-activity.ts";
import type { ThemeColor } from "../../modes/interactive/theme/theme.ts";
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

/** Minimal theme shape every renderer in this module needs — just the
 * foreground-color helper, typed against the real `ThemeColor` union so a
 * bad color name is a compile error instead of `any`. */
export interface ToolTheme {
	fg: (name: ThemeColor, text: string) => string;
}

export function invalidArgText(theme: ToolTheme): string {
	return theme.fg("error", "[invalid arg]");
}

export function nonEmptyDetails<T extends object>(d: T): T | undefined {
	return Object.keys(d).length > 0 ? d : undefined;
}

/** Collapsed-preview line cap shared by every `renderResult: renderToolOutput`
 * tool and (via {@link buildCappedToolOutput}) the TUI's no-custom-renderer
 * result fallback in tool-execution.ts. */
export const DEFAULT_RESULT_PREVIEW_LINES = 15;

/** Optional knobs for {@link buildCappedToolOutput}'s collapsed preview. */
export interface CappedOutputOptions {
	/**
	 * Errored result: keep the TAIL of the output — the informative part of an
	 * error body (final message, exit status) is its end, not its preamble — and
	 * announce the hidden head with a leading `… +N earlier lines` trailer, the
	 * same {@link moreLinesTrailer} dialect capErrorPreview (tool-activity.ts)
	 * uses. Normal output keeps the HEAD (scanning a preview top-down is how you
	 * decide whether to expand), with the trailing `… +N more lines` trailer.
	 */
	isError?: boolean;
	/**
	 * Render width (cells). When present, the cap counts VISUAL lines (after
	 * wrap), reusing bash-execution.ts's truncateToVisualLines idiom: a single
	 * 2000-char logical line wraps to dozens of terminal rows, so a logical-line
	 * cap is no cap at all. When absent (callers without a width at build time —
	 * tool-execution.ts's string fallback), the cap degrades to logical lines,
	 * which can still over-show on pathologically long lines.
	 */
	width?: number;
}

/**
 * Collapse raw tool-result text to a bounded preview unless `expanded`,
 * folding consecutive `[hint]`/`[repair]` lines and appending the standard
 * "N more lines (expand)" trailer when content is hidden. Returns null for
 * empty output (callers render nothing in that case).
 *
 * This is the logic tool-execution.ts's no-custom-renderer fallback already
 * used (`ToolExecutionComponent.buildCappedOutput`) — extracted here so every
 * `renderResult: renderToolOutput` tool gets the same collapsed-by-default
 * safety net instead of dumping full output regardless of `options.expanded`.
 * See {@link CappedOutputOptions} for the visual-line cap and error-tail modes;
 * without `opts` the behavior is byte-identical to the historical head +
 * logical-line cap, which keeps the untouched tool-execution.ts caller stable.
 *
 * Boundary note: the activity stream's error auto-preview (activity-line.ts)
 * calls setResultExpanded(true) BEFORE rendering and then caps the EXPANDED
 * body with capErrorPreview — so it always reaches this function with
 * `expanded === true` (full output, no cap here) and there is no double-cap.
 */
export function buildCappedToolOutput(
	rawOutput: string,
	expanded: boolean,
	theme: ToolTheme,
	previewLines: number = DEFAULT_RESULT_PREVIEW_LINES,
	opts: CappedOutputOptions = {},
): string | null {
	const output = rawOutput.trim();
	if (!output) return null;
	if (expanded) {
		return output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");
	}
	const displayOutput = collapseAnnotatedBlocks(output, {
		expanded: false,
		muted: (s) => theme.fg("muted", s),
		expandHint: expandKeyHint(),
	});
	const styledLines = displayOutput.split("\n").map((line) => theme.fg("toolOutput", line));
	const isError = opts.isError ?? false;

	if (opts.width === undefined) {
		// Logical-line cap (no width known at build time). Head + trailing trailer
		// for normal output — byte-identical to the historical behavior relied on
		// by tool-execution.ts; tail + leading trailer for errors.
		if (styledLines.length <= previewLines) return styledLines.join("\n");
		const hidden = styledLines.length - previewLines;
		if (isError) {
			return [moreLinesTrailer(hidden, expandKeyHint(), "earlier lines"), ...styledLines.slice(-previewLines)].join(
				"\n",
			);
		}
		return [...styledLines.slice(0, previewLines), moreLinesTrailer(hidden, expandKeyHint())].join("\n");
	}

	// Visual-line cap: wrap the styled text exactly as the Text component will
	// (same idiom as bash-execution.ts's truncateToVisualLines + slice), then
	// keep head or tail of the VISUAL rows. The trailer is width-clamped so it
	// can never wrap into a second row and break the budget.
	const width = Math.max(1, Math.floor(opts.width));
	const visual = new Text(styledLines.join("\n"), 0, 0).render(width);
	if (visual.length <= previewLines) return visual.join("\n");
	const hidden = visual.length - previewLines;
	if (isError) {
		return [
			truncateToWidth(moreLinesTrailer(hidden, expandKeyHint(), "earlier lines"), width),
			...visual.slice(-previewLines),
		].join("\n");
	}
	return [...visual.slice(0, previewLines), truncateToWidth(moreLinesTrailer(hidden, expandKeyHint()), width)].join(
		"\n",
	);
}

/**
 * Width-aware body component for the default tool-result renderer. A plain
 * `Text` caps at BUILD time (no width), so its logical-line cap dissolves the
 * moment a long line wraps; this component defers the cap to render(width),
 * where the visual-line budget of {@link buildCappedToolOutput} is exact.
 * Wrapping still goes through an inner `Text`, so expanded output wraps
 * exactly as before instead of being clamped by the renderer downstream.
 */
export class CappedToolOutputText implements Component {
	private raw = "";
	private expanded = false;
	private isError = false;
	private theme: ToolTheme | null = null;
	private readonly text = new Text("", 0, 0);
	private cachedWidth = -1;
	private cachedLines: string[] | null = null;

	/** Update the source data; no-op (cache kept) when nothing changed. */
	setSource(raw: string, expanded: boolean, isError: boolean, theme: ToolTheme): void {
		if (raw === this.raw && expanded === this.expanded && isError === this.isError && theme === this.theme) {
			return;
		}
		this.raw = raw;
		this.expanded = expanded;
		this.isError = isError;
		this.theme = theme;
		this.invalidate();
	}

	invalidate(): void {
		this.text.invalidate();
		this.cachedWidth = -1;
		this.cachedLines = null;
	}

	render(width: number): string[] {
		if (this.cachedLines !== null && this.cachedWidth === width) {
			return this.cachedLines;
		}
		let lines: string[];
		if (!this.theme) {
			lines = [];
		} else {
			const capped = buildCappedToolOutput(this.raw, this.expanded, this.theme, DEFAULT_RESULT_PREVIEW_LINES, {
				isError: this.isError,
				width,
			});
			// Leading newline detaches the result from the call title (the same
			// `\n${capped}` prefix the previous Text-based renderer used). The inner
			// Text re-wrap is an identity pass for the already-fitting collapsed
			// rows and does the real wrapping for expanded output.
			this.text.setText(capped ? `\n${capped}` : "");
			lines = this.text.render(width);
		}
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

/**
 * Default tool-result renderer: collapse the (trimmed) textual output into a
 * bounded preview unless `options.expanded`, prefixed with a blank line so the
 * result detaches from the call title, and render nothing when there is no
 * output. This is the shared body that the hindsight, plan-adjacent, and
 * utility tools all reuse (reflect/recall/retain/resolve/eval/
 * search_tool_bm25/recipe/inspect_image/render_mermaid/recall_tool_output/
 * goal_complete/forget). Tools whose body differs (no leading newline, custom
 * prefix, error-only) keep their own.
 *
 * The returned {@link CappedToolOutputText} caps by VISUAL lines at render
 * time and, for errored results (`context.isError` / `result.isError`), keeps
 * the tail of the output instead of the head — see {@link CappedOutputOptions}.
 *
 * Signature mirrors ToolDefinition.renderResult — (result, options, theme,
 * context) — so it drops straight into `renderResult: renderToolOutput`.
 * `options.expanded` gates the collapse: a custom renderer built on this
 * helper is never LESS safe than having no renderer at all (the TUI's
 * no-renderer fallback already collapses via {@link buildCappedToolOutput}).
 */
export function renderToolOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean },
	options: { expanded?: boolean } | undefined,
	theme: ToolTheme,
	context: { lastComponent?: unknown; showImages: boolean; isError?: boolean },
): Component {
	const component =
		context.lastComponent instanceof CappedToolOutputText ? context.lastComponent : new CappedToolOutputText();
	const output = getTextOutput(result, context.showImages);
	component.setSource(output, options?.expanded ?? false, context.isError ?? result.isError ?? false, theme);
	return component;
}
