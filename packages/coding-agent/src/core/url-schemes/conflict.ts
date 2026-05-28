/**
 * `conflict://` URL scheme: enumerate and resolve merge-conflict blocks in the
 * working tree.
 *
 * Forms:
 *   conflict://<N>   read or resolve the Nth conflict block across all files
 *   conflict://*     read all conflicts, or apply a bulk @ours/@theirs/@base resolution
 *
 * Read:
 *   - Block format includes the file path and line range so the model can locate it.
 *   - Bulk read returns all conflicts in a flat list.
 *
 * Write:
 *   - `@ours`, `@theirs`, or `@base` selects a side. (`@base` may not exist in
 *     2-way conflicts; in that case the operation fails for the affected blocks.)
 *   - Any other content is applied verbatim as the resolution body.
 *   - Bulk writes only accept the `@...` shortcuts.
 */

import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { UrlContext, UrlReadResult, UrlSchemeResolver } from "./registry.ts";

const CONFLICT_START = /^<{7}(?:\s|$)/;
const CONFLICT_BASE = /^\|{7}(?:\s|$)/;
const CONFLICT_MID = /^={7}\s*$/;
const CONFLICT_END = /^>{7}(?:\s|$)/;

const IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	".next",
	".nuxt",
	"dist",
	"build",
	"out",
	".turbo",
	".cache",
	".venv",
	"venv",
	"target",
	"__pycache__",
]);

interface ConflictBlock {
	file: string; // absolute path
	relPath: string; // path relative to cwd, posix-style
	startLine: number; // 1-indexed, line with `<<<<<<<`
	endLine: number; // 1-indexed, line with `>>>>>>>`
	ours: string[]; // lines (no terminator) between start and base/mid
	base?: string[]; // lines between base and mid, if diff3 marker present
	theirs: string[]; // lines between mid and end
	oursLabel: string;
	theirsLabel: string;
}

interface FileConflicts {
	file: string;
	relPath: string;
	originalLines: string[];
	hadTrailingNewline: boolean;
	blocks: ConflictBlock[];
}

async function listFilesRecursively(root: string): Promise<string[]> {
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") && IGNORED_DIRS.has(entry.name)) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (IGNORED_DIRS.has(entry.name)) continue;
				stack.push(full);
			} else if (entry.isFile()) {
				out.push(full);
			}
		}
	}
	return out;
}

function looksBinary(buf: Buffer): boolean {
	const limit = Math.min(buf.length, 8000);
	for (let i = 0; i < limit; i++) {
		if (buf[i] === 0) return true;
	}
	return false;
}

function parseFileConflicts(file: string, relPath: string, content: string): FileConflicts | undefined {
	const hadTrailingNewline = content.endsWith("\n");
	const lines = hadTrailingNewline ? content.slice(0, -1).split("\n") : content.split("\n");
	const blocks: ConflictBlock[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!CONFLICT_START.test(line)) {
			i++;
			continue;
		}
		const startLine = i + 1;
		const oursLabel = line.replace(/^<{7}\s*/, "").trim();
		const ours: string[] = [];
		const base: string[] = [];
		const theirs: string[] = [];
		let section: "ours" | "base" | "theirs" = "ours";
		let theirsLabel = "";
		let endLine = -1;
		let j = i + 1;
		for (; j < lines.length; j++) {
			const cur = lines[j];
			if (CONFLICT_BASE.test(cur)) {
				section = "base";
				continue;
			}
			if (CONFLICT_MID.test(cur)) {
				section = "theirs";
				continue;
			}
			if (CONFLICT_END.test(cur)) {
				endLine = j + 1;
				theirsLabel = cur.replace(/^>{7}\s*/, "").trim();
				break;
			}
			if (section === "ours") ours.push(cur);
			else if (section === "base") base.push(cur);
			else theirs.push(cur);
		}
		if (endLine === -1) {
			// Unterminated conflict; bail to avoid false positives downstream.
			break;
		}
		blocks.push({
			file,
			relPath,
			startLine,
			endLine,
			ours,
			base: base.length > 0 || hadDiff3Marker(lines, startLine - 1, endLine - 1) ? base : undefined,
			theirs,
			oursLabel,
			theirsLabel,
		});
		i = endLine;
	}
	if (blocks.length === 0) return undefined;
	return { file, relPath, originalLines: lines, hadTrailingNewline, blocks };
}

