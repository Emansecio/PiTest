/**
 * Hashline edit support: edits anchored by sha256[0:8] hashes of 3-line windows
 * instead of full oldText. Reduces output tokens by ~2 hashes (16 chars) per edit
 * versus a copied block. Sequential by design — each edit re-hashes the working
 * buffer so the next edit's anchors stay correct.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { type EditDiffError, type EditDiffResult, generateDiffString, normalizeToLF, stripBom } from "./edit-diff.ts";
import { resolveToCwd } from "./path-utils.ts";

export const HASHLINE_WINDOW = 3;
export const HASHLINE_HASH_LEN = 8;
export const ANCHOR_STRIDE = 3;

export interface HashlineEdit {
	before_hash: string;
	after_hash: string;
	new_text: string;
}

export type HashlineError =
	| { kind: "not_found"; which: "before_hash" | "after_hash"; editIndex: number; hash: string; nearby: number[] }
	| { kind: "ambiguous"; which: "before_hash" | "after_hash"; editIndex: number; hash: string; matches: number[] }
	| { kind: "overlap"; editIndex: number };

export class HashlineEditError extends Error {
	readonly detail: HashlineError;
	constructor(detail: HashlineError, message: string) {
		super(message);
		this.detail = detail;
		this.name = "HashlineEditError";
	}
}

function hashWindow(lines: string[], start: number): string {
	return createHash("sha256")
		.update(lines.slice(start, start + HASHLINE_WINDOW).join("\n"))
		.digest("hex")
		.slice(0, HASHLINE_HASH_LEN);
}

/** Map of 8-hex anchor hash -> list of start line indices (0-based) for the 3-line window. */
export function computeAnchorIndex(content: string): Map<string, number[]> {
	const lines = content.split("\n");
	const index = new Map<string, number[]>();
	const last = lines.length - HASHLINE_WINDOW;
	for (let i = 0; i <= last; i++) {
		const h = hashWindow(lines, i);
		const bucket = index.get(h);
		if (bucket) bucket.push(i);
		else index.set(h, [i]);
	}
	return index;
}

export const ANCHOR_DEFAULT_MAX_BYTES = 2048;

/**
 * Compact anchor block for inclusion in read output. Emits one anchor every
 * `stride` windows so the table is small enough to be cheaper than the tokens
 * it saves on edits. If the serialized body exceeds `maxBytes`, the stride is
 * doubled until the body fits or no anchors remain. The surrounding
 * `<anchors>` tags are added by the caller and not counted toward maxBytes.
 */
export function formatAnchorsForRead(
	content: string,
	opts?: { stride?: number; maxBytes?: number; lines?: string[] },
): string {
	const initialStride = Math.max(1, opts?.stride ?? ANCHOR_STRIDE);
	const maxBytes = Math.max(0, opts?.maxBytes ?? ANCHOR_DEFAULT_MAX_BYTES);
	// Reuse a pre-split line array when the caller already has one (read.ts splits
	// the full content for line slicing). Falls back to splitting when absent.
	const lines = opts?.lines ?? content.split("\n");
	const last = lines.length - HASHLINE_WINDOW;
	if (last < 0) {
		return `# anchors (${HASHLINE_WINDOW}-line windows, sha256[0:${HASHLINE_HASH_LEN}], stride=${initialStride})`;
	}

	let stride = initialStride;
	let body = renderAnchorBlock(lines, last, stride);
	while (Buffer.byteLength(body, "utf-8") > maxBytes) {
		const nextStride = stride * 2;
		if (nextStride > last + 1) {
			return "# anchors omitted: file too large for inline anchor block";
		}
		stride = nextStride;
		body = renderAnchorBlock(lines, last, stride);
	}
	return body;
}

function renderAnchorBlock(lines: string[], last: number, stride: number): string {
	const out: string[] = [
		`# anchors (${HASHLINE_WINDOW}-line windows, sha256[0:${HASHLINE_HASH_LEN}], stride=${stride})`,
	];
	for (let i = 0; i <= last; i += stride) {
		out.push(`# L${i + 1} ${hashWindow(lines, i)}`);
	}
	return out.join("\n");
}

/**
 * Compute interleaved per-line anchors for the given content. For every line
 * whose 1-indexed number is on the stride (window start has a hash), returns
 * a string of the form `L<n> <hash> │ <code>`. Other lines pass through
 * unchanged. The window-end region (last HASHLINE_WINDOW - 1 lines) cannot
 * carry an anchor and is also passed through.
 */
export function interleaveAnchorsIntoLines(content: string, opts?: { stride?: number }): string {
	const stride = Math.max(1, opts?.stride ?? ANCHOR_STRIDE);
	const lines = content.split("\n");
	const last = lines.length - HASHLINE_WINDOW;
	if (last < 0) return content;
	const out = lines.slice();
	for (let i = 0; i <= last; i += stride) {
		const hash = hashWindow(lines, i);
		out[i] = `L${i + 1} ${hash} │ ${lines[i]}`;
	}
	return out.join("\n");
}

/** sha256 hash per line, truncated to HASHLINE_HASH_LEN. */
function computeLineHashes(lines: string[]): string[] {
	return lines.map((line) => createHash("sha256").update(line).digest("hex").slice(0, HASHLINE_HASH_LEN));
}

