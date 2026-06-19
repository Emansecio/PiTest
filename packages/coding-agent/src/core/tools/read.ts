import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentTool } from "@pit/agent-core";
import { type Api, type ImageContent, type Model, recordDiagnostic, type TextContent } from "@pit/ai";
import { Text } from "@pit/tui";
import { constants, createReadStream } from "fs";
import { access as fsAccess, readdir as fsReaddir, readFile as fsReadFile, stat as fsStat } from "fs/promises";
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
import { generateDiffString } from "./edit-diff.ts";
import { formatAnchorsForRead, interleaveAnchorsIntoLines } from "./edit-hashline-diff.ts";
import { isJsonCrushEnabled, maybeCrushJsonOutput } from "./json-crush.js";
import { formatNotebookSource } from "./notebook-formatter.ts";
import { resolveReadPath } from "./path-utils.js";
import {
	getFilePathArg,
	getTextOutput,
	invalidArgText,
	replaceTabs,
	shortenPath,
	trimTrailingEmptyLines,
} from "./render-utils.js";
import { listDeclarations } from "./symbol.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const READ_DEDUPE_WINDOW = 16;

/**
 * Per-session de-dup of repeat reads. A read whose (path, range) was already
 * delivered THIS session with identical content has its body replaced by a short
 * marker instead of being re-sent verbatim. When the content CHANGED since the
 * earlier read (e.g. an edit between reads), the prior body is retained so the
 * caller can re-send only a diff instead of the whole file. LRU-bounded to the
 * most recent reads: an older one may have scrolled out of context (compaction),
 * so re-sending it in full is the safe default. Keyed by (path, range).
 */
export class ReadDedupeStore {
	private readonly seen = new Map<string, { hash: string; content: string; clean: boolean }>();
	private readonly max: number;
	constructor(max: number = READ_DEDUPE_WINDOW) {
		this.max = Math.max(1, max);
	}
	/** Prior record for this key if still in the LRU window; does not affect recency. */
	peek(key: string): { hash: string; content: string; clean: boolean } | undefined {
		return this.seen.get(key);
	}
	/**
	 * Record this read and report whether it duplicates the most recent identical
	 * one. `clean` marks a body that is the verbatim file content — no truncation /
	 * user-limit / crush footer. Only clean bodies are retained (others store ""),
	 * so a later delta always diffs real file content against real file content and
	 * never carries a synthetic footer into the diff. Re-inserting refreshes recency.
	 */
	record(key: string, contentHash: string, content: string, clean: boolean): boolean {
		const prev = this.seen.get(key);
		this.seen.delete(key);
		this.seen.set(key, { hash: contentHash, content: clean ? content : "", clean });
		while (this.seen.size > this.max) {
			const oldest = this.seen.keys().next().value;
			if (oldest === undefined) break;
			this.seen.delete(oldest);
		}
		return prev?.hash === contentHash;
	}
}

function hashReadContent(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Below this size a re-read is cheap enough that delta framing isn't worth it. */
const READ_DELTA_MIN_BYTES = 1500;
/** A delta must be at most this fraction of the full body to be worth sending. */
const READ_DELTA_MAX_RATIO = 0.5;

/**
 * When a file changed since an earlier identical-range read THIS session, render
 * only the diff — the model still has the prior body above in context — instead
 * of re-sending the whole file. Returns undefined when a delta isn't worthwhile
 * (tiny body, or a diff that doesn't save enough), so the caller sends in full.
 */
function buildReadDelta(prevContent: string, newContent: string): string | undefined {
	if (newContent.length < READ_DELTA_MIN_BYTES) return undefined;
	const { diff } = generateDiffString(prevContent, newContent);
	if (diff.length === 0) return undefined;
	if (diff.length >= newContent.length * READ_DELTA_MAX_RATIO) return undefined;
	return diff;
}

const readSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
		offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
		outline: Type.Optional(
			Type.Boolean({
				description:
					"Return only a symbol outline (top-level names + line ranges) instead of file content. Use to locate a function in a large file cheaply, then read the specific range before editing.",
			}),
		),
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
	/**
	 * Optional: file size lookup. Together with createByteStream it enables the
	 * large-file streaming fast path. Remote operations (e.g. SSH) may omit both
	 * and keep the buffered readFile path.
	 */
	stat?: (absolutePath: string) => Promise<{ size: number; isDirectory?: () => boolean }>;
	/** Optional: open a raw byte stream over the file (see stat). */
	createByteStream?: (absolutePath: string) => NodeJS.ReadableStream;
	/**
	 * Optional: list directory entries. When present, a `read` that targets a
	 * directory returns a listing (like `ls`) instead of a "use ls" note. Remote
	 * ops (e.g. SSH) may omit it and fall back to the note.
	 */
	readdir?: (absolutePath: string) => Promise<Array<{ name: string; isDirectory: boolean }>>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	stat: (path) => fsStat(path),
	createByteStream: (path) => createReadStream(path),
	readdir: async (path) => {
		const ents = await fsReaddir(path, { withFileTypes: true });
		return ents.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
	},
};

