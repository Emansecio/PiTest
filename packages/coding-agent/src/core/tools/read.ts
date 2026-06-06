import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { AgentTool } from "@pit/agent-core";
import type { Api, ImageContent, Model, TextContent } from "@pit/ai";
import { Text } from "@pit/tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { getReadmePath } from "../../config.js";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.js";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.js";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.js";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getUrlSchemeRegistry } from "../url-schemes/index.ts";
import { prepareWithPathAliases } from "./argument-prep.js";
import { formatAnchorsForRead, interleaveAnchorsIntoLines } from "./edit-hashline-diff.ts";
import { crushJson, JSON_CRUSH_TARGET_BYTES } from "./json-crush.js";
import { formatNotebookSource } from "./notebook-formatter.ts";
import { resolveReadPath } from "./path-utils.js";
import { getFilePathArg, getTextOutput, invalidArgText, replaceTabs, shortenPath } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const READ_DEDUPE_WINDOW = 16;

/**
 * Per-session de-dup of repeat reads. A read whose (path, range) was already
 * delivered THIS session with identical content has its body replaced by a short
 * marker instead of being re-sent verbatim. LRU-bounded to the most recent reads:
 * an older read may have scrolled out of context (compaction), so re-sending it is
 * the safe default. Keyed by content hash, so a file edited between reads — whose
 * hash changes — is always re-sent in full.
 */
export class ReadDedupeStore {
	private readonly seen = new Map<string, string>();
	private readonly max: number;
	constructor(max: number = READ_DEDUPE_WINDOW) {
		this.max = Math.max(1, max);
	}
	/** Record this read; report whether it duplicates a recent identical one. */
	isDuplicate(key: string, contentHash: string): boolean {
		const prev = this.seen.get(key);
		// Refresh recency: re-inserting moves the key to the most-recent end.
		this.seen.delete(key);
		this.seen.set(key, contentHash);
		while (this.seen.size > this.max) {
			const oldest = this.seen.keys().next().value;
			if (oldest === undefined) break;
			this.seen.delete(oldest);
		}
		return prev === contentHash;
	}
}

function hashReadContent(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

const readSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
		offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	},
	{ additionalProperties: false },
);

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

interface CompactReadClassification {
	kind: "docs" | "resource" | "skill" | "file";
	label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
	/** When true, embed compact hashline-edit anchors with full-file text reads. Default: true. */
	embedHashlineAnchors?: boolean;
	/**
	 * How to embed anchors. "block" appends a trailing `<anchors>` block (default,
	 * lowest disruption to existing rendering). "interleave" prefixes anchored
	 * lines inline with `L<n> <hash> │ <code>`.
	 */
	embedHashlineAnchorsMode?: "block" | "interleave";
	/**
	 * Optional per-session store that suppresses the body of identical, recent
	 * repeat reads (replacing it with a short marker). When omitted, no de-dup.
	 */
	readDedupeStore?: ReadDedupeStore;
}

type ReadRenderArgs = { path?: string; file_path?: string; offset?: number; limit?: number };

