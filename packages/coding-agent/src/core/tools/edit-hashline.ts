import type { AgentTool } from "@pit/agent-core";
import { Box, Container, Spacer, Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import { renderDiff } from "../../modes/interactive/components/diff.js";
import type { ToolDefinition } from "../extensions/types.js";
import { attachPostWriteDiagnostics } from "../lsp/writethrough.ts";
import { getCurrentPreviewQueue } from "../preview-queue.ts";
import { applyKeyAliases, coerceJsonArrayField, PATH_KEY_ALIASES } from "./argument-prep.js";
import { defaultEditOperations, type EditOperations, type EditToolDetails } from "./edit.ts";
import {
	detectLineEnding,
	type EditDiffError,
	type EditDiffResult,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import {
	applyHashlineEdits,
	computeHashlineEditsDiff,
	type HashlineEdit,
	HashlineEditError,
} from "./edit-hashline-diff.ts";
import { getEditHeaderBg, setEditPreview } from "./edit-preview-shared.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getFilePathArg, invalidArgText, shortenPath } from "./render-utils.ts";
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
}

type RenderableArgs = {
	path?: string;
	file_path?: string;
	edits?: HashlineEdit[];
};

type HashlineEditPreview = EditDiffResult | EditDiffError;

type CallComponent = Box & {
	preview?: HashlineEditPreview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
};

function createCallComponent(): CallComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as HashlineEditPreview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		settledError: false,
	});
}

type RenderState = { callComponent?: CallComponent };

function getCallComponent(state: RenderState, lastComponent: unknown): CallComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as CallComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) return state.callComponent;
	const component = createCallComponent();
	state.callComponent = component;
	return component;
}

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

function formatCall(
	args: RenderableArgs | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	cwd?: string,
): string {
	const invalidArg = invalidArgText(theme);
	const rawPath = getFilePathArg(args);
	const path = rawPath !== null ? shortenPath(rawPath, cwd) : null;
	const pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}

function buildCallComponent(
	component: CallComponent,
	args: RenderableArgs | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	cwd?: string,
): CallComponent {
	component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatCall(args, theme, cwd), 0, 0));
	if (component.preview) {
		const body =
			"error" in component.preview ? theme.fg("error", component.preview.error) : renderDiff(component.preview.diff);
		component.addChild(new Spacer(1));
		component.addChild(new Text(body, 0, 0));
	}
	return component;
}

export function createEditHashlineToolDefinition(
	cwd: string,
	options?: EditHashlineToolOptions,
): ToolDefinition<typeof editHashlineSchema, EditToolDetails | undefined, RenderState> {
	const ops = options?.operations ?? defaultEditOperations;
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
			"Use edit_v2 to lower output tokens on large files. For ordinary edits prefer edit; for structural multi-file rewrites use ast_edit.",
		],
		parameters: editHashlineSchema,
		renderShell: "self",
		prepareArguments,
		async execute(_toolCallId, input: EditHashlineToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const { path, edits } = validateInput(input);
			const absolutePath = resolveToCwd(path, cwd);

			let __written: string | undefined;
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
									reject(new Error(`No changes made to ${path}. Hashline edits produced identical content.`));
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
											await ops.writeFile(absolutePath, finalContent);
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

								await ops.writeFile(absolutePath, finalContent, signal);
								// Committed (atomic rename): stop honoring abort so a late ESC can't
								// reject a write that already landed (a pre-commit abort throws and is
								// handled in the catch with the original file intact).
								__written = finalContent;
								if (signal) signal.removeEventListener("abort", onAbort);

								resolve({
									content: [
										{
											type: "text",
											text: `Successfully applied ${appliedCount} hashline edit(s) in ${path}.`,
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
			return attachPostWriteDiagnostics(writeResult, absolutePath, __written, cwd, signal);
		},
		renderCall(args, theme, context) {
			const component = getCallComponent(context.state, context.lastComponent);
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

			return buildCallComponent(component, args as RenderableArgs | undefined, theme, context.cwd);
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
					buildCallComponent(callComponent, context.args as RenderableArgs | undefined, theme, context.cwd);
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