/** Note returned when `read` targets a directory. A directory passes access(R_OK)
 * but every read syscall on it throws EISDIR, so we redirect the model to `ls`
 * instead of surfacing a raw "illegal operation on a directory" crash. */
function formatDirectoryReadNote(path: string): string {
	return `[${path} is a directory, not a file. Use the "ls" tool to list its contents, or read a specific file inside it.]`;
}

/**
 * Resolves a `read` that targeted a directory into a listing (like `ls`):
 * entries sorted case-insensitively, directories suffixed with `/`. Honors
 * offset/limit for paging large directories; otherwise caps the body with
 * truncateHead so an enormous directory can't blow the context window. Falls
 * back to the "use ls" note when the ops can't list (remote without readdir).
 */
async function resolveDirectoryRead(
	displayPath: string,
	absolutePath: string,
	ops: ReadOperations,
	offset?: number,
	limit?: number,
): Promise<string> {
	if (!ops.readdir) return formatDirectoryReadNote(displayPath);
	let entries: Array<{ name: string; isDirectory: boolean }>;
	try {
		entries = await ops.readdir(absolutePath);
	} catch {
		return formatDirectoryReadNote(displayPath);
	}
	if (entries.length === 0) return `[${displayPath} is a directory (empty).]`;
	const allLines = entries
		.slice()
		.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
		.map((e) => (e.isDirectory ? `${e.name}/` : e.name));
	const header = `Directory ${displayPath} (${allLines.length} ${allLines.length === 1 ? "entry" : "entries"}):`;
	if (offset !== undefined || limit !== undefined) {
		const startLine = offset ? Math.max(0, offset - 1) : 0;
		const endLine = limit !== undefined ? Math.min(startLine + limit, allLines.length) : allLines.length;
		return `${header}\n${allLines.slice(startLine, endLine).join("\n")}`;
	}
	const truncation = truncateHead(allLines.join("\n"));
	const body = truncation.truncated
		? `${truncation.content}\n\n[Listing truncated. Use the ls tool with a limit, or read a specific entry.]`
		: truncation.content;
	return `${header}\n${body}`;
}

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
	/**
	 * When true, embed compact hashline-edit anchors with full-file text reads.
	 * Accepts a getter so the session can gate anchors on the LIVE tool surface
	 * (they are dead weight unless a hashline editor like edit_v2 is active, and
	 * the surface can change after this definition is built). Default: true.
	 */
	embedHashlineAnchors?: boolean | (() => boolean);
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
	/**
	 * Text files larger than this many bytes stream line-by-line instead of
	 * being fully buffered. Default: 10MB. Mainly overridable for tests.
	 */
	streamingMinBytes?: number;
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

/**
 * The "not displayable as text" note for a binary file, pointing the model at
 * bash for hex/metadata. Shared by the streaming and buffered read paths, which
 * differ only in where the byte count comes from (stat size vs buffer length).
 */
function formatBinaryFileNote(absolutePath: string, byteLength: number): string {
	return `[Binary file: ${basename(absolutePath)}, ${formatSize(byteLength)} (${byteLength} bytes). Not displayable as text. Use \`bash\` for hex/metadata (e.g. xxd, file).]`;
}

/** Files larger than this stream line-by-line instead of being fully buffered. */
const STREAM_READ_MIN_BYTES = 10 * 1024 * 1024; // 10MB

// Mirrors MAX_PARSE_CHARS in json-crush.ts: above this size crushJson refuses to
// parse and returns undefined, so a JSON-crush-eligible read of a huge file would
// fully buffer the file (O(file size) heap → OOM) only to fall back to a blind
// head-cut. Cap eligibility at this size so larger JSON/NDJSON drops into the
// streamLargeTextRead path (which is bounded) like every other text type.
const JSON_CRUSH_MAX_BYTES = 5_000_000;

interface StreamedTextRead {
	kind: "text";
	/** Lines [startLine, startLine + collectable), with the buffered path's split("\n") semantics. */
	selectedLines: string[];
	/** Exact equivalent of textContent.split("\n").length for the whole file. */
	totalFileLines: number;
}

interface StreamedBinaryRead {
	kind: "binary";
}

