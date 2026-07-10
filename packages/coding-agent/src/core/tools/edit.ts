import type { AgentTool } from "@pit/agent-core";
import { type Box, Container, Spacer, Text } from "@pit/tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { type Static, Type } from "typebox";
import { renderDiff } from "../../modes/interactive/components/diff.js";
import { writeFileAtomic } from "../../utils/atomic-write.ts";
import type { ToolDefinition } from "../extensions/types.js";
import { attachPostWriteDiagnostics, capturePreWriteDiagnostics } from "../lsp/writethrough.ts";
import { getCurrentPreviewQueue } from "../preview-queue.ts";
import { applyKeyAliases, coerceJsonArrayField, EDIT_KEY_ALIASES, PATH_KEY_ALIASES } from "./argument-prep.js";
import {
	applyEditsToNormalizedContent,
	computeEditsDiffWithBaseCache,
	detectLineEnding,
	type Edit,
	type EditDiffError,
	type EditDiffResult,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import {
	buildEditToolCallComponent,
	createEditCallComponentBase,
	type EditDiffMemoTarget,
	getOrCreateEditCallComponent,
	setEditPreview,
} from "./edit-preview-shared.ts";
import { type FileMtimeStore, refreshFileMtime } from "./file-mtime-store.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { attachOmissionWarning } from "./lazy-omission-attach.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getFilePathArg } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

type EditPreview = EditDiffResult | EditDiffError;

