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
import { formatPathRelativeToCwd, isPathInsideCwd, uriToFile } from "./utils.ts";

/** True when an error is a Node ENOENT (missing path) rejection. */
function isEnoent(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

// =============================================================================
// Workspace path safety
// =============================================================================

function assertFileUri(uri: string, label: string): void {
	if (!uri.startsWith("file://")) {
		throw new Error(`LSP workspace edit rejected: ${label} URI must be file://, got ${uri}`);
	}
}

function resolveWorkspaceUri(uri: string, cwd: string, label: string): string {
	assertFileUri(uri, label);
	const filePath = path.resolve(uriToFile(uri));
	if (!isPathInsideCwd(filePath, cwd)) {
		throw new Error(
			`LSP workspace edit rejected: ${label} path is outside cwd: ${formatPathRelativeToCwd(filePath, cwd)}`,
		);
	}
	return filePath;
}

async function realpathIfExists(filePath: string): Promise<string | undefined> {
	try {
		return await fs.realpath(filePath);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

async function nearestExistingAncestorRealpath(filePath: string): Promise<string | undefined> {
	let current = path.resolve(filePath);
	while (true) {
		const real = await realpathIfExists(current);
		if (real) return real;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

async function assertNoSymlinkEscape(filePath: string, cwd: string, label: string): Promise<void> {
	const cwdReal = (await realpathIfExists(cwd)) ?? path.resolve(cwd);
	const existingReal = await realpathIfExists(filePath);
	const containmentTarget = existingReal ?? (await nearestExistingAncestorRealpath(path.dirname(filePath)));
	if (containmentTarget && !isPathInsideCwd(containmentTarget, cwdReal)) {
		throw new Error(
			`LSP workspace edit rejected: ${label} resolves outside cwd: ${formatPathRelativeToCwd(containmentTarget, cwdReal)}`,
		);
	}
}

async function resolveSafeWorkspaceUri(uri: string, cwd: string, label: string): Promise<string> {
	const filePath = resolveWorkspaceUri(uri, cwd, label);
	await assertNoSymlinkEscape(filePath, cwd, label);
	return filePath;
}

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

	for (const edit of sortedEdits) {
		validateEditRange(edit.range, lines);
	}

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

function validateEditRange(range: Range, lines: string[]): void {
	const { start, end } = range;
	if (comparePosition(start, end) > 0) {
		throw new Error(`LSP edit range is reversed: ${formatRange(range)}`);
	}
	if (start.line < 0 || end.line < 0 || start.line >= lines.length || end.line >= lines.length) {
		throw new Error(
			`LSP edit position out of range: ${formatRange(range)} exceeds file length (${lines.length} line(s)); stale edit from an inconsistent multi-server response`,
		);
	}
	const startLine = lines[start.line] ?? "";
	const endLine = lines[end.line] ?? "";
	if (
		start.character < 0 ||
		end.character < 0 ||
		start.character > startLine.length ||
		end.character > endLine.length
	) {
		throw new Error(
			`LSP edit character out of range: ${formatRange(range)} exceeds line length; stale edit from an inconsistent multi-server response`,
		);
	}
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

/** Keep only the plain TextEdits from a documentChange's edit list (drops annotated/other shapes). */
function extractTextEdits(edits: TextDocumentEdit["edits"]): TextEdit[] {
	return edits.filter((e): e is TextEdit => "range" in e && "newText" in e);
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
				const textEdits = extractTextEdits(tdc.edits);
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
// Workspace Edit Transaction Preparation
// =============================================================================

interface FileSnapshot {
	filePath: string;
	existed: boolean;
	content?: string;
}

async function snapshotFile(filePath: string): Promise<FileSnapshot> {
	try {
		const stat = await fs.stat(filePath);
		if (stat.isDirectory()) {
			throw new Error(`LSP workspace edit rejected: directory resource operations are not supported: ${filePath}`);
		}
		return { filePath, existed: true, content: await fs.readFile(filePath, "utf-8") };
	} catch (err) {
		if (isEnoent(err)) return { filePath, existed: false };
		throw err;
	}
}

async function restoreSnapshots(snapshots: FileSnapshot[]): Promise<void> {
	for (const snapshot of [...snapshots].reverse()) {
		if (snapshot.existed) {
			await fs.mkdir(path.dirname(snapshot.filePath), { recursive: true });
			await writeFileAtomic(snapshot.filePath, snapshot.content ?? "");
		} else {
			await fs.rm(snapshot.filePath, { force: true, recursive: true });
		}
	}
}

async function ensureFileResourceIsNotDirectory(filePath: string): Promise<void> {
	try {
		const stat = await fs.stat(filePath);
		if (stat.isDirectory()) {
			throw new Error(`LSP workspace edit rejected: directory resource operations are not supported: ${filePath}`);
		}
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function readVirtualOrDisk(
	uri: string,
	filePath: string,
	virtualContent: Map<string, string | null>,
): Promise<string> {
	if (virtualContent.has(uri)) {
		const content = virtualContent.get(uri);
		if (content === null) throw new Error(`LSP workspace edit targets a deleted file: ${filePath}`);
		if (content !== undefined) return content;
	}
	return await fs.readFile(filePath, "utf-8");
}

async function prepareTextEdits(
	uri: string,
	edits: TextEdit[],
	cwd: string,
	virtualContent: Map<string, string | null>,
	snapshotPaths: Set<string>,
): Promise<void> {
	if (edits.length === 0) return;
	const filePath = await resolveSafeWorkspaceUri(uri, cwd, "text edit");
	const content = await readVirtualOrDisk(uri, filePath, virtualContent);
	virtualContent.set(uri, applyTextEditsToString(content, edits));
	snapshotPaths.add(filePath);
}

async function prepareCreateOperation(
	createOp: CreateFile,
	cwd: string,
	virtualContent: Map<string, string | null>,
	snapshotPaths: Set<string>,
): Promise<void> {
	const filePath = await resolveSafeWorkspaceUri(createOp.uri, cwd, "create");
	await ensureFileResourceIsNotDirectory(filePath);
	if ((await fileExists(filePath)) && createOp.options?.overwrite !== true) return;
	snapshotPaths.add(filePath);
	virtualContent.set(createOp.uri, "");
}

async function prepareRenameOperation(
	renameOp: RenameFile,
	cwd: string,
	virtualContent: Map<string, string | null>,
	snapshotPaths: Set<string>,
): Promise<void> {
	const oldPath = await resolveSafeWorkspaceUri(renameOp.oldUri, cwd, "rename source");
	const newPath = await resolveSafeWorkspaceUri(renameOp.newUri, cwd, "rename destination");
	await ensureFileResourceIsNotDirectory(oldPath);
	await ensureFileResourceIsNotDirectory(newPath);
	snapshotPaths.add(oldPath);
	snapshotPaths.add(newPath);
	try {
		const content = virtualContent.has(renameOp.oldUri)
			? virtualContent.get(renameOp.oldUri)
			: await fs.readFile(oldPath, "utf-8");
		if (content !== null && content !== undefined) virtualContent.set(renameOp.newUri, content);
		virtualContent.set(renameOp.oldUri, null);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

async function prepareDeleteOperation(
	deleteOp: DeleteFile,
	cwd: string,
	virtualContent: Map<string, string | null>,
	snapshotPaths: Set<string>,
): Promise<void> {
	const filePath = await resolveSafeWorkspaceUri(deleteOp.uri, cwd, "delete");
	await ensureFileResourceIsNotDirectory(filePath);
	snapshotPaths.add(filePath);
	virtualContent.set(deleteOp.uri, null);
}

async function prepareDocumentChange(
	change: TextDocumentEdit | CreateFile | RenameFile | DeleteFile,
	cwd: string,
	virtualContent: Map<string, string | null>,
	snapshotPaths: Set<string>,
): Promise<void> {
	if ("textDocument" in change && change.textDocument && "edits" in change && change.edits) {
		await prepareTextEdits(
			change.textDocument.uri,
			extractTextEdits(change.edits),
			cwd,
			virtualContent,
			snapshotPaths,
		);
		return;
	}
	if (!("kind" in change) || !change.kind) return;
	if (change.kind === "create") await prepareCreateOperation(change as CreateFile, cwd, virtualContent, snapshotPaths);
	else if (change.kind === "rename")
		await prepareRenameOperation(change as RenameFile, cwd, virtualContent, snapshotPaths);
	else if (change.kind === "delete")
		await prepareDeleteOperation(change as DeleteFile, cwd, virtualContent, snapshotPaths);
}

async function prepareWorkspaceEdit(edit: WorkspaceEdit, cwd: string): Promise<FileSnapshot[]> {
	const snapshotPaths = new Set<string>();
	const virtualContent = new Map<string, string | null>();

	if (edit.changes) {
		const changes = edit.changes;
		for (const uri in changes) {
			await prepareTextEdits(uri, changes[uri], cwd, virtualContent, snapshotPaths);
		}
	}

	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			await prepareDocumentChange(change, cwd, virtualContent, snapshotPaths);
		}
	}

	const snapshots: FileSnapshot[] = [];
	for (const filePath of snapshotPaths) snapshots.push(await snapshotFile(filePath));
	return snapshots;
}

// =============================================================================
// Workspace Edit Application
// =============================================================================

/** Apply a workspace edit (collection of file changes). Returns descriptions. */
export async function applyWorkspaceEdit(edit: WorkspaceEdit, cwd: string): Promise<string[]> {
	const snapshots = await prepareWorkspaceEdit(edit, cwd);
	try {
		return await applyWorkspaceEditUnchecked(edit, cwd);
	} catch (err) {
		await restoreSnapshots(snapshots);
		throw new Error(`workspace edit failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function flushPendingTextEdits(
	uri: string,
	pending: Map<string, TextEdit[]>,
	cwd: string,
	applied: string[],
): Promise<void> {
	const edits = pending.get(uri);
	if (!edits) return;
	pending.delete(uri);
	const filePath = await resolveSafeWorkspaceUri(uri, cwd, "text edit");
	await applyTextEdits(filePath, edits);
	applied.push(`Applied ${edits.length} edit(s) to ${formatPathRelativeToCwd(filePath, cwd)}`);
}

async function flushPendingSubtree(
	uri: string,
	pending: Map<string, TextEdit[]>,
	cwd: string,
	applied: string[],
): Promise<void> {
	const prefix = uri.endsWith("/") ? uri : `${uri}/`;
	const matches: string[] = [];
	for (const candidate of pending.keys()) {
		if (candidate === uri || candidate.startsWith(prefix)) matches.push(candidate);
	}
	for (const target of matches) {
		await flushPendingTextEdits(target, pending, cwd, applied);
	}
}

function queueTextDocumentEdits(tdc: TextDocumentEdit, pending: Map<string, TextEdit[]>): void {
	const uri = tdc.textDocument.uri;
	const textEdits = extractTextEdits(tdc.edits);
	if (textEdits.length === 0) return;
	const prev = pending.get(uri);
	if (prev) prev.push(...textEdits);
	else pending.set(uri, [...textEdits]);
}

async function applyCreateOperation(
	createOp: CreateFile,
	pending: Map<string, TextEdit[]>,
	cwd: string,
	applied: string[],
): Promise<void> {
	await flushPendingTextEdits(createOp.uri, pending, cwd, applied);
	const filePath = await resolveSafeWorkspaceUri(createOp.uri, cwd, "create");
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	// Per LSP §3.16, `create` must not clobber an existing file unless
	// `overwrite:true`. With the default options (overwrite unset) or
	// `ignoreIfExists`, an already-present file is left untouched and the
	// op is a no-op — only write when absent or explicitly overwriting.
	if ((await fileExists(filePath)) && createOp.options?.overwrite !== true) {
		applied.push(`Skipped create of existing ${formatPathRelativeToCwd(filePath, cwd)}`);
		return;
	}
	await writeFileAtomic(filePath, "");
	applied.push(`Created ${formatPathRelativeToCwd(filePath, cwd)}`);
}

async function applyRenameOperation(
	renameOp: RenameFile,
	pending: Map<string, TextEdit[]>,
	cwd: string,
	applied: string[],
): Promise<void> {
	await flushPendingSubtree(renameOp.oldUri, pending, cwd, applied);
	await flushPendingSubtree(renameOp.newUri, pending, cwd, applied);
	const oldPath = await resolveSafeWorkspaceUri(renameOp.oldUri, cwd, "rename source");
	const newPath = await resolveSafeWorkspaceUri(renameOp.newUri, cwd, "rename destination");
	try {
		await fs.mkdir(path.dirname(newPath), { recursive: true });
		await fs.rename(oldPath, newPath);
		applied.push(`Renamed ${formatPathRelativeToCwd(oldPath, cwd)} -> ${formatPathRelativeToCwd(newPath, cwd)}`);
	} catch (err) {
		// A missing source (e.g. already renamed/removed by an earlier op in the
		// same batch, or a stale edit after a concurrent fs change) must not abort
		// the remaining documentChanges and the trailing flush loop.
		if (isEnoent(err)) {
			applied.push(`Skipped rename of missing ${formatPathRelativeToCwd(oldPath, cwd)}`);
			return;
		}
		throw err;
	}
}

async function applyDeleteOperation(
	deleteOp: DeleteFile,
	pending: Map<string, TextEdit[]>,
	cwd: string,
	applied: string[],
): Promise<void> {
	await flushPendingSubtree(deleteOp.uri, pending, cwd, applied);
	const filePath = await resolveSafeWorkspaceUri(deleteOp.uri, cwd, "delete");
	const ignoreMissing = deleteOp.options?.ignoreIfNotExists === true;
	try {
		// Honor LSP §3.16 DeleteFileOptions: `recursive` (default true here to
		// preserve prior behavior) and `ignoreIfNotExists` (force makes a missing
		// path a no-op instead of an ENOENT rejection that aborts the whole batch).
		await fs.rm(filePath, {
			recursive: deleteOp.options?.recursive ?? true,
			force: ignoreMissing,
		});
		applied.push(`Deleted ${formatPathRelativeToCwd(filePath, cwd)}`);
	} catch (err) {
		// A redundant delete of an already-gone path (e.g. removed by an earlier
		// op / overlapping rename's flushSubtree, or a stale edit) is a no-op,
		// never a batch-aborting crash that leaves a partially-applied workspace.
		if (isEnoent(err)) {
			applied.push(`Skipped delete of missing ${formatPathRelativeToCwd(filePath, cwd)}`);
			return;
		}
		throw err;
	}
}

async function applyDocumentChange(
	change: TextDocumentEdit | CreateFile | RenameFile | DeleteFile,
	pending: Map<string, TextEdit[]>,
	cwd: string,
	applied: string[],
): Promise<void> {
	if ("textDocument" in change && change.textDocument && "edits" in change && change.edits) {
		queueTextDocumentEdits(change, pending);
		return;
	}
	if (!("kind" in change) || !change.kind) return;
	if (change.kind === "create") await applyCreateOperation(change as CreateFile, pending, cwd, applied);
	else if (change.kind === "rename") await applyRenameOperation(change as RenameFile, pending, cwd, applied);
	else if (change.kind === "delete") await applyDeleteOperation(change as DeleteFile, pending, cwd, applied);
}

async function applyLegacyChanges(edit: WorkspaceEdit, cwd: string, applied: string[]): Promise<void> {
	if (!edit.changes) return;
	const changes = edit.changes;
	for (const uri in changes) {
		const textEdits = changes[uri];
		if (textEdits.length === 0) continue;
		const filePath = await resolveSafeWorkspaceUri(uri, cwd, "text edit");
		await applyTextEdits(filePath, textEdits);
		applied.push(`Applied ${textEdits.length} edit(s) to ${formatPathRelativeToCwd(filePath, cwd)}`);
	}
}

async function applyWorkspaceEditUnchecked(edit: WorkspaceEdit, cwd: string): Promise<string[]> {
	const applied: string[] = [];

	if (!edit.documentChanges) {
		await applyLegacyChanges(edit, cwd, applied);
		return applied;
	}

	const pending = new Map<string, TextEdit[]>();
	for (const change of edit.documentChanges) {
		await applyDocumentChange(change, pending, cwd, applied);
	}
	for (const [uri] of pending) {
		await flushPendingTextEdits(uri, pending, cwd, applied);
	}
	return applied;
}
