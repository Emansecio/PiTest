import { createInterface } from "node:readline";
import type { AgentTool } from "@pit/agent-core";
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
import { resolveToCwd } from "./path-utils.js";
import { getTextOutput, invalidArgText, nonEmptyDetails, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

const findSchema = Type.Object(
	{
		pattern: Type.String({
			description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
		}),
		path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
	},
	{ additionalProperties: false },
);

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;

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
	return {
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Finds files by name/glob. Do NOT use \`grep\` to locate files by name; grep searches contents.`,
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
						const effectiveLimit = limit ?? DEFAULT_LIMIT;
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

							// Relativize paths against the search root for stable output.
							const relativized = results.map((p) => {
								if (p.startsWith(searchPath)) return toPosixPath(p.slice(searchPath.length + 1));
								return toPosixPath(path.relative(searchPath, p));
							});
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

						// Build fd arguments. --no-require-git makes fd apply hierarchical .gitignore
						// semantics whether or not the search path is inside a git repository, without
						// leaking sibling-directory rules the way --ignore-file (a global source) would.
						const args: string[] = [
							"--glob",
							"--color=never",
							"--hidden",
							"--no-require-git",
							"--max-results",
							String(effectiveLimit),
						];

						// fd --glob matches against the basename by default. For path-containing
						// patterns (e.g. `src/**/*.spec.ts`), fd's `--full-path` glob mode has
						// inconsistent behavior across platforms (fd 10.x on Windows fails to
						// match `**/`-style patterns reliably). We instead enumerate all files
						// from fd and post-filter with minimatch, which gives consistent
						// glob semantics on every OS.
						const usePostFilter = pattern.includes("/");
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
						const lines: string[] = [];

						stopChild = () => {
							if (!child.killed) {
								child.kill();
							}
						};

						const cleanup = () => {
							rl.close();
						};

						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						rl.on("line", (line) => {
							lines.push(line);
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
							const output = lines.join("\n");
							if (code !== 0) {
								const errorMsg = stderr.trim() || `fd exited with code ${code}`;
								if (!output) {
									settle(() => reject(new Error(errorMsg)));
									return;
								}
							}
							if (!output) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "No files found matching pattern" }],
										details: undefined,
									}),
								);
								return;
							}

							const relativized: string[] = [];
							const postFilterPattern = usePostFilter ? pattern : null;
							// Compile the glob ONCE, not once per result line. The convenience
							// `minimatch()` fn rebuilds a Minimatch (glob → AST → regex) on every
							// call, so post-filtering N≈1000 results meant up to ~2000 compiles.
							const postMatcher = postFilterPattern ? new Minimatch(postFilterPattern, { dot: true }) : null;
							for (const rawLine of lines) {
								const line = rawLine.replace(/\r$/, "").trim();
								if (!line) continue;
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
										continue;
									}
								}
								relativized.push(posixPath);
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
