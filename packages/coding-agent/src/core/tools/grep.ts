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
		limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
	},
	{ additionalProperties: false },
);

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;
// OOM guard: rg skips files above this on the source side (--max-filesize) and
// getFileLines refuses to buffer a matched file larger than this for context.
// Matching a pattern inside a giant lockfile / .min.js / dump would otherwise
// readFile the whole thing into the heap and crash the process. 10MB mirrors
// read.ts's STREAM_READ_MIN_BYTES.
const MAX_GREP_FILE_BYTES = 10 * 1024 * 1024;
const MAX_GREP_FILE_SIZE_ARG = "10M";
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

/** Append a stderr chunk while retaining at most the leading MAX_GREP_STDERR_BYTES. */
export function appendCappedStderr(current: string, chunk: string): string {
	if (current.length >= MAX_GREP_STDERR_BYTES) return current;
	return (current + chunk).slice(0, MAX_GREP_STDERR_BYTES);
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

						const contextValue = context && context > 0 ? context : 0;
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
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

						// --hidden is needed for dotfiles but also descends into .git/ (hundreds
						// of junk matches per repo: packed-refs, hooks, logs). rg matches globs
						// against the PRINTED path (which includes the search root), so the
						// negative glob must be skipped when the user explicitly roots the
						// search inside .git — it would otherwise exclude everything. A
						// user-supplied glob comes later and wins on conflict (rg's
						// last-match-wins precedence).
						const insideGitDir = /[\\/]\.git([\\/]|$)/.test(searchPath);
						const mode = outputMode ?? "content";
						const args: string[] = ["--color=never", "--hidden"];
						// content streams structured matches; the locate-only modes let rg do the
						// work natively (rg -l short-circuits per file; rg -c tallies in-engine) so
						// the model can find files without paying for every matching line.
						if (mode === "content") {
							args.push("--json", "--line-number");
						} else if (mode === "files_with_matches") {
							args.push("--files-with-matches");
						} else {
							// --with-filename forces the `path:` prefix even when a single file is
							// searched (rg omits it otherwise), so the count output is always parseable.
							args.push("--count", "--with-filename");
						}
						// OOM/CPU guard: skip files above the ceiling at the rg source.
						args.push("--max-filesize", MAX_GREP_FILE_SIZE_ARG);
						if (!insideGitDir) args.push("--glob", "!**/.git/**");
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
						let linesTruncated = false;
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

						const formatBlock = async (
							filePath: string,
							lineNumber: number,
							matchStart?: number,
						): Promise<string[]> => {
							const relativePath = formatPath(filePath);
							const lines = await getFileLines(filePath);
							if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
							const block: string[] = [];
							const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
							const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
							for (let current = start; current <= end; current++) {
								const lineText = lines[current - 1] ?? "";
								const sanitized = lineText.replace(/\r/g, "");
								const isMatchLine = current === lineNumber;
								// Truncate long lines so grep output stays compact. Center the
								// window on the match for the match line so a high-column hit
								// is not elided; context lines keep head truncation.
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

						// Collect matches during streaming, then format them after rg exits.
						const matches: Array<{
							filePath: string;
							lineNumber: number;
							lineText?: string;
							matchStart?: number;
						}> = [];
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
								const rawList = outputLines.join("\n");
								const listTruncation = truncateHead(rawList, { maxLines: Number.MAX_SAFE_INTEGER });
								let listOutput = listTruncation.content;
								const listDetails: GrepToolDetails = {};
								const listNotices: string[] = [];
								if (matchLimitReached) {
									listNotices.push(
										`${effectiveLimit} files limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
									);
									listDetails.matchLimitReached = effectiveLimit;
								}
								if (listTruncation.truncated) {
									listNotices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
									listDetails.truncation = listTruncation;
								}
								if (listNotices.length > 0) listOutput += `\n\n[${listNotices.join(". ")}]`;
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

							// Format matches after streaming finishes so custom readFile() backends can be async.
							for (const match of matches) {
								if (contextValue === 0 && match.lineText !== undefined) {
									const relativePath = formatPath(match.filePath);
									const sanitized = match.lineText
										.replace(/\r\n/g, "\n")
										.replace(/\r/g, "")
										.replace(/\n$/, "");
									const { text: truncatedText, wasTruncated } = truncateLine(
										sanitized,
										GREP_MAX_LINE_LENGTH,
										match.matchStart,
									);
									if (wasTruncated) linesTruncated = true;
									outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
								} else {
									const block = await formatBlock(match.filePath, match.lineNumber, match.matchStart);
									outputLines.push(...block);
								}
							}

							const rawOutput = outputLines.join("\n");
							// Apply byte truncation. There is no line limit here because the match limit already capped rows.
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let output = truncation.content;
							const details: GrepToolDetails = {};
							// Build actionable notices for truncation and match limits.
							const notices: string[] = [];
							if (matchLimitReached) {
								notices.push(
									`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.matchLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (linesTruncated) {
								notices.push(
									`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
								);
								details.linesTruncated = true;
							}
							if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
							settle(() =>
								resolve({
									content: [{ type: "text", text: output }],
									details: nonEmptyDetails(details),
								}),
							);
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
