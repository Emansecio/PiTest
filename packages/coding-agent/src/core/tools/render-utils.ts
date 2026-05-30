import * as os from "node:os";
import type { ImageContent, TextContent } from "@pit/ai";
import { getCapabilities, getImageDimensions, imageFallback } from "@pit/tui";
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

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
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
