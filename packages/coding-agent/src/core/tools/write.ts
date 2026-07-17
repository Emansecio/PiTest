import type { AgentTool } from "@pit/agent-core";
import { Container, Text } from "@pit/tui";
import { mkdir as fsMkdir, stat as fsStat } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import { getLanguageFromPath, highlightCode } from "../../modes/interactive/theme/theme.js";
import { writeFileAtomic } from "../../utils/atomic-write.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { attachPostWriteDiagnostics, capturePreWriteDiagnostics, maybeFormat } from "../lsp/writethrough.ts";
import { getCurrentPreviewQueue } from "../preview-queue.ts";
import { getUrlSchemeRegistry } from "../url-schemes/index.ts";
import { applyKeyAliases, PATH_KEY_ALIASES } from "./argument-prep.js";
import { type FileMtimeStore, refreshFileMtime } from "./file-mtime-store.ts";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { attachOmissionWarning } from "./lazy-omission-attach.ts";
import { resolveToCwd } from "./path-utils.js";
import {
	getFilePathArg,
	invalidArgText,
	normalizeDisplayText,
	replaceTabs,
	shortenPath,
	str,
	trimTrailingEmptyLines,
} from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const writeSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
		content: Type.String({ description: "Content to write to the file" }),
		preview: Type.Optional(
			Type.Boolean({
				description: "When true, stage as a preview rather than applying. Use the resolve tool to commit.",
			}),
		),
	},
	{ additionalProperties: false },
);

// `text`/`body` aliases are common when LLMs confuse write with the create-file
// shape from other harnesses. They are write-specific, so we keep them out of
// PATH_KEY_ALIASES and merge them only here.
const WRITE_KEY_ALIASES = {
	...PATH_KEY_ALIASES,
	text: "content",
	body: "content",
	data: "content",
} as const;

function prepareWriteArguments(input: unknown): WriteToolInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input as WriteToolInput;
	return applyKeyAliases(input as Record<string, unknown>, WRITE_KEY_ALIASES) as WriteToolInput;
}

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file. `signal` lets an atomic impl honor abort up to the rename. */
	writeFile: (absolutePath: string, content: string, signal?: AbortSignal) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
	// Atomic (temp + rename): a concurrent `read` never sees a partially-written
	// file, and an abort before the rename leaves any existing file untouched.
	writeFile: (path, content, signal) => writeFileAtomic(path, content, signal),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
	/**
	 * Optional per-session mtime store (shared with read/edit). When present, a
	 * successful write refreshes the recorded mtime so a later edit's stale-read
	 * check doesn't flag our own write as an external change.
	 */
	mtimeStore?: FileMtimeStore;
}

type WriteHighlightCache = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
};

class WriteCallRenderComponent extends Text {
	cache?: WriteHighlightCache;

	constructor() {
		super("", 0, 0);
	}
}

const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

function highlightSingleLine(line: string, lang: string): string {
	const highlighted = highlightCode(line, lang);
	return highlighted[0] ?? "";
}

function refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
	const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
	if (prefixCount === 0) return;
	const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
	const prefixHighlighted = highlightCode(prefixSource, cache.lang);
	for (let i = 0; i < prefixCount; i++) {
		cache.highlightedLines[i] =
			prefixHighlighted[i] ?? highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
	}
}

function rebuildWriteHighlightCacheFull(rawPath: string | null, fileContent: string): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	const displayContent = normalizeDisplayText(fileContent);
	const normalized = replaceTabs(displayContent);
	return {
		rawPath,
		lang,
		rawContent: fileContent,
		normalizedLines: normalized.split("\n"),
		highlightedLines: highlightCode(normalized, lang),
	};
}

function updateWriteHighlightCacheIncremental(
	cache: WriteHighlightCache | undefined,
	rawPath: string | null,
	fileContent: string,
): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	if (!cache) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (cache.lang !== lang || cache.rawPath !== rawPath) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (!fileContent.startsWith(cache.rawContent)) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (fileContent.length === cache.rawContent.length) return cache;

	const deltaRaw = fileContent.slice(cache.rawContent.length);
	const deltaDisplay = normalizeDisplayText(deltaRaw);
	const deltaNormalized = replaceTabs(deltaDisplay);
	cache.rawContent = fileContent;
	if (cache.normalizedLines.length === 0) {
		cache.normalizedLines.push("");
		cache.highlightedLines.push("");
	}

	const segments = deltaNormalized.split("\n");
	const lastIndex = cache.normalizedLines.length - 1;
	cache.normalizedLines[lastIndex] += segments[0];
	cache.highlightedLines[lastIndex] = highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);
	for (let i = 1; i < segments.length; i++) {
		cache.normalizedLines.push(segments[i]);
		cache.highlightedLines.push(highlightSingleLine(segments[i], cache.lang));
	}
	refreshWriteHighlightPrefix(cache);
	return cache;
}