function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme, cwd?: string): string {
	const rawPath = getFilePathArg(args);
	const path = rawPath !== null ? shortenPath(rawPath, cwd) : null;
	const invalidArg = invalidArgText(theme);
	const pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
	return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${formatReadLineRange(args, theme)}`;
}

/**
 * Sniff a buffer to decide whether it is binary (and thus should not be dumped
 * as mojibake). Heuristic mirrors what `git` and `file(1)` do:
 *  - A NUL byte (0x00) in the first 8KB is a strong binary signal — no valid
 *    UTF-8 text file contains lone NULs.
 *  - Otherwise, decode and check the ratio of U+FFFD replacement chars; a high
 *    ratio means the bytes are not valid UTF-8 (e.g. a latin-1 or compressed
 *    blob the decode mangled).
 */
const BINARY_SNIFF_BYTES = 8 * 1024;
const REPLACEMENT_CHAR_RATIO_THRESHOLD = 0.1;

function looksBinary(buffer: Buffer, decoded: string): boolean {
	const sniffLen = Math.min(buffer.length, BINARY_SNIFF_BYTES);
	for (let i = 0; i < sniffLen; i++) {
		if (buffer[i] === 0) return true;
	}
	if (decoded.length === 0) return false;
	let replacements = 0;
	// U+FFFD is the decode's "this byte was not valid UTF-8" marker. Counting
	// only the prefix keeps this O(sniff) for huge files.
	const scanLen = Math.min(decoded.length, BINARY_SNIFF_BYTES);
	for (let i = 0; i < scanLen; i++) {
		if (decoded.charCodeAt(i) === 0xfffd) replacements++;
	}
	return replacements / scanLen > REPLACEMENT_CHAR_RATIO_THRESHOLD;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}

	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}
	return undefined;
}

function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = getFilePathArg(args);
	if (!rawPath) return undefined;

	const absolutePath = resolveReadPath(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	const docsClassification = getPiDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	// Generic file: compact-by-default so the chat reads as a log of which
	// files were touched, not a wall of file previews. Press ctrl+o to expand
	// any individual call when you want to see the bytes.
	const shortened = shortenPath(rawPath, cwd);
	return { kind: "file", label: shortened || rawPath };
}

function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
): string {
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
			theme.fg("customMessageText", classification.label) +
			formatReadLineRange(args, theme) +
			expandHint
		);
	}

	const title = classification.kind === "file" ? "read" : `read ${classification.kind}`;
	return (
		theme.fg("toolTitle", theme.bold(title)) +
		" " +
		theme.fg("accent", classification.label) +
		formatReadLineRange(args, theme) +
		expandHint
	);
}

function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	cwd: string,
	isError: boolean,
): string {
	if (!options.expanded && !isError && getCompactReadClassification(args, cwd)) {
		return "";
	}

	const rawPath = getFilePathArg(args);
	const output = getTextOutput(result, showImages);
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	// Body always hugs the title (no leading blank line), matching Claude Code's
	// compact tool-result layout — output starts on the row directly below the
	// title for both single- and multi-line bodies.
	const body = displayLines
		.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line))))
		.join("\n");
	let text = body;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			// Mirror the read-path recovery hint (line ~401): tell the model how to
			// fetch the oversized line via bash instead of dead-ending it.
			const startLine = args?.offset ?? 1;
			const limitLabel = formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES);
			const hintPath = rawPath ? ` ${rawPath}` : "";
			text += `\n${theme.fg("warning", `[Line ${startLine} exceeds ${limitLabel} limit. Use bash: sed -n '${startLine}p'${hintPath} | head -c ${truncation.maxBytes ?? DEFAULT_MAX_BYTES}]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	const embedHashlineAnchors = options?.embedHashlineAnchors ?? true;
	const embedHashlineAnchorsMode = options?.embedHashlineAnchorsMode ?? "block";
	const dedupeStore = options?.readDedupeStore;
	return {
		name: "read",
		activity: "navigation",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.

Common mistakes to avoid:
- Passing a range like "1-50" — use { offset: 1, limit: 50 } instead.
- Using "start_line"/"end_line" — the canonical fields are "offset" (1-indexed start line) and "limit" (line count).
- Using "file_path" or "filename" — the canonical key is "path".
- Calling read for a directory — use "ls" instead.
- Calling read repeatedly with the same offset — increment offset by the previous limit.
- Re-reading a file you have already read in this session unless it was modified — the previous result is still in context.`,
		promptSnippet: "Read file contents",
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
		parameters: readSchema,
		prepareArguments: prepareWithPathAliases,
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?,
		) {
			// URL-scheme dispatch: virtual paths like `pr://1428` are resolved by
			// registered scheme handlers, not the local filesystem.
			const schemeMatch = getUrlSchemeRegistry().parse(path);
			if (schemeMatch) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const result = await schemeMatch.resolver.read(schemeMatch.url, { cwd, signal });
				if (result.kind === "error") {
					throw new Error(result.error ?? `scheme '${schemeMatch.resolver.scheme}' returned an error`);
				}
				let text: string;
				if (result.kind === "directory") {
					const entries = result.entries ?? [];
					text = entries.map((e) => (e.isDir ? `${e.name}/` : e.name)).join("\n");
				} else {
					text = result.content ?? "";
				}
				// Apply line-wise offset/limit slicing.
				if (offset !== undefined || limit !== undefined) {
					const allLines = text.split("\n");
					const startLine = offset ? Math.max(0, offset - 1) : 0;
					if (startLine >= allLines.length) {
						throw new Error(`Offset ${offset} is beyond end of resource (${allLines.length} lines total)`);
					}
					const endLine = limit !== undefined ? Math.min(startLine + limit, allLines.length) : allLines.length;
					text = allLines.slice(startLine, endLine).join("\n");
				}
				return { content: [{ type: "text", text } as TextContent], details: undefined };
			}
			const absolutePath = resolveReadPath(path, cwd);
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							// Check if file exists and is readable.
							await ops.access(absolutePath);
							if (aborted) return;
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								const base64 = buffer.toString("base64");
								if (autoResizeImages) {
									// Resize image if needed before sending it back to the model.
									const resized = await resizeImage({ type: "image", data: base64, mimeType });
									if (!resized) {
										let textNote = `Read image file [${mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]`;
										if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
										content = [{ type: "text", text: textNote }];
									} else {
										const dimensionNote = formatDimensionNote(resized);
										let textNote = `Read image file [${resized.mimeType}]`;
										if (dimensionNote) textNote += `\n${dimensionNote}`;
										if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
										content = [
											{ type: "text", text: textNote },
											{ type: "image", data: resized.data, mimeType: resized.mimeType },
										];
									}
								} else {
									let textNote = `Read image file [${mimeType}]`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: base64, mimeType },
									];
								}
							} else {
								// Read text content.
								const buffer = await ops.readFile(absolutePath);
								const textContent = buffer.toString("utf-8");

								// Binary sniff: a non-image file with NUL bytes or mostly-invalid
								// UTF-8 is not displayable as text. Returning the mojibake wastes
								// context and tells the model nothing; instead point it at bash.
								if (looksBinary(buffer, textContent)) {
									const note = `[Binary file: ${basename(absolutePath)}, ${formatSize(buffer.length)} (${buffer.length} bytes). Not displayable as text. Use \`bash\` for hex/metadata (e.g. xxd, file).]`;
									content = [{ type: "text", text: note }];
									if (aborted) return;
									signal?.removeEventListener("abort", onAbort);
									resolve({ content, details: undefined });
									return;
								}

								// Jupyter notebooks: parse cells[] and render as flat text. Offset/limit
								// address CELLS (not lines) so a 200-cell notebook pages like a file.
								// Falls back to plain-text rendering on parse failure rather than blowing
								// up — many .ipynb files in the wild have stray trailing content.
								if (absolutePath.toLowerCase().endsWith(".ipynb")) {
									try {
										const formatted = formatNotebookSource(textContent, {
											offset,
											limit,
											name: basename(absolutePath),
										});
										let outputText = formatted.text;
										const startIndex = Math.max(0, (offset ?? 1) - 1);
										const renderedEnd = startIndex + formatted.renderedCells;
										if (renderedEnd < formatted.totalCells) {
											outputText += `\n\n[Showing cells ${startIndex + 1}-${renderedEnd} of ${formatted.totalCells}. Use offset=${renderedEnd + 1} to continue.]`;
										}
										content = [{ type: "text", text: outputText }];
										if (aborted) return;
										signal?.removeEventListener("abort", onAbort);
										resolve({ content, details: undefined });
										return;
									} catch {
										// Fall through to the generic text path — better degraded than broken.
									}
								}

								const allLines = textContent.split("\n");
								const totalFileLines = allLines.length;
								// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1;
								// Check if offset is out of bounds.
								if (startLine >= allLines.length) {
									throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
								}
								let selectedContent: string;
								let userLimitedLines: number | undefined;
								// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
								if (limit !== undefined) {
									const endLine = Math.min(startLine + limit, allLines.length);
									selectedContent = allLines.slice(startLine, endLine).join("\n");
									userLimitedLines = endLine - startLine;
								} else {
									selectedContent = allLines.slice(startLine).join("\n");
								}
								// Apply truncation, respecting both line and byte limits.
								const truncation = truncateHead(selectedContent);
								let outputText: string;
								// Structural JSON crush (behind PIT_JSON_CRUSH): a whole-file read of a
								// large JSON/NDJSON file would otherwise be blindly head-cut — tail lost,
								// structure broken, and often the whole thing dropped when it is a single
								// minified line. Emit a schema + head/tail-samples crush instead. Only when
								// it would already truncate; the file on disk stays the source of truth
								// (offset/limit or `bash jq` recover any elided detail). crushJson self-gates
								// to real JSON, so non-JSON falls through to the normal truncation below.
								const crushed =
									process.env.PIT_JSON_CRUSH === "1" &&
									offset === undefined &&
									limit === undefined &&
									truncation.truncated
										? crushJson(selectedContent, { targetChars: JSON_CRUSH_TARGET_BYTES })
										: undefined;
								if (crushed !== undefined) {
									const originalSize = formatSize(Buffer.byteLength(selectedContent, "utf-8"));
									outputText = `${crushed}\n\n[Large JSON crushed to schema + samples (${originalSize} original). Re-read with offset/limit or use \`bash jq\` for any elided detail.]`;
									details = { truncation };
								} else if (truncation.firstLineExceedsLimit) {
									// First line alone exceeds the byte limit. Point the model at a bash fallback.
									const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = { truncation };
								} else if (truncation.truncated) {
									// Truncation occurred. Build an actionable continuation notice.
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									outputText = truncation.content;
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									// User-specified limit stopped early, but the file still has more content.
									const remaining = allLines.length - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
								} else {
									// No truncation and no remaining user-limited content.
									outputText = truncation.content;
								}
								// De-dup: if this exact (path, range) was already read this session with
								// identical pre-anchor content, replace the body with a short marker instead
								// of re-sending it. LRU-bounded so only recent reads de-dup; an older one may
								// have scrolled out of context, where re-sending is correct. Skips anchors.
								let dedupeSuppressed = false;
								if (dedupeStore) {
									const dedupeKey = `${absolutePath} ${offset ?? ""} ${limit ?? ""}`;
									if (dedupeStore.isDuplicate(dedupeKey, hashReadContent(outputText))) {
										const shownLines = outputText.length === 0 ? 0 : outputText.split("\n").length;
										const rangeLabel =
											offset !== undefined || limit !== undefined
												? ` (offset ${offset ?? 1}${limit !== undefined ? `, limit ${limit}` : ""})`
												: "";
										outputText = `[read ${path}${rangeLabel}: identical to an earlier read this session — ${shownLines} line(s), unchanged and already shown above. Re-run read to re-expand if it has scrolled out of context.]`;
										dedupeSuppressed = true;
									}
								}
								// Anchors: on by default, only when caller did not slice the file.
								if (
									!dedupeSuppressed &&
									embedHashlineAnchors &&
									offset === undefined &&
									limit === undefined &&
									!truncation.truncated
								) {
									if (embedHashlineAnchorsMode === "interleave") {
										outputText = interleaveAnchorsIntoLines(outputText);
									} else {
										outputText += `\n\n<anchors>\n${formatAnchorsForRead(textContent, { lines: allLines })}\n</anchors>`;
									}
								}
								content = [{ type: "text", text: outputText }];
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
			text.setText(
				classification
					? formatCompactReadCall(classification, args, theme)
					: formatReadCall(args, theme, context.cwd),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				formatReadResult(context.args, result, options, theme, context.showImages, context.cwd, context.isError),
			);
			return text;
		},
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
