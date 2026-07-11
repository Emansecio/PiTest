import { createInterface } from "node:readline";
import type { AgentTool, AgentToolResult } from "@pit/agent-core";
import { recordDiagnostic } from "@pit/ai";
import { Text } from "@pit/tui";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { Minimatch } from "minimatch";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { ensureTool } from "../../utils/tools-manager.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { prepareWithPathAliases } from "./argument-prep.js";
import { capAppend, fffFindByGlob, isGitWorkTree } from "./fff-search.js";
import { resolveToCwd } from "./path-utils.js";
import { getTextOutput, invalidArgText, nonEmptyDetails, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import {
	DEFAULT_MAX_BYTES,
	effectiveDefaultMaxBytes,
	formatSize,
	getOccupancyScale,
	type TruncationResult,
	truncateHead,
} from "./truncate.js";

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

const findSchema = Type.Object(
	{
		pattern: Type.String({
			description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
		}),
		path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
		limit: Type.Optional(
			Type.Number({
				description: "Maximum number of results (default scales with context occupancy, ceiling 500)",
			}),
		),
	},
	{ additionalProperties: false },
);

export type FindToolInput = Static<typeof findSchema>;

/** Hard ceiling for the occupancy-scaled default; explicit model `limit` is not scaled. */
export const FIND_DEFAULT_LIMIT_CEILING = 500;
/** Minimum default retained when occupancy scales the find limit down. */
export const FIND_DEFAULT_LIMIT_FLOOR = 100;

/** Effective default result limit after occupancy scaling (explicit `limit` bypasses this). */
export function effectiveFindDefaultLimit(): number {
	return Math.max(FIND_DEFAULT_LIMIT_FLOOR, Math.round(FIND_DEFAULT_LIMIT_CEILING * getOccupancyScale()));
}
// Enumeration ceiling for the post-filter path: fd's --max-results caps the
// ENUMERATION (pre-minimatch), not the matches, so it must sit far above any
// realistic result limit or real matches get silently dropped in large trees.
const FD_POST_FILTER_ENUM_CAP = 100_000;
// Cap retained fd stderr so a tree spewing permission/diagnostic warnings can't
// grow memory unbounded. Mirrors the LSP's MAX_STDERR_BYTES. We keep the HEAD,
// not the tail: stderr is consumed once as the error message and the first line
// carries the actionable failure.
const MAX_FIND_STDERR_BYTES = 64 * 1024;

/** Append a stderr chunk while retaining at most the leading MAX_FIND_STDERR_BYTES.
 * Kept as its own export (not inlined) so find's byte ceiling stays a fixed,
 * testable 2-arg seam — exercised directly by find-grep-git-and-postfilter.test.ts. */
export function appendCappedStderr(current: string, chunk: string): string {
	return capAppend(current, chunk, MAX_FIND_STDERR_BYTES);
}

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export interface FindOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Find files matching glob pattern. Returns relative or absolute paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultFindOperations: FindOperations = {
	exists: existsSync,
	// This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
	glob: () => [],
};

export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem plus fd */
	operations?: FindOperations;
	/** Search backend. `"fff"` uses the warm in-memory index with fd fallback
	 * (git work tree required — outside git, falls through to fd). */
	engine?: "fd" | "fff";
}