type EditRenderState = {
	callComponent?: EditCallRenderComponent;
};

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file (unless replaceAll is true) and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
		replaceAll: Type.Optional(
			Type.Boolean({
				description:
					"Replace EVERY occurrence of oldText instead of requiring it to be unique (default false). Use for renames where the same identifier appears many times.",
			}),
		),
	},
	{ additionalProperties: false },
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
		preview: Type.Optional(
			Type.Boolean({
				description: "When true, stage as a preview rather than applying. Use the resolve tool to commit.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

export interface EditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/**
	 * Write content to a file. The optional `signal` lets an atomic implementation
	 * honor abort up to its commit point (see writeFileAtomic): an abort before the
	 * rename leaves the original untouched.
	 */
	writeFile: (absolutePath: string, content: string, signal?: AbortSignal) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

export const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	// Atomic (temp + rename): a concurrent `read` of the same path never sees a
	// half-written file, and an abort before the rename leaves the original intact.
	writeFile: (path, content, signal) => writeFileAtomic(path, content, signal),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
	/**
	 * Optional per-session mtime store (shared with read/write). When present, the
	 * edit warns if the file changed on disk since the model last read it this
	 * session, and refreshes the recorded mtime after a successful commit.
	 */
	mtimeStore?: FileMtimeStore;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	// Normalize path aliases (file_path/filepath/filename/file -> path) before any
	// further shape-fixing. Returns same reference when nothing changed.
	let args = applyKeyAliases(input as Record<string, unknown>, PATH_KEY_ALIASES);

	// Normalize edit-key aliases other harnesses send (old_string/new_string,
	// oldString/newString, old_str/new_str -> oldText/newText) at the top level,
	// so a flat single-edit call from a cross-harness model still canonicalizes.
	args = applyKeyAliases(args, EDIT_KEY_ALIASES);

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array.
	args = coerceJsonArrayField(args, "edits");

	// Normalize the same edit-key aliases inside each edits[] element — the most
	// common cross-harness mistake (e.g. edits:[{old_string,new_string}]), which
	// would otherwise fail schema validation with no actionable suggestion.
	const editsField = (args as { edits?: unknown }).edits;
	if (Array.isArray(editsField)) {
		let changed = false;
		const normalized = editsField.map((element) => {
			if (element && typeof element === "object" && !Array.isArray(element)) {
				const fixed = applyKeyAliases(element as Record<string, unknown>, EDIT_KEY_ALIASES);
				if (fixed !== element) changed = true;
				return fixed;
			}
			return element;
		});
		if (changed) args = { ...args, edits: normalized };
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	edits?: Edit[];
	oldText?: string;
	newText?: string;
};

type EditToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};

type EditCallRenderComponent = Box &
	EditDiffMemoTarget & {
		lastArgsComplete?: boolean;
		/** Reference identity of the last `args` object seen by renderCall, used to
		 * skip re-serializing (`JSON.stringify`) an unchanged args object on
		 * re-renders that aren't caused by a new streamed chunk (setExpanded, theme
		 * invalidate, setShowImages, etc). `updateArgs` hands out a fresh object per
		 * streamed chunk, so reference equality reliably detects "new chunk". */
		lastArgsRef?: unknown;
		/** The argsKey last computed from `lastArgsRef`, reused verbatim when the
		 * args reference hasn't changed. */
		lastArgsKey?: string;
		/** Wall-clock time (`performance.now()`) of the last dispatched
		 * `computeEditsDiffWithBaseCache` call, for throttling live-preview
		 * recompute to ~10Hz during streaming. */
		lastPreviewDispatchAt?: number;
		/** argsKey that was actually dispatched for the in-flight/most recent
		 * compute (as opposed to `previewArgsKey`, which only advances once a
		 * result for that key has settled onto `component.preview`). Used both to
		 * avoid redundant dispatches while a key is already in flight and to let a
		 * resolution for a now-stale key still allow a fresh dispatch. */
		dispatchedArgsKey?: string;
	};

function createEditCallRenderComponent(): EditCallRenderComponent {
	return Object.assign(createEditCallComponentBase(), { lastArgsComplete: false });
}

/** Live-preview recompute is throttled to roughly this rate (ms) while args are
 * still streaming, so a fast token stream doesn't re-dispatch a full-file diff
 * on every chunk. The final args-complete render always bypasses the throttle. */
const LIVE_PREVIEW_THROTTLE_MS = 100;

function extractPathFromArgsKey(argsKey: string | undefined): string | undefined {
	if (argsKey === undefined) return undefined;
	try {
		const parsed = JSON.parse(argsKey) as { path?: unknown };
		return typeof parsed.path === "string" ? parsed.path : undefined;
	} catch {
		return undefined;
	}
}

function getRenderablePreviewInput(args: RenderableEditArgs | undefined): { path: string; edits: Edit[] } | null {
	if (!args) {
		return null;
	}

	const rawPath = getFilePathArg(args);
	if (rawPath === null || rawPath === "") {
		return null;
	}
	const path = rawPath;

	if (
		Array.isArray(args.edits) &&
		args.edits.length > 0 &&
		args.edits.every((edit) => typeof edit?.oldText === "string" && typeof edit?.newText === "string")
	) {
		return { path, edits: args.edits };
	}

	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}

	return null;
}

function formatEditResult(
	preview: EditPreview | undefined,
	result: EditToolResultLike,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	isError: boolean,
	path?: string,
): string | undefined {
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (!errorText || errorText === previewError) {
			return undefined;
		}
		return theme.fg("error", errorText);
	}

	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) {
		return renderDiff(resultDiff, { path });
	}

	return undefined;
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	const mtimeStore = options?.mtimeStore;
	return {
		name: "edit",
		label: "edit",
		description:
			'Edit one file by exact text replacement. Pass edits[] of {oldText,newText}; each oldText must match exactly one region in the ORIGINAL file. Multiple disjoint changes in same file → one call with multiple edits[]. If the file changed on disk since your last read this session, the edit still applies to the current content, but the result carries a NOTE that content you were not shown may have moved — re-read if that happens (some embedders additionally enforce reading a file before editing it).\n\nWRONG: { "edits": [{ "oldText": "foo", "newText": "foo" }] }   // no-op, refused\nWRONG: { "edits": [{ "oldText": "x", "newText": "y" }] }       // ambiguous if multiple "x"\nRIGHT: { "edits": [{ "oldText": "function foo()", "newText": "function foo(x)" }] }   // unique anchor\n\nWHICH TOOL: Default tool for text edits. For very large files where output tokens matter, prefer `edit_v2` (content-hash anchors). For structural rewrites across multiple files, use `ast_edit`. To create a new file or fully replace one, use `write`.',
		promptSnippet:
			"Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		promptGuidelines: [
			"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		],
		parameters: editSchema,
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const { path, edits } = validateEditInput(input);
			const absolutePath = resolveToCwd(path, cwd);

			let __written: string | undefined;
			// Captured for the post-write lazy-omission scan (LF-normalized base/new
			// from the edit engine — the right comparison inputs for "new placeholder
			// vs original"). Set only on a real write, not on the preview path.
			let __omissionBase: string | undefined;
			let __omissionNew: string | undefined;
			const diagnosticsBaseline =
				input.preview === true ? undefined : await capturePreWriteDiagnostics(absolutePath, cwd, signal);
			const writeResult = await withFileMutationQueue(
				absolutePath,
				() =>
					new Promise<{
						content: Array<{ type: "text"; text: string }>;
						details: EditToolDetails | undefined;
					}>((resolve, reject) => {
						// Check if already aborted.
						if (signal?.aborted) {
							reject(new Error("Operation aborted"));
							return;
						}

						let aborted = false;

						// Set up abort handler.
						const onAbort = () => {
							aborted = true;
							reject(new Error("Operation aborted"));
						};

						if (signal) {
							signal.addEventListener("abort", onAbort, { once: true });
						}

						// Perform the edit operation.
						void (async () => {
							try {
								// Check if file exists.
								try {
									await ops.access(absolutePath);
								} catch (error: unknown) {
									const errorMessage =
										error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
									if (signal) {
										signal.removeEventListener("abort", onAbort);
									}
									reject(new Error(`Could not edit file: ${path}. ${errorMessage}.`));
									return;
								}

								// Check if aborted before reading.
								if (aborted) {
									return;
								}

								// Snapshot the mtime this preview will be staged against (only
								// needed when staging — see the preview branch below), so the
								// eventual apply() (run later, from `resolve`) can detect the file
								// changing between staging and commit and refuse to blindly
								// overwrite it instead of silently discarding that change.
								let stagedMtimeMs: number | undefined;
								if (ops === defaultEditOperations && input.preview === true) {
									try {
										stagedMtimeMs = (await fsStat(absolutePath)).mtimeMs;
									} catch {
										// stat failed — staleness re-check at apply time is skipped, not fatal.
									}
								}

								// Read the file.
								const buffer = await ops.readFile(absolutePath);
								const rawContent = buffer.toString("utf-8");

								// Check if aborted after reading.
								if (aborted) {
									return;
								}

								// Strip BOM before matching. The model will not include an invisible BOM in oldText.
								const { bom, text: content } = stripBom(rawContent);
								const originalEnding = detectLineEnding(content);
								const normalizedContent = normalizeToLF(content);
								const { baseContent, newContent } = applyEditsToNormalizedContent(
									normalizedContent,
									edits,
									path,
								);

								// Check if aborted before writing.
								if (aborted) {
									return;
								}

								const finalContent = bom + restoreLineEndings(newContent, originalEnding);
								const diffResult = generateDiffString(baseContent, newContent);

								// Preview mode: stage instead of writing to disk.
								const queue = getCurrentPreviewQueue();
								if (input.preview === true && queue) {
									const item = queue.add({
										kind: "edit",
										path,
										apply: async () => {
											await withFileMutationQueue(absolutePath, async () => {
												if (ops === defaultEditOperations && stagedMtimeMs !== undefined) {
													const curStat = await fsStat(absolutePath).catch(() => undefined);
													if (curStat && curStat.mtimeMs !== stagedMtimeMs) {
														throw new Error(
															`Cannot apply preview: ${path} changed on disk since this edit was staged. Re-run edit to recompute the diff against the current file.`,
														);
													}
												}
												await ops.writeFile(absolutePath, finalContent);
												if (ops === defaultEditOperations) await refreshFileMtime(mtimeStore, absolutePath);
											});
										},
										summary: {
											description: `edit ${path}: ${edits.length} block(s)`,
											replacementCount: edits.length,
											diff: diffResult.diff,
										},
									});
									if (signal) signal.removeEventListener("abort", onAbort);
									resolve({
										content: [
											{
												type: "text",
												text: `Preview staged. id=${item.id}. Use resolve to commit.`,
											},
										],
										details: {
											diff: diffResult.diff,
											firstChangedLine: diffResult.firstChangedLine,
										},
									});
									return;
								}

								// Stale-read note: if the file changed on disk since the model last
								// read it this session, the edit still applies to the CURRENT content,
								// but content the model wasn't shown may have moved — flag it.
								let staleNote = "";
								if (ops === defaultEditOperations && mtimeStore) {
									const seenMtime = mtimeStore.get(absolutePath);
									if (seenMtime !== undefined) {
										try {
											const curStat = await fsStat(absolutePath);
											if (curStat.mtimeMs !== seenMtime) {
												staleNote = ` NOTE: ${path} changed on disk since you last read it this session — the edit applied to the current file, but content you weren't shown may have moved; re-read if the result looks unexpected.`;
											}
										} catch {
											// stat failed — non-fatal; skip the note.
										}
									}
								}

								await ops.writeFile(absolutePath, finalContent, signal);

								// Point of no return: the file is committed (atomic rename done).
								// Stop honoring abort so a late ESC can't reject a result that
								// already landed on disk — which would desync disk vs the model and
								// risk a duplicate edit on retry. (A pre-commit abort throws from
								// writeFile and is handled in the catch with the original intact.)
								if (signal) signal.removeEventListener("abort", onAbort);

								__written = finalContent;
								__omissionBase = baseContent;
								__omissionNew = newContent;

								// Cheap post-write integrity check (local FS only): confirm the
								// byte count on disk matches what we wrote, catching a silent
								// partial write / permission race that would otherwise leave the
								// model believing a corrupt edit succeeded. Skipped for custom
								// operations (e.g. SSH) where a local stat is meaningless.
								let integrityNote = "";
								if (ops === defaultEditOperations) {
									try {
										const st = await fsStat(absolutePath);
										const expected = Buffer.byteLength(finalContent, "utf-8");
										if (st.size !== expected) {
											integrityNote = ` WARNING: post-write size mismatch (expected ${expected} bytes, found ${st.size}). The write may be incomplete — re-read the file to confirm before relying on it.`;
										}
										// Refresh the observed mtime so our own write isn't later flagged as
										// a stale external change by the next edit of this path.
										if (mtimeStore) mtimeStore.set(absolutePath, st.mtimeMs);
									} catch {
										// stat failed — non-fatal; skip the note rather than fail the edit.
									}
								}

								// Clean up abort handler.
								if (signal) {
									signal.removeEventListener("abort", onAbort);
								}

								resolve({
									content: [
										{
											type: "text",
											text: `Successfully replaced ${edits.length} block(s) in ${path}.${integrityNote}${staleNote}`,
										},
									],
									details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine },
								});
							} catch (error: unknown) {
								// Clean up abort handler.
								if (signal) {
									signal.removeEventListener("abort", onAbort);
								}

								if (!aborted) {
									reject(error instanceof Error ? error : new Error(String(error)));
								}
							}
						})();
					}),
			);
			const diagResult = await attachPostWriteDiagnostics(
				writeResult,
				absolutePath,
				__written,
				cwd,
				signal,
				diagnosticsBaseline,
			);
			return attachOmissionWarning(diagResult, absolutePath, __omissionBase, __omissionNew, cwd);
		},
		renderCall(args, theme, context) {
			const component = getOrCreateEditCallComponent(
				context.state,
				context.lastComponent,
				createEditCallRenderComponent,
			);

			// `updateArgs` hands out a brand-new args object per streamed chunk, but
			// re-renders also happen for reasons unrelated to new args (setExpanded,
			// a theme invalidate walking every edit in the transcript, setShowImages,
			// etc). Skip the O(N) JSON.stringify of `edits` (dominated by the
			// growing newText) on those by memoizing on args reference identity.
			let argsKey: string | undefined;
			if (component.lastArgsRef === args) {
				argsKey = component.lastArgsKey;
			} else {
				const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
				argsKey = previewInput ? JSON.stringify({ path: previewInput.path, edits: previewInput.edits }) : undefined;
				component.lastArgsRef = args;
				component.lastArgsKey = argsKey;
			}

			if (component.previewArgsKey !== argsKey && argsKey === undefined) {
				// Args became non-renderable (e.g. malformed streamed input) — full
				// reset, matching the pre-throttle behavior exactly.
				component.preview = undefined;
				component.previewArgsKey = argsKey;
				component.dispatchedArgsKey = undefined;
				component.previewPending = false;
				component.settledError = false;
				component.previewSettled = false;
			} else {
				const previewPath =
					extractPathFromArgsKey(component.previewArgsKey) ?? extractPathFromArgsKey(component.dispatchedArgsKey);
				const streamPath = extractPathFromArgsKey(argsKey);
				if (previewPath !== undefined && streamPath !== undefined && previewPath !== streamPath) {
					// Path switched mid-stream — clear stale preview from the previous file.
					component.preview = undefined;
					component.previewArgsKey = argsKey;
					component.dispatchedArgsKey = undefined;
					component.previewPending = false;
					component.settledError = false;
					component.previewSettled = false;
				}
			}

			// Live diff: compute the preview as soon as a renderable input exists,
			// not only once args finish streaming. The diff grows token-by-token as
			// newText arrives. Rendering reuses the same
			// setEditPreview/buildEditToolCallComponent path as the final preview, so
			// it's already width-safe.
			//
			// Recompute is throttled to ~10Hz (LIVE_PREVIEW_THROTTLE_MS) while args
			// stream in, since each chunk would otherwise re-dispatch a full-file
			// diff at chunk rate (~20-60Hz). While a recompute for a newer key is
			// pending/throttled, the last successfully computed preview stays
			// visible (stale-while-revalidate) instead of being cleared to avoid a
			// flicker back to an empty body. `context.argsComplete` always bypasses
			// the throttle so the final, correct diff appears immediately.
			component.lastArgsComplete = context.argsComplete;
			const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
			const keyChangedSinceDispatch = argsKey !== component.dispatchedArgsKey;
			const now = performance.now();
			const throttleElapsed =
				component.lastPreviewDispatchAt === undefined ||
				now - component.lastPreviewDispatchAt >= LIVE_PREVIEW_THROTTLE_MS;
			if (
				previewInput &&
				argsKey !== undefined &&
				!component.previewPending &&
				keyChangedSinceDispatch &&
				(throttleElapsed || context.argsComplete)
			) {
				component.previewPending = true;
				component.dispatchedArgsKey = argsKey;
				component.lastPreviewDispatchAt = now;
				const requestKey = argsKey;
				void computeEditsDiffWithBaseCache(previewInput.path, previewInput.edits, context.cwd).then((preview) => {
					component.previewPending = false;
					if (component.previewSettled) return;
					// A newer chunk may have been dispatched (or the input reset to
					// non-renderable) since this compute started — a stale resolution
					// must never clobber a newer one. Compare against the key this
					// specific compute was dispatched for, not the component's latest
					// dispatchedArgsKey (which may have moved on already).
					if (component.dispatchedArgsKey !== requestKey) return;
					// While args are still streaming, a partial oldText/newText may not
					// match yet — swallow that transient error and let a later delta
					// retry. Re-read the CURRENT argsComplete (not the value captured at
					// dispatch) so an error that resolves AFTER args completed is shown.
					if (!component.lastArgsComplete && "error" in preview) {
						// Clear dispatchedArgsKey (rather than leaving it at requestKey) so
						// a later render can re-dispatch for the SAME key — e.g. args never
						// change again but argsComplete flips true, which must still get a
						// chance to show the (now non-transient) error immediately rather
						// than being permanently blocked by the "key unchanged" guard.
						if (component.dispatchedArgsKey === requestKey) component.dispatchedArgsKey = undefined;
						return;
					}
					setEditPreview(component, preview, requestKey);
					context.invalidate();
				});
			}

			return buildEditToolCallComponent(
				"edit",
				component,
				args as RenderableEditArgs | undefined,
				theme,
				context.cwd,
				context,
			);
		},
		renderResult(result, _options, theme, context) {
			const callComponent = context.state.callComponent;
			const previewInput = getRenderablePreviewInput(context.args as RenderableEditArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;
			const typedResult = result as EditToolResultLike;
			const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
			let changed = false;
			if (callComponent) {
				callComponent.previewSettled = true;
				if (typeof resultDiff === "string") {
					changed =
						setEditPreview(
							callComponent,
							{ diff: resultDiff, firstChangedLine: typedResult.details?.firstChangedLine },
							argsKey,
						) || changed;
				}
				if (callComponent.settledError !== context.isError) {
					callComponent.settledError = context.isError;
					changed = true;
				}
				if (changed) {
					buildEditToolCallComponent(
						"edit",
						callComponent,
						context.args as RenderableEditArgs | undefined,
						theme,
						context.cwd,
						context,
					);
				}
			}

			const output = formatEditResult(
				callComponent?.preview,
				typedResult,
				theme,
				context.isError,
				previewInput?.path,
			);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (!output) {
				return component;
			}
			component.addChild(new Spacer(1));
			component.addChild(new Text(output, 1, 0));
			return component;
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