function hadDiff3Marker(lines: string[], start: number, end: number): boolean {
	for (let i = start; i <= end; i++) {
		if (CONFLICT_BASE.test(lines[i])) return true;
	}
	return false;
}

// 5-second TTL memoize per cwd. Read paths reuse the cached scan; write paths
// invalidate before reading to ensure correctness against on-disk mutations.
const SCAN_TTL_MS = 5000;
const scanCache = new Map<string, { at: number; results: FileConflicts[] }>();

function invalidateScanCache(cwd: string): void {
	scanCache.delete(cwd);
}

async function scanConflictsRaw(cwd: string): Promise<FileConflicts[]> {
	const root = cwd;
	const files = await listFilesRecursively(root);
	const results: FileConflicts[] = [];
	for (const file of files) {
		let s: Stats;
		try {
			s = await stat(file);
		} catch {
			continue;
		}
		// Skip enormous files for safety.
		if (s.size > 8 * 1024 * 1024) continue;
		let buf: Buffer;
		try {
			buf = await readFile(file);
		} catch {
			continue;
		}
		if (looksBinary(buf)) continue;
		const text = buf.toString("utf-8");
		if (!text.includes("<<<<<<<")) continue;
		const relPath = relative(root, file).split(sep).join("/");
		const parsed = parseFileConflicts(file, relPath, text);
		if (parsed) results.push(parsed);
	}
	// Stable order: by relative path so indices are deterministic across runs.
	results.sort((a, b) => a.relPath.localeCompare(b.relPath));
	return results;
}

async function scanConflicts(cwd: string): Promise<FileConflicts[]> {
	const cached = scanCache.get(cwd);
	const now = Date.now();
	if (cached && now - cached.at < SCAN_TTL_MS) return cached.results;
	const results = await scanConflictsRaw(cwd);
	scanCache.set(cwd, { at: now, results });
	return results;
}

function flattenBlocks(files: FileConflicts[]): ConflictBlock[] {
	const out: ConflictBlock[] = [];
	for (const f of files) out.push(...f.blocks);
	return out;
}

function formatBlock(block: ConflictBlock, index: number, total: number): string {
	const lines: string[] = [];
	lines.push(
		`=== conflict ${index} of ${total} (file: ${block.relPath}, lines ${block.startLine}-${block.endLine}) ===`,
	);
	lines.push(`<<<<<<< ${block.oursLabel || "ours"}`);
	for (const l of block.ours) lines.push(l);
	if (block.base) {
		lines.push("||||||| base");
		for (const l of block.base) lines.push(l);
	}
	lines.push("=======");
	lines.push("theirs");
	for (const l of block.theirs) lines.push(l);
	lines.push(`>>>>>>> ${block.theirsLabel || "theirs"}`);
	return lines.join("\n");
}

interface IndexSelector {
	kind: "single" | "all";
	index?: number;
}

function parseSelector(url: URL): IndexSelector | { error: string } {
	const host = decodeURIComponent(url.hostname);
	if (host === "*") return { kind: "all" };
	if (/^\d+$/.test(host)) {
		const idx = Number.parseInt(host, 10);
		if (idx < 1) return { error: "conflict index must be >= 1" };
		return { kind: "single", index: idx };
	}
	return { error: `invalid conflict:// selector: ${host}` };
}

function resolutionLinesFor(block: ConflictBlock, content: string): string[] | { error: string } {
	if (content === "@ours") return block.ours;
	if (content === "@theirs") return block.theirs;
	if (content === "@base") {
		if (!block.base) {
			return { error: `block at ${block.relPath}:${block.startLine} has no base section (not a diff3 conflict)` };
		}
		return block.base;
	}
	// Custom content: split on newlines, drop a trailing newline if present so we
	// don't introduce a duplicate blank line when splicing back in.
	const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
	return normalized.split("\n");
}

