import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import type { AgentTool } from "@pit/agent-core";
import { Container, Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import { renderDiff } from "../../modes/interactive/components/diff.js";
import type { ToolDefinition } from "../extensions/types.js";
import { deleteSnapshot, getLatestSnapshot, readSnapshotBytes, snapshotsEnabled } from "../file-snapshots.ts";
import { applyKeyAliases, PATH_KEY_ALIASES } from "./argument-prep.js";
import { generateDiffString, normalizeToLF, stripBom } from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const undoSchema = Type.Object(
	{
		path: Type.String({
			description: "Path to the file whose last change should be reverted (relative or absolute)",
		}),
	},
	{ additionalProperties: false },
);

export type UndoToolInput = Static<typeof undoSchema>;

export interface UndoToolDetails {
	/** Unified diff of what the revert changed (pre-undo → restored). */
	diff: string;
}

function prepareUndoArguments(input: unknown): UndoToolInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input as UndoToolInput;
	return applyKeyAliases(input as Record<string, unknown>, PATH_KEY_ALIASES) as UndoToolInput;
}

/** Normalize raw bytes to LF-without-BOM text for a readable diff (display only). */
function toDiffText(bytes: Buffer | undefined): string {
	if (!bytes) return "";
	return normalizeToLF(stripBom(bytes.toString("utf-8")).text);
}

/** Reserved for parity with other tools (custom ops); none needed today. */
export type UndoToolOptions = Record<string, never>;

export function createUndoToolDefinition(
	cwd: string,
	_options?: UndoToolOptions,
): ToolDefinition<typeof undoSchema, UndoToolDetails | undefined> {
	return {
		name: "undo",
		label: "undo",
		description:
			"Revert the LAST file operation on ONE specific file, restoring the exact bytes from just before that edit/write. Pass the file path. Restores from an automatic pre-image snapshot (captured before every edit/write this session) — byte-for-byte, preserving line endings and BOM. Only the single most recent change to that file is reverted per call; call again to step further back. undo is itself undoable (calling undo again re-applies what you just reverted). To roll back many files across a whole turn at once, the user has the `/rewind` command instead.",
		promptSnippet: "Revert the last edit/write on a specific file to its previous snapshot",
		parameters: undoSchema,
		prepareArguments: prepareUndoArguments,
		async execute(_toolCallId, input: UndoToolInput) {
			const { path } = input;
			if (!snapshotsEnabled()) {
				return {
					content: [
						{
							type: "text" as const,
							text: "File snapshots are disabled (PIT_NO_FILE_SNAPSHOTS is set); there is nothing to undo.",
						},
					],
					details: undefined,
				};
			}
			const absolutePath = resolveToCwd(path, cwd);
			// Select the target snapshot BEFORE entering the queue: the queue captures a
			// fresh pre-image of the current file (so this undo is itself undoable), and
			// that new snapshot must not be mistaken for the one we intend to restore.
			const record = await getLatestSnapshot(absolutePath);
			if (!record) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No snapshot to undo for ${path}. Snapshots are captured before edit/write operations; there is no earlier version of this file recorded this session.`,
						},
					],
					details: undefined,
				};
			}
			const restoredBytes = await readSnapshotBytes(record);

			let diff = "";
			await withFileMutationQueue(
				absolutePath,
				async () => {
					let currentBytes: Buffer | undefined;
					try {
						currentBytes = await fsReadFile(absolutePath);
					} catch {
						// File may have been deleted since; restoring recreates it.
					}
					// Byte-for-byte restore (raw snapshot bytes, no reformatting).
					await fsWriteFile(absolutePath, restoredBytes);
					diff = generateDiffString(toDiffText(currentBytes), toDiffText(restoredBytes)).diff;
					// Consume the restored snapshot (LIFO pop).
					await deleteSnapshot(record);
				},
				{ snapshot: { tool: "undo" } },
			);

			const summary = diff ? `\n\n${diff}` : "";
			return {
				content: [
					{
						type: "text" as const,
						text: `Reverted ${path} to the snapshot taken before the last ${record.meta.tool} operation.${summary}`,
					},
				],
				details: { diff },
			};
		},
		renderResult(result, _options, theme, context) {
			const details = (result as { details?: UndoToolDetails }).details;
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (context.isError) {
				const errorText = result.content
					.filter((c) => c.type === "text")
					.map((c) => ("text" in c ? c.text : ""))
					.join("\n");
				if (errorText) component.addChild(new Text(theme.fg("error", errorText), 1, 0));
				return component;
			}
			if (details?.diff) {
				component.addChild(
					new Text(renderDiff(details.diff, { path: context.args?.path as string | undefined }), 1, 0),
				);
			}
			return component;
		},
	};
}

export function createUndoTool(cwd: string, options?: UndoToolOptions): AgentTool<typeof undoSchema> {
	return wrapToolDefinition(createUndoToolDefinition(cwd, options));
}