function formatFindCall(
	args: { pattern: string; path?: string; limit?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	cwd?: string,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".", cwd) : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("find")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

function finalizeFindResults(
	relativized: string[],
	effectiveLimit: number,
	enumerationSaturated = false,
): AgentToolResult<FindToolDetails | undefined> {
	if (relativized.length === 0) {
		return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
	}
	const resultLimitReached = relativized.length >= effectiveLimit;
	const rawOutput = relativized.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	let resultOutput = truncation.content;
	const details: FindToolDetails = {};
	const notices: string[] = [];
	if (resultLimitReached) {
		notices.push(
			`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
		);
		details.resultLimitReached = effectiveLimit;
	} else if (enumerationSaturated) {
		notices.push(
			`enumeration cap of ${FD_POST_FILTER_ENUM_CAP} files reached before filtering; matches may be missing — narrow the search directory`,
		);
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (notices.length > 0) {
		resultOutput += `\n\n[${notices.join(". ")}]`;
	}
	return {
		content: [{ type: "text", text: resultOutput }],
		details: nonEmptyDetails(details),
	};
}

function filterFffPathsForFind(
	indexedPaths: string[],
	pattern: string,
	searchPath: string,
	cwd: string,
	effectiveLimit: number,
): string[] {
	const usePostFilter = pattern.includes("/");
	const postMatcher = usePostFilter ? new Minimatch(pattern, { dot: true }) : null;
	const basenameMatcher = usePostFilter ? null : new Minimatch(pattern, { dot: true, matchBase: true });
	const relativized: string[] = [];
	for (const relFromCwd of indexedPaths) {
		const abs = path.resolve(cwd, relFromCwd);
		const relativePath = path.relative(searchPath, abs);
		if (relativePath.startsWith("..")) continue;
		const posixPath = toPosixPath(relativePath);
		if (postMatcher) {
			if (!postMatcher.match(posixPath) && !postMatcher.match(posixPath.replace(/\/$/, ""))) continue;
		} else if (basenameMatcher && !basenameMatcher.match(posixPath)) {
			continue;
		}
		relativized.push(posixPath);
		if (relativized.length >= effectiveLimit) break;
	}
	return relativized;
}

async function tryFindViaFff(
	cwd: string,
	searchPath: string,
	pattern: string,
	effectiveLimit: number,
): Promise<AgentToolResult<FindToolDetails | undefined> | null> {
	// Outside a git work tree fff drops dotfiles and its watcher goes stale —
	// fall through to fd (which matches --hidden + live tree semantics).
	if (!isGitWorkTree(cwd)) return null;
	const relToCwd = path.relative(cwd, searchPath);
	const withinCwd = relToCwd === "" || (!relToCwd.startsWith("..") && !path.isAbsolute(relToCwd));
	if (!withinCwd) return null;
	const subPrefix = relToCwd === "" ? undefined : relToCwd.replace(/\\/g, "/");
	const usePostFilter = pattern.includes("/");
	const globPattern = usePostFilter ? "*" : pattern;
	const matched = await fffFindByGlob({
		basePath: cwd,
		pattern: globPattern,
		subPrefix,
		limit: usePostFilter ? FD_POST_FILTER_ENUM_CAP : effectiveLimit,
	});
	if (!matched) return null;
	let relativized: string[];
	if (usePostFilter) {
		relativized = filterFffPathsForFind(matched, pattern, searchPath, cwd, effectiveLimit);
	} else {
		relativized = [];
		for (const relFromCwd of matched) {
			const abs = path.resolve(cwd, relFromCwd);
			const relativePath = path.relative(searchPath, abs);
			if (relativePath.startsWith("..")) continue;
			relativized.push(toPosixPath(relativePath));
			if (relativized.length >= effectiveLimit) break;
		}
	}
	if (relativized.length === 0) {
		const noMatch = pattern.includes("\\")
			? `No files found matching pattern. Glob patterns use forward slashes; try: ${pattern.replace(/\\/g, "/")}`
			: "No files found matching pattern";
		return { content: [{ type: "text", text: noMatch }], details: undefined };
	}
	const enumerationSaturated =
		usePostFilter && relativized.length < effectiveLimit && matched.length >= FD_POST_FILTER_ENUM_CAP;
	return finalizeFindResults(relativized, effectiveLimit, enumerationSaturated);
}

function formatFindResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: FindToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}

	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	if (resultLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	const customOps = options?.operations;
	const engine = options?.engine ?? "fd";
	return {
		name: "find",
		activity: "navigation",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${effectiveFindDefaultLimit()} results by default (up to ${FIND_DEFAULT_LIMIT_CEILING}, scales down under high context occupancy) or ${Math.round(effectiveDefaultMaxBytes() / 1024)}KB (whichever is hit first). Finds files by name/glob. Do NOT use \`grep\` to locate files by name; grep searches contents.`,
		promptSnippet: "Find files by glob pattern (respects .gitignore)",
		parameters: findSchema,
		prepareArguments: prepareWithPathAliases,
		async execute(
			_toolCallId,
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
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
				let stopChild: (() => void) | undefined;
				const settle = (fn: () => void) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					stopChild = undefined;
					fn();
				};
				const onAbort = () => {
					stopChild?.();
					settle(() => reject(new Error("Operation aborted")));
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const effectiveLimit = limit ?? effectiveFindDefaultLimit();
						const ops = customOps ?? defaultFindOperations;

						// If custom operations provide glob(), use that instead of fd.
						if (customOps?.glob) {
							if (!(await ops.exists(searchPath))) {
								settle(() => reject(new Error(`Path not found: ${searchPath}`)));
								return;
							}
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							const results = await ops.glob(pattern, searchPath, {
								ignore: ["**/node_modules/**", "**/.git/**"],
								limit: effectiveLimit,
							});
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (results.length === 0) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "No files found matching pattern" }],
										details: undefined,
									}),
								);
								return;
							}

							// Relativize paths against the search root for stable output. Drop an
							// empty result (the search root itself relativizes to ""), which would
							// otherwise emit a blank line and count toward the result limit.
							const relativized = results
								.map((p) => {
									if (p.startsWith(searchPath)) return toPosixPath(p.slice(searchPath.length + 1));
									return toPosixPath(path.relative(searchPath, p));
								})
								.filter((rel) => rel.length > 0);
							const resultLimitReached = relativized.length >= effectiveLimit;
							const rawOutput = relativized.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];
							if (resultLimitReached) {
								notices.push(`${effectiveLimit} results limit reached`);
								details.resultLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}
							settle(() =>
								resolve({
									content: [{ type: "text", text: resultOutput }],
									details: nonEmptyDetails(details),
								}),
							);
							return;
						}

						if (engine === "fff" && !customOps?.glob) {
							const fffResult = await tryFindViaFff(cwd, searchPath, pattern, effectiveLimit);
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (fffResult) {
								settle(() => resolve(fffResult));
								return;
							}
						}

						// Default implementation uses fd.
						const fdPath = await ensureTool("fd", true);
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						if (!fdPath) {
							settle(() => reject(new Error("fd is not available and could not be downloaded")));
							return;
						}

						// fd --glob matches against the basename by default. For path-containing
						// patterns (e.g. `src/**/*.spec.ts`), fd's `--full-path` glob mode has
						// inconsistent behavior across platforms (fd 10.x on Windows fails to
						// match `**/`-style patterns reliably). We instead enumerate all files
						// from fd and post-filter with minimatch, which gives consistent
						// glob semantics on every OS.
						const usePostFilter = pattern.includes("/");

						// Build fd arguments. --no-require-git makes fd apply hierarchical .gitignore
						// semantics whether or not the search path is inside a git repository, without
						// leaking sibling-directory rules the way --ignore-file (a global source) would.
						// --exclude .git: --hidden is needed for dotfiles but also descends into
						// .git/ (hundreds of junk paths per repo); searches rooted INSIDE .git still
						// work because the exclusion never matches the traversal root's children.
						// On the post-filter path --max-results must cap the enumeration, not the
						// result count, so it uses the high internal ceiling.
						const args: string[] = [
							"--glob",
							"--color=never",
							"--hidden",
							"--no-require-git",
							"--exclude",
							".git",
							"--max-results",
							String(usePostFilter ? FD_POST_FILTER_ENUM_CAP : effectiveLimit),
						];
						let effectivePattern = pattern;
						if (usePostFilter) {
							// Replace the fd-side pattern with a wildcard so fd just enumerates,
							// then post-filter results against the original pattern.
							effectivePattern = "*";
						}
						args.push("--", effectivePattern, searchPath);

						const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						// Filter + relativize INLINE as fd streams, instead of buffering up to
						// FD_POST_FILTER_ENUM_CAP (100k) raw paths and filtering at close. Compile
						// the glob ONCE here (the convenience `minimatch()` rebuilds the matcher per
						// call). Once `limit` matches land we kill fd early — same first-N result.
						const relativized: string[] = [];
						let enumeratedCount = 0;
						let limitReached = false;
						let killedDueToLimit = false;
						const postMatcher = usePostFilter ? new Minimatch(pattern, { dot: true }) : null;

						stopChild = () => {
							if (!child.killed) {
								child.kill();
							}
						};

						const cleanup = () => {
							rl.close();
						};

						child.stderr?.on("data", (chunk) => {
							const before = stderr.length;
							stderr = appendCappedStderr(stderr, chunk.toString());
							// Record once, on the chunk that first saturates the cap.
							if (before < MAX_FIND_STDERR_BYTES && stderr.length >= MAX_FIND_STDERR_BYTES) {
								recordDiagnostic({
									category: "output.cap",
									level: "info",
									source: "find.stderrCap",
									context: { bytes: MAX_FIND_STDERR_BYTES },
								});
							}
						});

						rl.on("line", (rawLine) => {
							if (limitReached) return;
							enumeratedCount++;
							const line = rawLine.replace(/\r$/, "").trim();
							if (!line) return;
							const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
							let relativePath = line;
							if (line.startsWith(searchPath)) {
								relativePath = line.slice(searchPath.length + 1);
							} else {
								relativePath = path.relative(searchPath, line);
							}
							if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
							const posixPath = toPosixPath(relativePath);
							if (postMatcher) {
								// Match the relative posix path against the user pattern.
								// `matchBase: false`, `dot: true` so hidden segments aren't rejected.
								if (!postMatcher.match(posixPath) && !postMatcher.match(posixPath.replace(/\/$/, ""))) {
									return;
								}
							}
							relativized.push(posixPath);
							if (relativized.length >= effectiveLimit) {
								limitReached = true;
								killedDueToLimit = true;
								stopChild?.();
							}
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run fd: ${error.message}`)));
						});

						child.on("close", (code) => {
							cleanup();
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							// We kill fd ourselves once `limit` matches land, which surfaces as a
							// non-zero exit — that is success, not failure. A genuine fd error is a
							// non-zero exit with zero matches collected.
							if (code !== 0 && !killedDueToLimit && relativized.length === 0) {
								settle(() => reject(new Error(stderr.trim() || `fd exited with code ${code}`)));
								return;
							}
							if (relativized.length === 0) {
								// Glob patterns are forward-slash only. A Windows-style backslash
								// pattern (e.g. `src\**\*.ts`) has no "/", skips the post-filter, and
								// goes raw to fd --glob where "\" is an escape — yielding zero matches
								// with no hint about the separator. Enrich the empty message so the
								// model can self-correct without normalizing the success path.
								const noMatch = pattern.includes("\\")
									? `No files found matching pattern. Glob patterns use forward slashes; try: ${pattern.replace(/\\/g, "/")}`
									: "No files found matching pattern";
								settle(() =>
									resolve({
										content: [{ type: "text", text: noMatch }],
										details: undefined,
									}),
								);
								return;
							}

							const resultLimitReached = relativized.length >= effectiveLimit;
							const enumerationSaturated =
								usePostFilter && !resultLimitReached && enumeratedCount >= FD_POST_FILTER_ENUM_CAP;
							settle(() => resolve(finalizeFindResults(relativized, effectiveLimit, enumerationSaturated)));
							return;
						});
					} catch (e) {
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						const error = e instanceof Error ? e : new Error(String(e));
						settle(() => reject(error));
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindCall(args, theme, context.cwd));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindResult(result, options, theme, context.showImages));
			return text;
		},
	};
}

export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
