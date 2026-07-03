import type { AgentTool } from "@pit/agent-core";
import { type Box, Container, Spacer, Text } from "@pit/tui";
import { stat as fsStat } from "fs/promises";
import { type Static, Type } from "typebox";
import { renderDiff } from "../../modes/interactive/components/diff.js";
import type { ToolDefinition } from "../extensions/types.js";
import { attachPostWriteDiagnostics, capturePreWriteDiagnostics } from "../lsp/writethrough.ts";
import { getCurrentPreviewQueue } from "../preview-queue.ts";
import { applyKeyAliases, coerceJsonArrayField, PATH_KEY_ALIASES } from "./argument-prep.js";
import { defaultEditOperations, type EditOperations, type EditToolDetails } from "./edit.ts";
import { detectLineEnding, generateDiffString, normalizeToLF, restoreLineEndings, stripBom } from "./edit-diff.ts";
import {
	applyHashlineEdits,
	computeHashlineEditsDiff,
	type HashlineEdit,
	HashlineEditError,
} from "./edit-hashline-diff.ts";
import {
	buildEditToolCallComponent,
	createEditCallComponentBase,
	type EditDiffMemoTarget,
	getOrCreateEditCallComponent,
	setEditPreview,
} from "./edit-preview-shared.ts";
import { type FileMtimeStore, refreshFileMtime } from "./file-mtime-store.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const HEX8 = /^[0-9a-f]{8}$/;

const hashlineEditSchema = Type.Object(
	{
		before_hash: Type.String({
			description: "8-char hex sha256 prefix of the 3-line window immediately BEFORE the region to replace.",
		}),
		after_hash: Type.String({
			description: "8-char hex sha256 prefix of the 3-line window immediately AFTER the region to replace.",
		}),
		new_text: Type.String({
			description: "Replacement content placed strictly between the two anchor windows. Anchor lines are preserved.",
		}),
	},
	{ additionalProperties: false },
);

const editHashlineSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(hashlineEditSchema, {
			description:
				"Sequential anchored edits. Each edit re-hashes the working buffer, so anchors must reflect prior edits in the same call.",
		}),
		preview: Type.Optional(
			Type.Boolean({
				description: "When true, stage as a preview rather than applying. Use the resolve tool to commit.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type EditHashlineToolInput = Static<typeof editHashlineSchema>;

export interface EditHashlineToolOptions {
	operations?: EditOperations;
	mtimeStore?: FileMtimeStore;
}

type RenderableArgs = {
	path?: string;
	file_path?: string;
	edits?: HashlineEdit[];
};

type CallComponent = Box & EditDiffMemoTarget;

type RenderState = { callComponent?: CallComponent };

function getRenderablePreviewInput(args: RenderableArgs | undefined): { path: string; edits: HashlineEdit[] } | null {
	if (!args) return null;
	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	if (!path) return null;
	if (
		!Array.isArray(args.edits) ||
		args.edits.length === 0 ||
		!args.edits.every(
			(edit) =>
				typeof edit?.before_hash === "string" &&
				typeof edit?.after_hash === "string" &&
				typeof edit?.new_text === "string" &&
				HEX8.test(edit.before_hash) &&
				HEX8.test(edit.after_hash),
		)
	) {
		return null;
	}
	return { path, edits: args.edits };
}

function prepareArguments(input: unknown): EditHashlineToolInput {
	if (!input || typeof input !== "object") return input as EditHashlineToolInput;
	let args = applyKeyAliases(input as Record<string, unknown>, PATH_KEY_ALIASES);
	args = coerceJsonArrayField(args, "edits");
	return args as EditHashlineToolInput;
}

function validateInput(input: EditHashlineToolInput): { path: string; edits: HashlineEdit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("edit_v2: edits must contain at least one entry.");
	}
	for (let i = 0; i < input.edits.length; i++) {
		const e = input.edits[i];
		if (!HEX8.test(e.before_hash)) {
			throw new Error(
				`edits[${i}].before_hash must be 8 lowercase hex chars; got ${JSON.stringify(e.before_hash)}.`,
			);
		}
		if (!HEX8.test(e.after_hash)) {
			throw new Error(`edits[${i}].after_hash must be 8 lowercase hex chars; got ${JSON.stringify(e.after_hash)}.`);
		}
		if (typeof e.new_text !== "string") {
			throw new Error(`edits[${i}].new_text must be a string.`);
		}
	}
	return { path: input.path, edits: input.edits };
}

export function createEditHashlineToolDefinition(
	cwd: string,
	options?: EditHashlineToolOptions,
): ToolDefinition<typeof editHashlineSchema, EditToolDetails | undefined, RenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	const mtimeStore = ops === defaultEditOperations ? options?.mtimeStore : undefined;
	return {
		name: "edit_v2",
		label: "edit_v2",
		description:
			"Edit one file using content-hash anchors. Each edit gives a before_hash and after_hash (8-char sha256 prefix of a 3-line window from the most recent read) and the new_text to place between them; anchor lines are preserved. If an anchor is not found or ambiguous, re-read the file to get fresh anchors before retrying.\n\nWHICH TOOL: Anchors edits by content hash to lower output tokens on large files. For ordinary edits prefer `edit`; for structural multi-file rewrites use `ast_edit`.",
		promptSnippet: "Edit a file via content-hash anchors (lower output tokens than full string replace)",
		promptGuidelines: [
			"Each before_hash/after_hash is sha256[0:8] of a 3-line window from your most recent read of the file",
			"new_text replaces only the lines strictly between the two anchor windows; the anchor windows themselves stay",
			"Edits are applied sequentially — pick anchors that exist in the buffer AFTER prior edits in this call",
			"On not_found/ambiguous error, re-read the file to refresh anchors instead of guessing",
		],
		parameters: editHashlineSchema,
		renderShell: "self",
		prepareArguments,
		async execute(_toolCallId, input: EditHashlineToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const { path, edits } = validateInput(input);
			const absolutePath = resolveToCwd(path, cwd);

			let __written: string | undefined;
			const diagnosticsBaseline =
				input.preview === true ? undefined : await capturePreWriteDiagnostics(absolutePath, cwd, signal);
			const writeResult = await withFileMutationQueue(
				absolutePath,
				() =>
					new Promise<{
						content: Array<{ type: "text"; text: string }>;
						details: EditToolDetails | undefined;
					}>((resolve, reject) => {
						if (signal?.aborted) {
							reject(new Error("Operation aborted"));
							return;
						}
						let aborted = false;
						const onAbort = () => {
							aborted = true;
							reject(new Error("Operation aborted"));
						};
						if (signal) signal.addEventListener("abort", onAbort, { once: true });

						void (async () => {
							try {
								try {
									await ops.access(absolutePath);
								} catch (error: unknown) {
									const errorMessage =
										error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
									if (signal) signal.removeEventListener("abort", onAbort);
									reject(new Error(`Could not edit file: ${path}. ${errorMessage}.`));
									return;
								}
								if (aborted) return;

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

								const buffer = await ops.readFile(absolutePath);
								const rawContent = buffer.toString("utf-8");
								if (aborted) return;

								const { bom, text: content } = stripBom(rawContent);
								const originalEnding = detectLineEnding(content);
								const baseContent = normalizeToLF(content);

								let newContent: string;
								let appliedCount: number;
								try {
									const result = applyHashlineEdits(baseContent, edits, path);
									newContent = result.newContent;
									appliedCount = result.appliedCount;
								} catch (err) {
									if (signal) signal.removeEventListener("abort", onAbort);
									if (err instanceof HashlineEditError) {
										reject(new Error(err.message));
									} else {
										reject(err instanceof Error ? err : new Error(String(err)));
									}
									return;
								}

								if (baseContent === newContent) {
									if (signal) signal.removeEventListener("abort", onAbort);
									reject(
										new Error(
											`No changes made to ${path}. Hashline edits produced identical content — new_text may already match what's between the anchors, or before_hash/after_hash may be anchored on the wrong side of the intended region. Re-read the file to confirm anchors before retrying.`,
										),
									);
									return;
								}

								if (aborted) return;
								const finalContent = bom + restoreLineEndings(newContent, originalEnding);
								const diffResult = generateDiffString(baseContent, newContent);

								// Preview mode: stage instead of writing to disk.
								const queue = getCurrentPreviewQueue();
								if (input.preview === true && queue) {
									const item = queue.add({
										kind: "edit_v2",
										path,
										apply: async () => {
											await withFileMutationQueue(absolutePath, async () => {
												if (ops === defaultEditOperations && stagedMtimeMs !== undefined) {
													const curStat = await fsStat(absolutePath).catch(() => undefined);
													if (curStat && curStat.mtimeMs !== stagedMtimeMs) {
														throw new Error(
															`Cannot apply preview: ${path} changed on disk since this edit was staged. Re-run edit_v2 to recompute the diff against the current file.`,
														);
													}
												}
												await ops.writeFile(absolutePath, finalContent);
												if (ops === defaultEditOperations) await refreshFileMtime(mtimeStore, absolutePath);
											});
										},
										summary: {
											description: `edit_v2 ${path}: ${appliedCount} hashline edit(s)`,
											replacementCount: appliedCount,
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
								// Committed (atomic rename): stop honoring abort so a late ESC can't
								// reject a write that already landed (a pre-commit abort throws and is
								// handled in the catch with the original file intact).
								if (signal) signal.removeEventListener("abort", onAbort);

								__written = finalContent;

								// Cheap post-write integrity check (local FS only): confirm the byte
								// count on disk matches what we wrote, catching a silent partial write
								// / permission race that would otherwise leave the model believing a
								// corrupt edit succeeded. Skipped for custom operations (e.g. SSH)
								// where a local stat is meaningless. Shares the stat call with the
								// mtime refresh below.
								let integrityNote = "";
								if (ops === defaultEditOperations) {
									try {
										const st = await fsStat(absolutePath);
										const expected = Buffer.byteLength(finalContent, "utf-8");
										if (st.size !== expected) {
											integrityNote = ` WARNING: post-write size mismatch (expected ${expected} bytes, found ${st.size}). The write may be incomplete — re-read the file to confirm before relying on it.`;
										}
										if (mtimeStore) mtimeStore.set(absolutePath, st.mtimeMs);
									} catch {
										// stat failed — non-fatal; skip the note rather than fail the edit.
									}
								}

								resolve({
									content: [
										{
											type: "text",
											text: `Successfully applied ${appliedCount} hashline edit(s) in ${path}.${integrityNote}${staleNote}`,
										},
									],
									details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine },
								});
							} catch (error: unknown) {
								if (signal) signal.removeEventListener("abort", onAbort);
								if (!aborted) reject(error instanceof Error ? error : new Error(String(error)));
							}
						})();
					}),
			);
			return attachPostWriteDiagnostics(writeResult, absolutePath, __written, cwd, signal, diagnosticsBaseline);
		},
		renderCall(args, theme, context) {
			const component = getOrCreateEditCallComponent(
				context.state,
				context.lastComponent,
				createEditCallComponentBase,
			);
			const previewInput = getRenderablePreviewInput(args as RenderableArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;

			if (component.previewArgsKey !== argsKey) {
				component.preview = undefined;
				component.previewArgsKey = argsKey;
				component.previewPending = false;
				component.settledError = false;
			}

			if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
				component.previewPending = true;
				const requestKey = argsKey;
				void computeHashlineEditsDiff(previewInput.path, previewInput.edits, context.cwd).then((preview) => {
					if (component.previewArgsKey === requestKey) {
						setEditPreview(component, preview, requestKey);
						context.invalidate();
					}
				});
			}

			return buildEditToolCallComponent(
				"edit_v2",
				component,
				args as RenderableArgs | undefined,
				theme,
				context.cwd,
				context,
			);
		},
		renderResult(result, _options, theme, context) {
			const callComponent = context.state.callComponent;
			const previewInput = getRenderablePreviewInput(context.args as RenderableArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;
			const typedResult = result as { details?: EditToolDetails; content: Array<{ type: string; text?: string }> };
			const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
			let changed = false;

			if (callComponent) {
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
						"edit_v2",
						callComponent,
						context.args as RenderableArgs | undefined,
						theme,
						context.cwd,
						context,
					);
				}
			}

			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();

			const previewDiff =
				callComponent?.preview && !("error" in callComponent.preview) ? callComponent.preview.diff : undefined;
			const previewError =
				callComponent?.preview && "error" in callComponent.preview ? callComponent.preview.error : undefined;

			if (context.isError) {
				const errorText = typedResult.content
					.filter((c) => c.type === "text")
					.map((c) => c.text || "")
					.join("\n");
				if (errorText && errorText !== previewError) {
					component.addChild(new Spacer(1));
					component.addChild(new Text(theme.fg("error", errorText), 1, 0));
				}
				return component;
			}

			if (resultDiff && resultDiff !== previewDiff) {
				component.addChild(new Spacer(1));
				component.addChild(new Text(renderDiff(resultDiff), 1, 0));
			}
			return component;
		},
	};
}

export function createEditHashlineTool(
	cwd: string,
	options?: EditHashlineToolOptions,
): AgentTool<typeof editHashlineSchema> {
	return wrapToolDefinition(createEditHashlineToolDefinition(cwd, options));
}