async function applyResolutionToFile(
	fc: FileConflicts,
	resolutions: Map<number, string[]>, // 1-indexed block index within this file -> replacement lines
): Promise<void> {
	// Apply from bottom to top to keep line indices stable.
	const entries = Array.from(resolutions.entries()).sort((a, b) => b[0] - a[0]);
	const lines = fc.originalLines.slice();
	for (const [blockIndex, replacement] of entries) {
		const block = fc.blocks[blockIndex - 1];
		if (!block) continue;
		const startIdx = block.startLine - 1;
		const endIdx = block.endLine - 1;
		lines.splice(startIdx, endIdx - startIdx + 1, ...replacement);
	}
	const joined = lines.join("\n") + (fc.hadTrailingNewline ? "\n" : "");
	await writeFile(fc.file, joined, "utf-8");
}

export function createConflictSchemeResolver(): UrlSchemeResolver {
	return {
		scheme: "conflict",
		async read(url: URL, ctx: UrlContext): Promise<UrlReadResult> {
			const selector = parseSelector(url);
			if ("error" in selector) return { kind: "error", error: selector.error };
			const files = await scanConflicts(ctx.cwd);
			const blocks = flattenBlocks(files);
			if (blocks.length === 0) {
				return { kind: "text", content: "[no merge conflicts found in working tree]" };
			}
			if (selector.kind === "all") {
				const out = blocks.map((b, i) => formatBlock(b, i + 1, blocks.length)).join("\n\n");
				return { kind: "text", content: out };
			}
			const idx = selector.index ?? 0;
			if (idx < 1 || idx > blocks.length) {
				return {
					kind: "error",
					error: `conflict index ${idx} out of range (working tree has ${blocks.length} blocks)`,
				};
			}
			return { kind: "text", content: formatBlock(blocks[idx - 1], idx, blocks.length) };
		},
		canWrite(_url: URL): boolean {
			return true;
		},
		async write(url: URL, content: string, ctx: UrlContext): Promise<void> {
			const selector = parseSelector(url);
			if ("error" in selector) throw new Error(selector.error);
			// Writes mutate the working tree — drop the cache so the next read
			// reflects post-resolution state.
			invalidateScanCache(ctx.cwd);
			const files = await scanConflicts(ctx.cwd);
			const blocks = flattenBlocks(files);
			if (blocks.length === 0) throw new Error("no merge conflicts found in working tree");

			if (selector.kind === "all") {
				if (content !== "@ours" && content !== "@theirs" && content !== "@base") {
					throw new Error(
						"bulk conflict://* resolution requires @ours, @theirs, or @base (custom content not allowed)",
					);
				}
				// Group blocks back to their owning file and compute the resolution per block.
				for (const fc of files) {
					const resolutions = new Map<number, string[]>();
					for (let i = 0; i < fc.blocks.length; i++) {
						const block = fc.blocks[i];
						const r = resolutionLinesFor(block, content);
						if (!Array.isArray(r)) throw new Error(r.error);
						resolutions.set(i + 1, r);
					}
					await applyResolutionToFile(fc, resolutions);
				}
				invalidateScanCache(ctx.cwd);
				return;
			}

			const idx = selector.index ?? 0;
			if (idx < 1 || idx > blocks.length) {
				throw new Error(`conflict index ${idx} out of range (working tree has ${blocks.length} blocks)`);
			}
			const target = blocks[idx - 1];
			// Find which file owns this block and its file-local index.
			let owner: FileConflicts | undefined;
			let localIndex = -1;
			for (const fc of files) {
				const j = fc.blocks.indexOf(target);
				if (j !== -1) {
					owner = fc;
					localIndex = j + 1;
					break;
				}
			}
			if (!owner) throw new Error("internal: could not locate conflict block owner file");
			const r = resolutionLinesFor(target, content);
			if (!Array.isArray(r)) throw new Error(r.error);
			await applyResolutionToFile(owner, new Map([[localIndex, r]]));
			invalidateScanCache(ctx.cwd);
		},
	};
}