function nearbyLineNumbers(
	lines: string[],
	hash: string,
	limit: number,
	precomputedIndex: Map<string, number[]>,
): number[] {
	// Walk windows and score 2-of-3 line-hash agreement against the union of
	// line-hashes from windows that fully matched `hash`. If no window matches
	// fully, fall back to windows whose hash shares a 2-hex prefix with `hash`.
	const lineHashes = computeLineHashes(lines);
	const last = lines.length - HASHLINE_WINDOW;
	if (last < 0) return [];

	const fullMatchLineHashes = new Set<string>();
	const prefixMatchLineHashes = new Set<string>();
	const prefix = hash.slice(0, 2);

	// Reuse precomputed window hashes instead of re-hashing every window.
	for (const [wh, positions] of precomputedIndex) {
		if (wh === hash) {
			for (const i of positions) {
				fullMatchLineHashes.add(lineHashes[i]);
				if (i + 1 < lineHashes.length) fullMatchLineHashes.add(lineHashes[i + 1]);
				if (i + 2 < lineHashes.length) fullMatchLineHashes.add(lineHashes[i + 2]);
			}
		} else if (wh.startsWith(prefix)) {
			for (const i of positions) {
				prefixMatchLineHashes.add(lineHashes[i]);
				if (i + 1 < lineHashes.length) prefixMatchLineHashes.add(lineHashes[i + 1]);
				if (i + 2 < lineHashes.length) prefixMatchLineHashes.add(lineHashes[i + 2]);
			}
		}
	}

	const refSet = fullMatchLineHashes.size > 0 ? fullMatchLineHashes : prefixMatchLineHashes;
	if (refSet.size === 0) return [];

	const ranked: Array<{ line: number; score: number }> = [];
	for (let i = 0; i <= last; i++) {
		let score = 0;
		if (refSet.has(lineHashes[i])) score++;
		if (refSet.has(lineHashes[i + 1])) score++;
		if (refSet.has(lineHashes[i + 2])) score++;
		if (score >= 2) ranked.push({ line: i + 1, score });
	}
	ranked.sort((a, b) => b.score - a.score || a.line - b.line);
	return ranked.slice(0, limit).map((c) => c.line);
}

function findAnchor(
	lines: string[],
	hash: string,
	editIndex: number,
	which: "before_hash" | "after_hash",
	minStart: number,
	index: Map<string, number[]>,
): number {
	const all = index.get(hash) ?? [];
	const filtered = all.filter((i) => i >= minStart);
	if (filtered.length === 0) {
		// The hash DOES exist, just not after the before window — distinct from truly
		// absent. Saying "not found, re-read" sends the model into a sterile retry (it
		// re-reads, sees the same hash, and is none the wiser). Tell it the real cause.
		if (all.length > 0) {
			const at = all.map((i) => i + 1);
			throw new HashlineEditError(
				{ kind: "not_found", which, editIndex, hash, nearby: all },
				`edits[${editIndex}].${which} ${hash} exists at line(s) ${at.join(", ")} but at/before the before_hash window (must start at line ${minStart + 1} or later); after_hash must come after before_hash. Swap the anchors or pick an after_hash further down.`,
			);
		}
		const nearby = nearbyLineNumbers(lines, hash, 3, index);
		const nearbyStr = nearby.length > 0 ? ` Nearby lines: ${nearby.join(", ")}.` : "";
		throw new HashlineEditError(
			{ kind: "not_found", which, editIndex, hash, nearby },
			`edits[${editIndex}].${which} ${hash} not found.${nearbyStr} Re-read the file to get fresh anchors.`,
		);
	}
	if (filtered.length > 1) {
		const matches = filtered.map((i) => i + 1);
		throw new HashlineEditError(
			{ kind: "ambiguous", which, editIndex, hash, matches },
			`edits[${editIndex}].${which} ${hash} is ambiguous (matches lines ${matches.join(", ")}). Re-read the file to get fresh anchors.`,
		);
	}
	return filtered[0];
}

/**
 * Compute the diff for a set of hashline edits without applying them. Used by
 * the TUI preview pipeline to render a pending diff before the tool executes.
 * Shape matches `computeEditsDiff` from `edit-diff.ts`.
 */
export async function computeHashlineEditsDiff(
	path: string,
	edits: HashlineEdit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);
	try {
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}
		const rawContent = await readFile(absolutePath, "utf-8");
		const { text: content } = stripBom(rawContent);
		const baseContent = normalizeToLF(content);
		const { newContent } = applyHashlineEdits(baseContent, edits, path);
		if (baseContent === newContent) {
			return { error: `No changes made to ${path}. Hashline edits produced identical content.` };
		}
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export function applyHashlineEdits(
	content: string,
	edits: HashlineEdit[],
	_path: string,
): { newContent: string; appliedCount: number } {
	let lines = content.split("\n");
	let applied = 0;

	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		const anchorIndex = computeAnchorIndex(lines.join("\n"));
		const beforeStart = findAnchor(lines, edit.before_hash, i, "before_hash", 0, anchorIndex);
		// after window must start strictly after the before window ends
		const afterStart = findAnchor(
			lines,
			edit.after_hash,
			i,
			"after_hash",
			beforeStart + HASHLINE_WINDOW,
			anchorIndex,
		);
		const replaceStart = beforeStart + HASHLINE_WINDOW;
		const replaceEnd = afterStart; // exclusive
		if (replaceEnd < replaceStart) {
			throw new HashlineEditError(
				{ kind: "overlap", editIndex: i },
				`edits[${i}] anchors overlap: after_hash window starts before before_hash window ends.`,
			);
		}
		const replacement = edit.new_text === "" ? [] : edit.new_text.split("\n");
		lines = [...lines.slice(0, replaceStart), ...replacement, ...lines.slice(replaceEnd)];
		applied++;
	}

	return { newContent: lines.join("\n"), appliedCount: applied };
}