function formatWriteCall(
	args: { path?: string; file_path?: string; content?: string } | undefined,
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	cache: WriteHighlightCache | undefined,
	cwd?: string,
): string {
	const rawPath = getFilePathArg(args);
	const fileContent = str(args?.content);
	const path = rawPath !== null ? shortenPath(rawPath, cwd) : null;
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold("write"))} ${path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...")}`;

	if (fileContent === null) {
		text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
	} else if (fileContent && options.expanded) {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const renderedLines = lang
			? (cache?.highlightedLines ?? highlightCode(replaceTabs(normalizeDisplayText(fileContent)), lang))
			: normalizeDisplayText(fileContent).split("\n");
		const lines = trimTrailingEmptyLines(renderedLines);
		text += `\n\n${lines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	}

	return text;
}

function formatWriteResult(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean },
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
): string | undefined {
	if (!result.isError) {
		return undefined;
	}
	const output = result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text || "")
		.join("\n");
	if (!output) {
		return undefined;
	}
	return `\n${theme.fg("error", output)}`;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, undefined> {
	const ops = options?.operations ?? defaultWriteOperations;
	const mtimeStore = options?.mtimeStore;
	return {
		name: "write",
		label: "write",
		description:
			'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does. Automatically creates parent directories.\n\nRIGHT: { "path": "foo.ts", "content": "..." }\n\n- Use write only for new files or full rewrites (use "edit" for small changes); include a trailing newline if the file convention expects one.',
		promptSnippet: "Create or overwrite files",
		promptGuidelines: ["Use write only for new files or complete rewrites."],
		parameters: writeSchema,
		prepareArguments: prepareWriteArguments,
		async execute(
			_toolCallId,
			{ path, content, preview }: { path: string; content: string; preview?: boolean },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			// URL-scheme dispatch: virtual paths route through the scheme registry.
			const schemeMatch = getUrlSchemeRegistry().parse(path);
			if (schemeMatch) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const { resolver, url } = schemeMatch;
				if (!resolver.canWrite?.(url) || !resolver.write) {
					throw new Error(`Scheme '${resolver.scheme}' does not support write.`);
				}
				await resolver.write(url, content, { cwd, signal });
				return {
					content: [{ type: "text" as const, text: `Successfully wrote ${content.length} bytes to ${path}.` }],
					details: undefined,
				};
			}
			const absolutePath = resolveToCwd(path, cwd);
			const dir = dirname(absolutePath);

			// Preview mode: stage instead of writing to disk.
			const queue = getCurrentPreviewQueue();
			if (preview === true && queue) {
				if (signal?.aborted) throw new Error("Operation aborted");
				// Snapshot the mtime this preview is staged against (undefined for a
				// brand-new file — nothing to drift from), so apply() (run later, from
				// `resolve`) can detect the file changing between staging and commit
				// and refuse to blindly clobber it instead of silently discarding that
				// external change.
				let stagedMtimeMs: number | undefined;
				if (ops === defaultWriteOperations) {
					try {
						stagedMtimeMs = (await fsStat(absolutePath)).mtimeMs;
					} catch {
						// File doesn't exist yet (or unreadable) — nothing to drift from.
					}
				}
				const item = queue.add({
					kind: "write",
					path,
					apply: async () => {
						await withFileMutationQueue(
							absolutePath,
							async () => {
								if (ops === defaultWriteOperations && stagedMtimeMs !== undefined) {
									const curStat = await fsStat(absolutePath).catch(() => undefined);
									if (curStat && curStat.mtimeMs !== stagedMtimeMs) {
										throw new Error(
											`Cannot apply preview: ${path} changed on disk since this write was staged. Re-run write to overwrite the current file, or use edit to merge changes.`,
										);
									}
								}
								await ops.mkdir(dir);
								// Format at commit exactly as the direct-write path does, so the bytes
								// landed by a previewed write match a non-previewed one (no signal: the
								// commit runs later in the resolve lifecycle, not the staging one).
								const formatted = await maybeFormat(absolutePath, content, cwd);
								await ops.writeFile(absolutePath, formatted.content);
								await refreshFileMtime(mtimeStore, absolutePath);
							},
							{ snapshot: { tool: "write" } },
						);
					},
					summary: {
						description: `write ${path}: ${content.length} bytes`,
					},
				});
				return {
					content: [{ type: "text" as const, text: `Preview staged. id=${item.id}. Use resolve to commit.` }],
					details: undefined,
				};
			}

			let __written: string | undefined;
			const diagnosticsBaseline = await capturePreWriteDiagnostics(absolutePath, cwd, signal);
			const writeResult = await withFileMutationQueue(
				absolutePath,
				() =>
					new Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }>(
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
									// Stale-write note: if the file changed on disk since the model
									// last observed it this session (a read, or one of our own prior
									// write/edit commits), the overwrite still lands, but content the
									// model wasn't shown is about to be discarded — flag it. Mirrors
									// edit's staleNote; non-fatal, doesn't block the write.
									let staleNote = "";
									if (ops === defaultWriteOperations && mtimeStore) {
										const seenMtime = mtimeStore.get(absolutePath);
										if (seenMtime !== undefined) {
											try {
												const curStat = await fsStat(absolutePath);
												if (curStat.mtimeMs !== seenMtime) {
													staleNote = ` NOTE: ${path} changed on disk since you last observed it this session — the overwrite replaced content you weren't shown; re-read first if that wasn't intended.`;
												}
											} catch {
												// stat failed (e.g. file doesn't exist yet) — no note.
											}
										}
									}

									// Create parent directories if needed.
									await ops.mkdir(dir);
									if (aborted) return;
									// Write the file contents.
									const formatted = await maybeFormat(absolutePath, content, cwd, signal);
									await ops.writeFile(absolutePath, formatted.content, signal);
									// Committed (atomic rename): stop honoring abort so a late ESC
									// can't reject a write that already landed. A pre-commit abort
									// throws from writeFile and is caught below with disk intact.
									__written = formatted.content;
									await refreshFileMtime(mtimeStore, absolutePath);
									signal?.removeEventListener("abort", onAbort);
									resolve({
										content: [
											{
												type: "text",
												text: `Successfully wrote ${formatted.content.length} bytes to ${path}${formatted.formatted ? " (formatted)" : ""}.${staleNote}`,
											},
										],
										details: undefined,
									});
								} catch (error: any) {
									signal?.removeEventListener("abort", onAbort);
									if (!aborted) reject(error);
								}
							})();
						},
					),
				{ snapshot: { tool: "write" } },
			);
			const diagResult = await attachPostWriteDiagnostics(
				writeResult,
				absolutePath,
				__written,
				cwd,
				signal,
				diagnosticsBaseline,
			);
			// New file / full overwrite: no prior content to diff against, so any
			// elision placeholder in the written body is suspect — pass "" as base.
			return attachOmissionWarning(diagResult, absolutePath, "", __written, cwd);
		},
		renderCall(args, theme, context) {
			const renderArgs = args as { path?: string; file_path?: string; content?: string } | undefined;
			const rawPath = getFilePathArg(renderArgs);
			const fileContent = str(renderArgs?.content);
			const component =
				(context.lastComponent as WriteCallRenderComponent | undefined) ?? new WriteCallRenderComponent();
			if (fileContent !== null && context.expanded) {
				component.cache = context.argsComplete
					? rebuildWriteHighlightCacheFull(rawPath, fileContent)
					: updateWriteHighlightCacheIncremental(component.cache, rawPath, fileContent);
			} else {
				component.cache = undefined;
			}
			component.setText(
				formatWriteCall(
					renderArgs,
					{ expanded: context.expanded, isPartial: context.isPartial },
					theme,
					component.cache,
					context.cwd,
				),
			);
			return component;
		},
		renderResult(result, _options, theme, context) {
			const output = formatWriteResult({ ...result, isError: context.isError }, theme);
			if (!output) {
				const component = (context.lastComponent as Container | undefined) ?? new Container();
				component.clear();
				return component;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(output);
			return text;
		},
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
