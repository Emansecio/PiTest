import { createInterface } from "node:readline";
import type { AgentTool } from "@pit/agent-core";
import { recordDiagnostic } from "@pit/ai";
import { Text } from "@pit/tui";
import { spawn } from "child_process";
import { readFile, stat } from "fs/promises";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { ensureTool } from "../../utils/tools-manager.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { prepareWithPathAliases } from "./argument-prep.js";
import { capAppend, type FffContentMatch, type FffSearchMode, fffSearch, isSimpleGrepGlob } from "./fff-search.js";
import { resolveToCwd } from "./path-utils.js";
import { getTextOutput, invalidArgText, nonEmptyDetails, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const DEFAULT_LIMIT = 100;
// Hard cap on `limit`: without one a single call could request effectively
// unbounded matches, undermining the read-style pagination this tool relies
// on. Mirrors ast_grep's DEFAULT_LIMIT/MAX_LIMIT pattern.
const MAX_LIMIT = 1000;

const grepSchema = Type.Object(
	{
		pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
		path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
		glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
		ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
		literal: Type.Optional(
			Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
		),
		context: Type.Optional(
			Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
		),
		multiline: Type.Optional(
			Type.Boolean({
				description:
					"Let the pattern span lines: '.' matches newlines and a match can cross line boundaries (default: false).",
			}),
		),
		outputMode: Type.Optional(
			Type.Union([Type.Literal("content"), Type.Literal("files_with_matches"), Type.Literal("count")], {
				description:
					"What to return: 'content' = matching lines (default); 'files_with_matches' = just the file paths that match (cheapest — use to locate); 'count' = matches-per-file as 'path:count'. With files/count, 'limit' caps files and 'context' is ignored.",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: `Maximum number of matches to return (default: ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
				minimum: 1,
				maximum: MAX_LIMIT,
			}),
		),
	},
	{ additionalProperties: false },
);

export type GrepToolInput = Static<typeof grepSchema>;
// OOM guard: rg skips files above this on the source side (--max-filesize) and
// getFileLines refuses to buffer a matched file larger than this for context.
// Matching a pattern inside a giant lockfile / .min.js / dump would otherwise
// readFile the whole thing into the heap and crash the process. 10MB mirrors
// read.ts's STREAM_READ_MIN_BYTES.
const MAX_GREP_FILE_BYTES = 10 * 1024 * 1024;
const MAX_GREP_FILE_SIZE_ARG = "10M";
// Per-LINE byte ceiling for content mode. Without it a match inside a minified
// single-line file (a 10MB .min.js / one-line JSON dump under MAX_GREP_FILE_BYTES)
// puts the entire line in rg's `--json` `lines.text`, which createInterface buffers
// and JSON.parse materialises on the heap BEFORE truncateLine cuts it to 500 chars.
// Generous enough that ordinary lines (and the match-centred window) are unaffected
// — the visible output is truncated downstream regardless; this only bounds heap.
const GREP_MAX_COLUMNS = 4096;
// Cap retained rg stderr so a tree spewing permission/diagnostic warnings can't
// grow memory unbounded. Mirrors the LSP's MAX_STDERR_BYTES. We keep the HEAD,
// not the tail: stderr is consumed once as the error message and the first line
// carries the actionable failure (e.g. the "regex parse error" we sniff below).
const MAX_GREP_STDERR_BYTES = 64 * 1024;

/**
 * Convert a UTF-8 byte offset (as emitted by `rg --json` submatch `start`) into a
 * JS string char index (UTF-16 code units) for the given line text. Walks code
 * points accumulating their UTF-8 byte width until the target offset is reached.
 * Clamps to the string length; returns 0 for a non-positive offset.
 */
export function byteOffsetToCharIndex(text: string, byteOffset: number): number {
	if (byteOffset <= 0) return 0;
	let bytes = 0;
	const len = text.length;
	for (let i = 0; i < len; i++) {
		if (bytes >= byteOffset) return i;
		const code = text.charCodeAt(i);
		if (code < 0x80) {
			bytes += 1;
		} else if (code < 0x800) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			// Surrogate pair → 4 bytes; the low surrogate is consumed here so it is
			// not counted again on the next iteration.
			bytes += 4;
			i++;
		} else {
			bytes += 3;
		}
	}
	return len;
}

/** Append a stderr chunk while retaining at most the leading MAX_GREP_STDERR_BYTES.
 * Kept as its own export (not inlined) so grep's byte ceiling stays a fixed,
 * testable 2-arg seam — exercised directly by find-grep-git-and-postfilter.test.ts. */
export function appendCappedStderr(current: string, chunk: string): string {
	return capAppend(current, chunk, MAX_GREP_STDERR_BYTES);
}

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines */
	readFile: (absolutePath: string) => Promise<string> | string;
	/** Byte size of a file, used as an OOM guard before readFile. Omit to skip the guard. */
	fileSize?: (absolutePath: string) => Promise<number> | number;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await stat(p)).isDirectory(),
	readFile: (p) => readFile(p, "utf-8"),
	fileSize: async (p) => (await stat(p)).size,
};

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	operations?: GrepOperations;
	/**
	 * Search backend. `"rg"` spawns ripgrep per query. `"fff"` answers from a
	 * warm in-memory index — content, files_with_matches, and count modes, over
	 * the whole repo or a subdir/file inside cwd — falling back to `rg` for every
	 * unsupported case (custom operations, glob, multiline, ignoreCase, path
	 * outside cwd, `.git` scope, an unprovable-complete subdir scan, or the
	 * native binary being absent). Behavior-identical to `rg` on its supported
	 * subset; only faster.
	 */
	engine?: "rg" | "fff";
}

/** Map the grep tool's outputMode to the fff backend's mode name. */
const FFF_MODE_BY_OUTPUT = {
	content: "content",
	files_with_matches: "files",
	count: "count",
} as const satisfies Record<"content" | "files_with_matches" | "count", FffSearchMode>;

/** A content match in the shape buildContentOutput consumes (rg + fff share it). */
interface ContentMatch {
	filePath: string;
	lineNumber: number;
	lineText?: string;
	matchStart?: number;
}

/**
 * Format collected content matches into the grep tool's text output + details.
 * Shared by the ripgrep streaming path and the fff backend so both produce
 * byte-identical output (same per-line truncation, match-centred windows, and
 * truncation/limit notices). Returns `"aborted"` if the abort signal fires
 * mid-format (a slow/pluggable readFile backend must not run to completion).
 */
function grepLineKey(filePath: string, lineNumber: number): string {
	return `${filePath}\u0000${lineNumber}`;
}

async function buildContentOutput(deps: {
	matches: ContentMatch[];
	contextValue: number;
	effectiveLimit: number;
	matchLimitReached: boolean;
	formatPath: (filePath: string) => string;
	getFileLines: (filePath: string) => Promise<string[]>;
	getLineText?: (filePath: string, lineNumber: number) => string | undefined;
	isAborted: () => boolean;
}): Promise<{ output: string; details: GrepToolDetails } | "aborted"> {
	const { matches, contextValue, effectiveLimit, formatPath, getFileLines, getLineText, isAborted } = deps;
	let linesTruncated = false;
	const outputLines: string[] = [];

	const formatBlock = async (filePath: string, lineNumber: number, matchStart?: number): Promise<string[]> => {
		const relativePath = formatPath(filePath);
		const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
		const end = contextValue > 0 ? lineNumber + contextValue : lineNumber;
		let fileLines: string[] | null = null;
		const resolveLineText = async (current: number): Promise<string | undefined> => {
			const fromMap = getLineText?.(filePath, current);
			if (fromMap !== undefined) return fromMap;
			if (!fileLines) fileLines = await getFileLines(filePath);
			if (!fileLines.length) return undefined;
			return fileLines[current - 1];
		};
		const block: string[] = [];
		for (let current = start; current <= end; current++) {
			const lineText = await resolveLineText(current);
			if (lineText === undefined) {
				return [`${relativePath}:${lineNumber}: (unable to read file)`];
			}
			const sanitized = lineText.replace(/\r/g, "");
			const isMatchLine = current === lineNumber;
			const { text: truncatedText, wasTruncated } = truncateLine(
				sanitized,
				GREP_MAX_LINE_LENGTH,
				isMatchLine ? matchStart : undefined,
			);
			if (wasTruncated) linesTruncated = true;
			if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
			else block.push(`${relativePath}-${current}- ${truncatedText}`);
		}
		return block;
	};

	for (const match of matches) {
		if (isAborted()) return "aborted";
		if (contextValue === 0 && match.lineText !== undefined) {
			const relativePath = formatPath(match.filePath);
			const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
			const physicalLines = sanitized.split("\n");
			for (let li = 0; li < physicalLines.length; li++) {
				const { text: truncatedText, wasTruncated } = truncateLine(
					physicalLines[li] ?? "",
					GREP_MAX_LINE_LENGTH,
					li === 0 ? match.matchStart : undefined,
				);
				if (wasTruncated) linesTruncated = true;
				outputLines.push(`${relativePath}:${match.lineNumber + li}: ${truncatedText}`);
			}
		} else {
			const block = await formatBlock(match.filePath, match.lineNumber, match.matchStart);
			outputLines.push(...block);
		}
	}

	const rawOutput = outputLines.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;
	const details: GrepToolDetails = {};
	const notices: string[] = [];
	if (deps.matchLimitReached) {
		notices.push(
			`${effectiveLimit} matches limit reached. Use limit=${Math.min(MAX_LIMIT, effectiveLimit * 2)} for more, or refine pattern`,
		);
		details.matchLimitReached = effectiveLimit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		details.linesTruncated = true;
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
	return { output, details };
}

/**
 * Format a locate-style line list (files_with_matches paths, or "path:count"
 * rows) into the grep tool's output + details. Shared by the fff backend so its
 * files/count output matches the ripgrep locate path's truncation + limit
 * notices. The "files limit" wording mirrors rg's locate branch.
 */
function buildLocateOutput(
	lines: string[],
	effectiveLimit: number,
	matchLimitReached: boolean,
): { output: string; details: GrepToolDetails } {
	const rawList = lines.join("\n");
	const listTruncation = truncateHead(rawList, { maxLines: Number.MAX_SAFE_INTEGER });
	let output = listTruncation.content;
	const details: GrepToolDetails = {};
	const notices: string[] = [];
	if (matchLimitReached) {
		notices.push(
			`${effectiveLimit} files limit reached. Use limit=${Math.min(MAX_LIMIT, effectiveLimit * 2)} for more, or refine pattern`,
		);
		details.matchLimitReached = effectiveLimit;
	}
	if (listTruncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = listTruncation;
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
	return { output, details };
}

function formatGrepCall(
	args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	cwd?: string,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".", cwd) : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}

function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	const engine = options?.engine ?? "rg";
	return {
		name: "grep",
		activity: "navigation",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars. Set \`outputMode: "files_with_matches"\` to get just the matching file paths (cheapest — best for locating) or \`"count"\` for matches-per-file. Set \`multiline: true\` for patterns that span lines. Use \`grep\` for text, identifiers, or literal/regex string search. For structural code patterns (call sites, signatures, AST shape) use \`ast_grep\`. To find files by name use \`find\`. To jump to a symbol definition use \`symbol\`.`,
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		parameters: grepSchema,
		prepareArguments: prepareWithPathAliases,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				multiline,
				outputMode,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				multiline?: boolean;
				outputMode?: "content" | "files_with_matches" | "count";
				limit?: number;
			},
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						const rgPath = await ensureTool("rg", true);
						if (!rgPath) {
							settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
							return;
						}

						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}

						// Re-check after the awaits above (ensureTool can download rg over the
						// network — a long window; isDirectory can stat a slow NFS/SMB path). The
						// onAbort listener is registered only further down (after spawn), and
						// addEventListener with {once:true} does NOT replay an abort that already
						// fired during these awaits. Without this re-check, an ESC mid-setup is
						// dropped: `aborted` stays false, rg runs to completion, and the
						// `if (aborted)` close handler never rejects. Mirrors find.ts's re-checks.
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}

						const contextValue = context && context > 0 ? context : 0;
						const effectiveLimit = Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT));
						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = path.relative(searchPath, filePath);
								if (relative && !relative.startsWith("..")) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						const fileCache = new Map<string, string[]>();
						const getFileLines = async (filePath: string): Promise<string[]> => {
							let lines = fileCache.get(filePath);
							if (!lines) {
								try {
									// OOM guard: never buffer an oversized matched file for context.
									// rg's --max-filesize should already skip these, but a custom
									// backend may not — bail to [] so formatBlock emits the existing
									// "(unable to read file)" fallback instead of crashing the heap.
									const size = ops.fileSize ? await ops.fileSize(filePath) : 0;
									if (size > MAX_GREP_FILE_BYTES) {
										// Observe the OOM-guard skip (additive; behavior unchanged).
										recordDiagnostic({
											category: "output.cap",
											level: "info",
											source: "grep.fileSizeGuard",
											context: { path: filePath, bytes: size },
										});
										lines = [];
									} else {
										const content = await ops.readFile(filePath);
										lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
									}
								} catch {
									lines = [];
								}
								fileCache.set(filePath, lines);
							}
							return lines;
						};

						// fff backend: warm in-memory index. Engaged when opted in AND the
						// query is within fff's supported subset — content/files/count modes,
						// whole-repo OR a subdir/file inside cwd, simple glob / ignoreCase,
						// no multiline/custom-ops/.git scope. Every excluded case, and any fff
						// failure or unprovable-complete scoped scan, flows to ripgrep below.
						const fffMode = FFF_MODE_BY_OUTPUT[outputMode ?? "content"];
						const relToCwd = path.relative(cwd, searchPath);
						const withinCwd = relToCwd === "" || (!relToCwd.startsWith("..") && !path.isAbsolute(relToCwd));
						const insideGitScope = /[\\/]\.git([\\/]|$)/.test(searchPath);
						const simpleGlob = isSimpleGrepGlob(glob);
						const fffEligible =
							engine === "fff" &&
							!customOps &&
							!multiline &&
							(!glob || simpleGlob) &&
							!insideGitScope &&
							withinCwd;
						if (fffEligible) {
							const subPrefix = relToCwd === "" ? undefined : relToCwd.replace(/\\/g, "/");
							const fffRes = await fffSearch({
								basePath: cwd,
								pattern,
								mode: fffMode,
								literal,
								context: contextValue,
								limit: effectiveLimit,
								subPrefix,
								subExact: subPrefix !== undefined && !isDirectory,
								ignoreCase,
								globFilter: simpleGlob ? glob : undefined,
							});
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (fffRes) {
								const emitNoMatch = () =>
									settle(() =>
										resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }),
									);
								if (fffRes.mode === "content") {
									if (fffRes.matches.length === 0) {
										emitNoMatch();
										return;
									}
									const mapped: ContentMatch[] = fffRes.matches.map((m: FffContentMatch) => ({
										filePath: m.filePath,
										lineNumber: m.lineNumber,
										lineText: m.lineText,
										matchStart: byteOffsetToCharIndex(m.lineText, m.col),
									}));
									const built = await buildContentOutput({
										matches: mapped,
										contextValue,
										effectiveLimit,
										matchLimitReached: fffRes.capped,
										formatPath,
										getFileLines,
										isAborted: () => signal?.aborted ?? false,
									});
									if (built === "aborted") {
										settle(() => reject(new Error("Operation aborted")));
										return;
									}
									settle(() =>
										resolve({
											content: [{ type: "text", text: built.output }],
											details: nonEmptyDetails(built.details),
										}),
									);
									return;
								}
								// files_with_matches / count → locate-style line list.
								const locateLines =
									fffRes.mode === "files"
										? fffRes.files.map((fp) => formatPath(fp))
										: fffRes.counts.map((c) => `${formatPath(c.filePath)}:${c.count}`);
								if (locateLines.length === 0) {
									emitNoMatch();
									return;
								}
								const locate = buildLocateOutput(locateLines, effectiveLimit, fffRes.capped);
								settle(() =>
									resolve({
										content: [{ type: "text", text: locate.output }],
										details: nonEmptyDetails(locate.details),
									}),
								);
								return;
							}
							// fff unavailable/unsupported at runtime → fall through to ripgrep.
						}

						// --hidden is needed for dotfiles but also descends into .git/ (hundreds
						// of junk matches per repo: packed-refs, hooks, logs). rg matches globs
						// against the PRINTED path (which includes the search root), so the
						// negative glob must be skipped when the user explicitly roots the
						// search inside .git — it would otherwise exclude everything. A
						// user-supplied glob comes later and wins on conflict (rg's
						// last-match-wins precedence).
						const mode = outputMode ?? "content";
						const args: string[] = ["--color=never", "--hidden"];
						// content streams structured matches; the locate-only modes let rg do the
						// work natively (rg -l short-circuits per file; rg -c tallies in-engine) so
						// the model can find files without paying for every matching line.
						if (mode === "content") {
							args.push("--json", "--line-number");
							if (contextValue > 0) args.push("-C", String(contextValue));
							// Bound per-line bytes so a giant minified line doesn't spike the heap on
							// JSON.parse. --max-columns-preview keeps a leading slice so the match line
							// still renders (the output is truncated to GREP_MAX_LINE_LENGTH anyway).
							args.push("--max-columns", String(GREP_MAX_COLUMNS), "--max-columns-preview");
						} else if (mode === "files_with_matches") {
							args.push("--files-with-matches");
						} else {
							// --with-filename forces the `path:` prefix even when a single file is
							// searched (rg omits it otherwise), so the count output is always parseable.
							args.push("--count", "--with-filename");
						}
						// OOM/CPU guard: skip files above the ceiling at the rg source.
						args.push("--max-filesize", MAX_GREP_FILE_SIZE_ARG);
						if (!insideGitScope) args.push("--glob", "!**/.git/**");
						if (ignoreCase) args.push("--ignore-case");
						if (literal) args.push("--fixed-strings");
						if (multiline) args.push("--multiline", "--multiline-dotall");
						if (glob) args.push("--glob", glob);
						args.push("--", pattern, searchPath);

						const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						let aborted = false;
						let killedDueToLimit = false;
						const outputLines: string[] = [];
						// Raw rg lines for the files_with_matches / count modes (one per file).
						const plainLines: string[] = [];

						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", onAbort);
						};
						const stopChild = (dueToLimit = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};
						const onAbort = () => {
							aborted = true;
							stopChild();
						};
						signal?.addEventListener("abort", onAbort, { once: true });
						child.stderr?.on("data", (chunk) => {
							const before = stderr.length;
							stderr = appendCappedStderr(stderr, chunk.toString());
							// Record once, on the chunk that first saturates the cap.
							if (before < MAX_GREP_STDERR_BYTES && stderr.length >= MAX_GREP_STDERR_BYTES) {
								recordDiagnostic({
									category: "output.cap",
									level: "info",
									source: "grep.stderrCap",
									context: { bytes: MAX_GREP_STDERR_BYTES },
								});
							}
						});

						// Collect matches during streaming, then format them after rg exits.
						const matches: Array<{
							filePath: string;
							lineNumber: number;
							lineText?: string;
							matchStart?: number;
						}> = [];
						const rgLineTextByKey = new Map<string, string>();
						rl.on("line", (line) => {
							if (mode !== "content") {
								// files_with_matches / count: one rg line per file; limit caps files.
								if (!line.trim() || plainLines.length >= effectiveLimit) return;
								plainLines.push(line);
								if (plainLines.length >= effectiveLimit) {
									matchLimitReached = true;
									stopChild(true);
								}
								return;
							}
							if (!line.trim() || matchCount >= effectiveLimit) return;
							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}
							if (event.type === "match" || event.type === "context") {
								const filePath = event.data?.path?.text;
								const lineNumber = event.data?.line_number;
								const lineText = event.data?.lines?.text;
								if (filePath && typeof lineNumber === "number" && typeof lineText === "string") {
									rgLineTextByKey.set(grepLineKey(filePath, lineNumber), lineText);
								}
							}
							if (event.type === "match") {
								matchCount++;
								const filePath = event.data?.path?.text;
								const lineNumber = event.data?.line_number;
								const lineText = event.data?.lines?.text;
								// rg --json exposes submatch offsets (bytes into lines.text).
								// Carry the first match's start so a high-column match in a
								// long/minified line survives truncation centered on the term
								// instead of being sliced away at column 0.
								const firstSub = event.data?.submatches?.[0];
								const matchStart =
									lineText !== undefined && typeof firstSub?.start === "number"
										? byteOffsetToCharIndex(lineText, firstSub.start)
										: undefined;
								if (filePath && typeof lineNumber === "number")
									matches.push({ filePath, lineNumber, lineText, matchStart });
								if (matchCount >= effectiveLimit) {
									matchLimitReached = true;
									stopChild(true);
								}
							}
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});
						child.on("close", async (code) => {
							try {
								cleanup();
								if (aborted) {
									settle(() => reject(new Error("Operation aborted")));
									return;
								}
								if (!killedDueToLimit && code !== 0 && code !== 1) {
									const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
									// A regex-parse error means the PATTERN is malformed — a user
									// authoring mistake, not an empty result. Surfacing it as "No
									// matches found" (a success) made the model conclude the code was
									// absent or re-issue the same broken pattern, with no corrective
									// signal (a success result skips error-hint enrichment). Return an
									// actionable error so it can escape the metacharacters or set
									// literal:true (e.g. searching for "foo(", "a[i]", "1.2.3").
									if (/regex parse error/i.test(errorMsg)) {
										settle(() =>
											reject(
												new Error(
													`Invalid regex pattern: ${errorMsg}. If you meant to match this text ` +
														`literally (it contains regex metacharacters like ( ) [ ] . * + ? | \\ ), ` +
														`set literal: true.`,
												),
											),
										);
										return;
									}
									settle(() => reject(new Error(errorMsg)));
									return;
								}
								if (mode !== "content") {
									if (plainLines.length === 0) {
										const noMatch = glob?.includes("\\")
											? `No matches found. Glob patterns use forward slashes; try: ${glob.replace(/\\/g, "/")}`
											: "No matches found";
										settle(() => resolve({ content: [{ type: "text", text: noMatch }], details: undefined }));
										return;
									}
									for (const raw of plainLines) {
										const clean = raw.replace(/\r$/, "");
										if (mode === "files_with_matches") {
											outputLines.push(formatPath(clean));
										} else {
											// "path:count" — split on the trailing :<digits> so a Windows
											// drive-letter colon inside the path stays with the path.
											const parsed = /^(.*):(\d+)$/.exec(clean);
											outputLines.push(parsed ? `${formatPath(parsed[1])}:${parsed[2]}` : clean);
										}
									}
									const { output: listOutput, details: listDetails } = buildLocateOutput(
										outputLines,
										effectiveLimit,
										matchLimitReached,
									);
									settle(() =>
										resolve({
											content: [{ type: "text", text: listOutput }],
											details: nonEmptyDetails(listDetails),
										}),
									);
									return;
								}
								if (matchCount === 0) {
									// A user-supplied glob with a Windows-style backslash (e.g.
									// `src\**\*.ts`) goes raw to rg --glob, where "/" is the only path
									// separator and "\" is an escape — so it filters out everything and
									// returns zero matches with no hint. Enrich the empty message so the
									// model can self-correct; the success path stays untouched.
									const noMatch = glob?.includes("\\")
										? `No matches found. Glob patterns use forward slashes; try: ${glob.replace(/\\/g, "/")}`
										: "No matches found";
									settle(() => resolve({ content: [{ type: "text", text: noMatch }], details: undefined }));
									return;
								}

								const getRgLineText =
									contextValue > 0 && rgLineTextByKey.size > 0
										? (filePath: string, lineNumber: number) =>
												rgLineTextByKey.get(grepLineKey(filePath, lineNumber))
										: undefined;
								const built = await buildContentOutput({
									matches,
									contextValue,
									effectiveLimit,
									matchLimitReached,
									formatPath,
									getFileLines,
									getLineText: getRgLineText,
									isAborted: () => aborted || (signal?.aborted ?? false),
								});
								if (built === "aborted") {
									settle(() => reject(new Error("Operation aborted")));
									return;
								}
								settle(() =>
									resolve({
										content: [{ type: "text", text: built.output }],
										details: nonEmptyDetails(built.details),
									}),
								);
							} catch (err) {
								settle(() => reject(err instanceof Error ? err : new Error(String(err))));
							}
						});
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepCall(args, theme, context.cwd));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result, options, theme, context.showImages));
			return text;
		},
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