/**
 * Stream a large text file, collecting only the lines this read could possibly
 * output plus an exact total line count. Byte-identical to the buffered path:
 * lines use split("\n") semantics (a CR before LF is preserved, a trailing
 * newline yields a final empty line) and the binary sniff inspects the same
 * leading bytes. Once every collectable line is gathered, the remainder is only
 * scanned for raw 0x0A bytes (no decode) to finish the count — valid because
 * a UTF-8 continuation byte can never be 0x0A. Memory stays O(collected lines)
 * instead of O(file size).
 */
async function streamLargeTextRead(
	absolutePath: string,
	createByteStream: (absolutePath: string) => NodeJS.ReadableStream,
	startLine: number,
	limit: number | undefined,
	signal?: AbortSignal,
): Promise<StreamedTextRead | StreamedBinaryRead> {
	// Without a user limit, one line beyond what truncateHead can emit is enough
	// to make it report truncation exactly as if it had seen the full content.
	const maxCollect = limit !== undefined ? Math.max(0, limit) : DEFAULT_MAX_LINES + 1;
	const collectEnd = startLine + maxCollect;
	const stream = createByteStream(absolutePath);
	const decoder = new StringDecoder("utf8");
	const selectedLines: string[] = [];
	let sniffChunks: Buffer[] = [];
	let sniffedBytes = 0;
	let sniffedText = "";
	let sniffDone = false;
	let carry = "";
	// Number of completed (newline-terminated) lines so far == index of the line
	// currently accumulating in `carry`.
	let completedLines = 0;
	let countOnly = false;
	try {
		for await (const data of stream) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const chunk = data as Buffer;
			if (countOnly) {
				let pos = chunk.indexOf(10);
				while (pos !== -1) {
					completedLines++;
					pos = chunk.indexOf(10, pos + 1);
				}
				continue;
			}
			const text = decoder.write(chunk);
			if (!sniffDone) {
				sniffChunks.push(chunk);
				sniffedBytes += chunk.length;
				if (sniffedText.length < BINARY_SNIFF_BYTES) sniffedText += text;
				if (sniffedBytes >= BINARY_SNIFF_BYTES) {
					sniffDone = true;
					if (looksBinary(Buffer.concat(sniffChunks), sniffedText)) return { kind: "binary" };
					sniffChunks = [];
				}
			}
			const parts = (carry + text).split("\n");
			carry = parts.pop() as string;
			for (const part of parts) {
				if (completedLines >= startLine && completedLines < collectEnd) selectedLines.push(part);
				completedLines++;
			}
			if (sniffDone && completedLines >= collectEnd) {
				// Every collectable line is in; the rest only needs counting.
				countOnly = true;
				carry = "";
			}
		}
	} finally {
		const destroyable = stream as { destroy?: () => void };
		destroyable.destroy?.();
	}
	if (signal?.aborted) throw new Error("Operation aborted");
	if (!sniffDone && looksBinary(Buffer.concat(sniffChunks), sniffedText)) return { kind: "binary" };
	if (!countOnly) {
		// Flush any incomplete trailing multi-byte sequence the same way
		// buffer.toString("utf-8") would (as replacement chars), then account for
		// the final line after the last newline.
		carry += decoder.end();
		if (completedLines >= startLine && completedLines < collectEnd) selectedLines.push(carry);
	}
	const totalFileLines = completedLines + 1;
	return { kind: "text", selectedLines, totalFileLines };
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
	const streamingMinBytes = options?.streamingMinBytes ?? STREAM_READ_MIN_BYTES;
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
			{ path, offset, limit, outline }: { path: string; offset?: number; limit?: number; outline?: boolean },
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
			if (outline) {
				if (signal?.aborted) throw new Error("Operation aborted");
				await ops.access(absolutePath);
				// Same streaming threshold the normal read path uses: outline buffers the
				// whole file to scan declarations, so a multi-MB minified/generated source
				// would OOM. Refuse above the cap with an actionable hint instead of crashing.
				if (ops.stat) {
					const outlineStat = await ops.stat(absolutePath);
					if (outlineStat.size > streamingMinBytes) {
						// Observe the size refusal (additive; behavior unchanged).
						recordDiagnostic({
							category: "output.cap",
							level: "info",
							source: "read.outline",
							context: { path, bytes: outlineStat.size },
						});
						const text = `[outline of ${path}: ${formatSize(outlineStat.size)} exceeds ${formatSize(streamingMinBytes)} — use grep/ast_grep to locate symbols, or read with offset/limit]`;
						return { content: [{ type: "text", text } as TextContent], details: undefined };
					}
				}
				const buffer = await ops.readFile(absolutePath);
				const decls = listDeclarations(buffer.toString("utf-8"), absolutePath);
				const body =
					decls.length > 0
						? decls.map((d) => `${d.name}  L${d.line}-${d.endLine}  [${d.kind}]`).join("\n")
						: "(no top-level symbols detected — read the file or use grep)";
				const text = `Outline of ${path} (heuristic — read the range before editing):\n${body}`;
				return { content: [{ type: "text", text } as TextContent], details: undefined };
			}
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
							// A directory passes access(R_OK), but every read syscall on it
							// (image sniff, byte stream, readFile) throws EISDIR. Detect it up
							// front and return an actionable note instead of crashing.
							if (ops.stat) {
								const earlyStat = await ops.stat(absolutePath);
								if (aborted) return;
								if (earlyStat.isDirectory?.()) {
									const text = await resolveDirectoryRead(path, absolutePath, ops, offset, limit);
									if (aborted) return;
									signal?.removeEventListener("abort", onAbort);
									resolve({ content: [{ type: "text", text }], details: undefined });
									return;
								}
							}
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
								// Read text content. Output is capped at DEFAULT_MAX_LINES/
								// DEFAULT_MAX_BYTES, so fully buffering a huge file costs O(file
								// size) memory for a few KB of output. Files above the streaming
								// threshold are read line-by-line instead; the buffered path stays
								// for small files, operations without stat/createByteStream (e.g.
								// remote), notebooks, and JSON-crush-eligible reads (crush needs
								// the whole content).
								// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1;
								// Stat once up front (when available) so json-crush eligibility can be
								// size-gated. Reused by the streaming branch below.
								const preReadStat = ops.stat ? await ops.stat(absolutePath) : undefined;
								if (aborted) return;
								// crushJson buffers the whole file, but refuses to parse above
								// JSON_CRUSH_MAX_BYTES (it returns undefined and the caller blind-cuts).
								// Treating a file that large as crush-eligible would skip the bounded
								// streaming path and fully buffer it → OOM. Only stay eligible when the
								// file fits the crush ceiling, or when size is unknown (ops without
								// stat: remote/in-memory, where the buffered path is the only option).
								const fitsJsonCrush = preReadStat === undefined || preReadStat.size <= JSON_CRUSH_MAX_BYTES;
								const jsonCrushEligible =
									isJsonCrushEnabled() && offset === undefined && limit === undefined && fitsJsonCrush;
								let streamed: StreamedTextRead | StreamedBinaryRead | undefined;
								if (
									preReadStat &&
									ops.createByteStream &&
									!jsonCrushEligible &&
									!absolutePath.toLowerCase().endsWith(".ipynb")
								) {
									const fileStat = preReadStat;
									if (fileStat.size > streamingMinBytes) {
										streamed = await streamLargeTextRead(
											absolutePath,
											ops.createByteStream,
											startLine,
											limit,
											signal,
										);
										if (streamed.kind === "binary") {
											const note = formatBinaryFileNote(absolutePath, fileStat.size);
											content = [{ type: "text", text: note }];
											if (aborted) return;
											signal?.removeEventListener("abort", onAbort);
											resolve({ content, details: undefined });
											return;
										}
									}
								}

								let totalFileLines: number;
								let selectedLines: string[];
								// Whole-file data, only available on the buffered path (anchors need it).
								let wholeFile: { textContent: string; allLines: string[] } | undefined;
								if (streamed?.kind === "text") {
									totalFileLines = streamed.totalFileLines;
									// Check if offset is out of bounds.
									if (startLine >= totalFileLines) {
										throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
									}
									selectedLines = streamed.selectedLines;
								} else {
									const buffer = await ops.readFile(absolutePath);
									const textContent = buffer.toString("utf-8");

									// Binary sniff: a non-image file with NUL bytes or mostly-invalid
									// UTF-8 is not displayable as text. Returning the mojibake wastes
									// context and tells the model nothing; instead point it at bash.
									if (looksBinary(buffer, textContent)) {
										const note = formatBinaryFileNote(absolutePath, buffer.length);
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
									wholeFile = { textContent, allLines };
									totalFileLines = allLines.length;
									// Check if offset is out of bounds.
									if (startLine >= allLines.length) {
										throw new Error(
											`Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
										);
									}
									const endLine =
										limit !== undefined ? Math.min(startLine + limit, allLines.length) : allLines.length;
									selectedLines = allLines.slice(startLine, endLine);
								}

								// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
								const selectedContent = selectedLines.join("\n");
								const userLimitedLines = limit !== undefined ? selectedLines.length : undefined;
								// Apply truncation, respecting both line and byte limits.
								const truncation = truncateHead(selectedContent);
								let outputText: string;
								// True only when outputText is the verbatim body (no truncation/limit/crush
								// footer) — the sole case where it is safe to record for and emit as a delta.
								let bodyIsClean = false;
								// Structural JSON crush (on by default; PIT_NO_JSON_CRUSH opts out): a whole-file read of a
								// large JSON/NDJSON file would otherwise be blindly head-cut — tail lost,
								// structure broken, and often the whole thing dropped when it is a single
								// minified line. Emit a schema + head/tail-samples crush instead. Only when
								// it would already truncate; the file on disk stays the source of truth
								// (offset/limit or `bash jq` recover any elided detail). crushJson self-gates
								// to real JSON, so non-JSON falls through to the normal truncation below.
								const crushed = maybeCrushJsonOutput({
									text: selectedContent,
									shouldAttempt: jsonCrushEligible && truncation.truncated,
									recoveryHint: "Re-read with offset/limit or use `bash jq` for any elided detail.",
								});
								if (crushed !== undefined) {
									outputText = crushed;
									details = { truncation };
								} else if (truncation.firstLineExceedsLimit) {
									// First line alone exceeds the byte limit. Point the model at a bash fallback.
									const firstLineSize = formatSize(Buffer.byteLength(selectedLines[0] ?? "", "utf-8"));
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
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
									// User-specified limit stopped early, but the file still has more content.
									const remaining = totalFileLines - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
								} else {
									// No truncation and no remaining user-limited content: a clean body.
									outputText = truncation.content;
									bodyIsClean = true;
								}
								// De-dup / delta: if this exact (path, range) was already read this session,
								// either suppress it (identical content) or re-send only a diff (changed
								// since). LRU-bounded so only recent reads qualify; an older one may have
								// scrolled out of context, where re-sending in full is correct. A delta only
								// fires when BOTH the prior and current bodies are clean (verbatim file
								// content) so the diff never carries a truncation/limit/crush footer. Anchors
								// are skipped whenever the body isn't the full current file.
								let dedupeSuppressed = false;
								let deltaApplied = false;
								if (dedupeStore) {
									const dedupeKey = `${absolutePath} ${offset ?? ""} ${limit ?? ""}`;
									const rangeLabel =
										offset !== undefined || limit !== undefined
											? ` (offset ${offset ?? 1}${limit !== undefined ? `, limit ${limit}` : ""})`
											: "";
									const prev = dedupeStore.peek(dedupeKey);
									const isDup = dedupeStore.record(
										dedupeKey,
										hashReadContent(outputText),
										outputText,
										bodyIsClean,
									);
									if (isDup) {
										const shownLines = outputText.length === 0 ? 0 : outputText.split("\n").length;
										outputText = `[read ${path}${rangeLabel}: identical to an earlier read this session — ${shownLines} line(s), unchanged and already shown above. Re-run read to re-expand if it has scrolled out of context.]`;
										dedupeSuppressed = true;
									} else if (prev?.clean && bodyIsClean) {
										const delta = buildReadDelta(prev.content, outputText);
										if (delta !== undefined) {
											outputText = `[read ${path}${rangeLabel}: changed since your earlier read this session — showing only the diff (you already have the previous version above; re-run read to re-expand the full current file):]\n\n${delta}`;
											deltaApplied = true;
										}
									}
								}
								// Anchors: on by default, only when caller did not slice the file.
								// wholeFile is absent only on the streaming path, where a truncation
								// always occurs (file > threshold >> byte cap) and this branch is
								// unreachable anyway.
								const anchorsEnabled =
									typeof embedHashlineAnchors === "function" ? embedHashlineAnchors() : embedHashlineAnchors;
								if (
									!dedupeSuppressed &&
									!deltaApplied &&
									anchorsEnabled &&
									offset === undefined &&
									limit === undefined &&
									!truncation.truncated &&
									wholeFile !== undefined
								) {
									if (embedHashlineAnchorsMode === "interleave") {
										outputText = interleaveAnchorsIntoLines(outputText);
									} else {
										outputText += `\n\n<anchors>\n${formatAnchorsForRead(wholeFile.textContent, { lines: wholeFile.allLines })}\n</anchors>`;
									}
								}
								content = [{ type: "text", text: outputText }];
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							if (aborted) return;
							// Ops without stat (e.g. remote SSH) reach the read syscall on a
							// directory; convert EISDIR into a listing (or the note fallback).
							if (error?.code === "EISDIR") {
								const text = await resolveDirectoryRead(path, absolutePath, ops, offset, limit);
								resolve({ content: [{ type: "text", text }], details: undefined });
								return;
							}
							reject(error);
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
