/**
 * Apply LSP TextEdits and WorkspaceEdits to disk. Edits are applied
 * bottom-to-top to preserve indices; resource ops (create/rename/delete) are
 * interleaved per the LSP §3.16 documentChanges ordering rules.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeFileAtomic } from "../../utils/atomic-write.ts";
import type {
	CreateFile,
	DeleteFile,
	Position,
	Range,
	RenameFile,
	TextDocumentEdit,
	TextEdit,
	WorkspaceEdit,
} from "./types.ts";
import { formatPathRelativeToCwd, uriToFile } from "./utils.ts";

// =============================================================================
// Text Edit Application
// =============================================================================

/** Apply text edits to a string in-memory (reverse order to preserve indices). */
export function applyTextEditsToString(content: string, edits: TextEdit[]): string {
	const lines = content.split("\n");

	const sortedEdits = [...edits].sort((a, b) => {
		if (a.range.start.line !== b.range.start.line) {
			return b.range.start.line - a.range.start.line;
		}
		return b.range.start.character - a.range.start.character;
	});

	// Detect overlapping ranges: in reverse-sorted order each edit's start must
	// be >= the next edit's end, else they clobber each other when applied
	// bottom-up (typically a multi-server rename with stale positions).
	for (let i = 0; i < sortedEdits.length - 1; i++) {
		const later = sortedEdits[i].range;
		const earlier = sortedEdits[i + 1].range;
		if (comparePosition(earlier.end, later.start) > 0) {
			throw new Error(
				`overlapping LSP edits: ${formatRange(earlier)} conflicts with ${formatRange(later)}; multi-server rename produced inconsistent edits`,
			);
		}
	}

	for (const edit of sortedEdits) {
		const { start, end } = edit.range;
		if (start.line === end.line) {
			const line = lines[start.line] || "";
			lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character);
		} else {
			const startLine = lines[start.line] || "";
			const endLine = lines[end.line] || "";
			const newContent = startLine.slice(0, start.character) + edit.newText + endLine.slice(end.character);
			lines.splice(start.line, end.line - start.line + 1, ...newContent.split("\n"));
		}
	}

	return lines.join("\n");
}

export function comparePosition(a: Position, b: Position): number {
	return a.line === b.line ? a.character - b.character : a.line - b.line;
}

function formatRange(range: Range): string {
	return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
}

/** True when two ranges overlap (share any position other than a touching boundary). */
export function rangesOverlap(a: Range, b: Range): boolean {
	return comparePosition(a.start, b.end) < 0 && comparePosition(b.start, a.end) < 0;
}

/** Flatten a WorkspaceEdit's text edits into a Map<uri, TextEdit[]>. */
export function flattenWorkspaceTextEdits(edit: WorkspaceEdit): Map<string, TextEdit[]> {
	const out = new Map<string, TextEdit[]>();
	const push = (uri: string, edits: TextEdit[]) => {
		if (edits.length === 0) return;
		const prev = out.get(uri);
		if (prev) prev.push(...edits);
		else out.set(uri, [...edits]);
	};
	if (edit.changes) {
		const changes = edit.changes;
		for (const uri in changes) push(uri, changes[uri]);
	}
	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if ("textDocument" in change && change.textDocument && "edits" in change && change.edits) {
				const tdc = change as TextDocumentEdit;
				const textEdits = tdc.edits.filter((e): e is TextEdit => "range" in e && "newText" in e);
				push(tdc.textDocument.uri, textEdits);
			}
		}
	}
	return out;
}

/** Apply text edits to a file (reverse order to preserve indices). */
export async function applyTextEdits(filePath: string, edits: TextEdit[]): Promise<void> {
	const content = await fs.readFile(filePath, "utf-8");
	const result = applyTextEditsToString(content, edits);
	// Atomic write: a quick-fix/rename interrupted (ESC/crash) mid-write must never
	// leave the user's source file truncated, and a concurrent reader must never see
	// a half-written file (temp-then-rename instead of truncate-then-rewrite).
	await writeFileAtomic(filePath, result);
}

// =============================================================================
// Workspace Edit Application
// =============================================================================

/** Apply a workspace edit (collection of file changes). Returns descriptions. */
export async function applyWorkspaceEdit(edit: WorkspaceEdit, cwd: string): Promise<string[]> {
	const applied: string[] = [];

	if (edit.documentChanges) {
		const pending = new Map<string, TextEdit[]>();

		const flushUri = async (uri: string) => {
			const edits = pending.get(uri);
			if (!edits) return;
			pending.delete(uri);
			const filePath = uriToFile(uri);
			await applyTextEdits(filePath, edits);
			applied.push(`Applied ${edits.length} edit(s) to ${formatPathRelativeToCwd(filePath, cwd)}`);
		};

		const flushSubtree = async (uri: string) => {
			const prefix = uri.endsWith("/") ? uri : `${uri}/`;
			const matches: string[] = [];
			for (const candidate of pending.keys()) {
				if (candidate === uri || candidate.startsWith(prefix)) matches.push(candidate);
			}
			for (const target of matches) {
				await flushUri(target);
			}
		};

		for (const change of edit.documentChanges) {
			if ("textDocument" in change && change.textDocument && "edits" in change && change.edits) {
				const tdc = change as TextDocumentEdit;
				const uri = tdc.textDocument.uri;
				const textEdits = tdc.edits.filter((e): e is TextEdit => "range" in e && "newText" in e);
				if (textEdits.length > 0) {
					const prev = pending.get(uri);
					if (prev) prev.push(...textEdits);
					else pending.set(uri, [...textEdits]);
				}
			} else if ("kind" in change && change.kind) {
				if (change.kind === "create") {
					const createOp = change as CreateFile;
					await flushUri(createOp.uri);
					const filePath = uriToFile(createOp.uri);
					await fs.mkdir(path.dirname(filePath), { recursive: true });
					await fs.writeFile(filePath, "", "utf-8");
					applied.push(`Created ${formatPathRelativeToCwd(filePath, cwd)}`);
				} else if (change.kind === "rename") {
					const renameOp = change as RenameFile;
					await flushSubtree(renameOp.oldUri);
					await flushSubtree(renameOp.newUri);
					const oldPath = uriToFile(renameOp.oldUri);
					const newPath = uriToFile(renameOp.newUri);
					await fs.mkdir(path.dirname(newPath), { recursive: true });
					await fs.rename(oldPath, newPath);
					applied.push(
						`Renamed ${formatPathRelativeToCwd(oldPath, cwd)} -> ${formatPathRelativeToCwd(newPath, cwd)}`,
					);
				} else if (change.kind === "delete") {
					const deleteOp = change as DeleteFile;
					await flushSubtree(deleteOp.uri);
					const filePath = uriToFile(deleteOp.uri);
					await fs.rm(filePath, { recursive: true });
					applied.push(`Deleted ${formatPathRelativeToCwd(filePath, cwd)}`);
				}
			}
		}

		for (const [uri] of pending) {
			await flushUri(uri);
		}
	} else if (edit.changes) {
		const changes = edit.changes;
		for (const uri in changes) {
			const textEdits = changes[uri];
			if (textEdits.length === 0) continue;
			const filePath = uriToFile(uri);
			await applyTextEdits(filePath, textEdits);
			applied.push(`Applied ${textEdits.length} edit(s) to ${formatPathRelativeToCwd(filePath, cwd)}`);
		}
	}

	return applied;
}
