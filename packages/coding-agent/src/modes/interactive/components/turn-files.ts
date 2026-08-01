/**
 * TurnFilesComponent — what THIS turn changed, as standing state.
 *
 * The footer already carries the repo's working-tree delta (`+9096 −1684`), but
 * that is the whole branch: it cannot answer "what did the agent just touch?",
 * which is the question you actually have when a turn ends and you are deciding
 * whether to read the diff. The activity stream answers it only in passing —
 * `3 files·9 commands` collapses the names away, and scrolling back for them is
 * exactly the work the rail exists to remove.
 *
 * So this is a per-turn ledger: file (basename, path on collision), lines added,
 * lines removed. Ordered by first touch, because that reproduces the story the
 * agent told; a file edited three times keeps its original slot and accumulates.
 *
 * Auto-hides: an empty ledger renders zero lines, which is what lets
 * {@link SideBySide} give the full width back to the main column on a turn that
 * only read code.
 */

import { type Component, truncateToWidth, visibleWidth } from "@pit/tui";
import { theme } from "../theme/theme.ts";
import { pluralCountLabel } from "./context-display.ts";

/** One file's accumulated delta for the current turn. */
export interface TurnFileEntry {
	/** Path as the tool reported it (already cwd-relative where possible). */
	path: string;
	added: number;
	removed: number;
}

/**
 * Rows of files before the list collapses into a "+N" tail.
 *
 * Kept low on purpose: the rail shares a band with the live composer, so every
 * row it gains pushes the editor down WHILE the user may be typing into it. The
 * band's worst case is what matters, not its average — header + rows + tail, so
 * 5 caps it at 7 lines. Past the fifth file the list has already stopped being a
 * glance and become a scroll; "+N more" carries the rest without moving anything.
 */
const MAX_ROWS = 5;
/** Minimum columns a name gets before the counters are dropped instead. */
const MIN_NAME_COLS = 10;

/**
 * Count added/removed lines in the edit tool's diff format (`+12 text` /
 * `-12 text`, line number padded). Context rows start with a space, so a plain
 * first-char test is enough — there are no `+++`/`---` file headers here.
 */
export function countDiffLines(diff: string | undefined): { added: number; removed: number } {
	if (!diff) return { added: 0, removed: 0 };
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/** Last path segment, which is what identifies a file at a glance. */
function basename(path: string): string {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return cut === -1 ? path : path.slice(cut + 1);
}

/** Path segments, separator-agnostic (a Windows path labels like a POSIX one). */
function segments(path: string): string[] {
	return path.split(/[/\\]/).filter(Boolean);
}

/**
 * Display labels for the ledger: the basename alone, unless two files share one
 * — a turn that edits `index.ts` in three packages must not render three
 * identical rows. A colliding row takes one more parent segment, and KEEPS
 * TAKING until its label is actually unique.
 *
 * Stopping at a single parent (what this used to do) is exactly one level short
 * of the case that matters here: in a monorepo the collisions are
 * `packages/ui/src/index.ts` vs `packages/tui/src/index.ts`, which share the
 * parent too and both render `src/index.ts` — two identical rows in a rail whose
 * entire job is saying WHICH files the turn touched. Climbing until unique gives
 * `ui/src/index.ts` and `tui/src/index.ts`: the shortest suffix that answers the
 * question. Rows that never collided still render as a bare basename, so the
 * extra path shows up only where it earns its width.
 *
 * Identical paths cannot be told apart by any suffix; they settle at the full
 * path rather than looping (the ledger keys by path, so this is defensive only).
 */
export function labelPaths(paths: readonly string[]): string[] {
	const parts = paths.map(segments);
	const depth = parts.map(() => 1);
	const labelAt = (i: number): string => parts[i]!.slice(-depth[i]!).join("/") || paths[i]!;

	for (;;) {
		const groups = new Map<string, number[]>();
		for (let i = 0; i < paths.length; i++) {
			const label = labelAt(i);
			const group = groups.get(label);
			if (group) group.push(i);
			else groups.set(label, [i]);
		}
		let grew = false;
		for (const group of groups.values()) {
			if (group.length < 2) continue;
			// Only rows with a segment left to take can climb; a group where none can
			// (identical paths) is left as-is, which is what terminates the loop.
			for (const i of group) {
				if (depth[i]! >= parts[i]!.length) continue;
				depth[i]!++;
				grew = true;
			}
		}
		if (!grew) return paths.map((_, i) => labelAt(i));
	}
}

/**
 * Longest SUFFIX of `text` that fits in `cols` columns.
 *
 * Walks code points (not code units) and adds up display width, because neither
 * unit the obvious `slice` would use is the one that matters: `slice(-n)` counts
 * UTF-16 code units, so a CJK name — two columns per character — overshoots the
 * budget by up to 2×, and a name ending in astral characters can be cut through
 * the middle of a surrogate pair.
 */
function tailToWidth(text: string, cols: number): string {
	const chars = Array.from(text);
	let out = "";
	let width = 0;
	for (let i = chars.length - 1; i >= 0; i--) {
		const w = visibleWidth(chars[i]!);
		if (width + w > cols) break;
		out = chars[i] + out;
		width += w;
	}
	return out;
}

/**
 * Shorten to fit while keeping the identifying end of the name: a truncated
 * `…issionBar.tsx` still reads, `MissionB…` does not.
 *
 * A multi-segment label (one {@link labelPaths} widened to break a collision)
 * gets one attempt at keeping BOTH ends first — `tui/…/index.ts`. Dropping the
 * leading segment is the one truncation that defeats the label: it is precisely
 * what distinguishes this row from the other one it collided with.
 */
function fitName(name: string, cols: number): string {
	if (visibleWidth(name) <= cols) return name;
	const parts = segments(name);
	if (parts.length > 2) {
		const elided = `${parts[0]}/…/${parts[parts.length - 1]}`;
		if (visibleWidth(elided) <= cols) return elided;
	}
	return `…${tailToWidth(name, Math.max(1, cols - 1))}`;
}

export class TurnFilesComponent implements Component {
	private entries: TurnFileEntry[] = [];
	private cacheKey = "";
	private cacheWidth = -1;
	private cacheLines: string[] | null = null;

	/** Replace the ledger (the mode owns accumulation; this only draws). */
	setEntries(entries: readonly TurnFileEntry[]): void {
		this.entries = entries.map((e) => ({ ...e }));
		this.invalidate();
	}

	invalidate(): void {
		this.cacheKey = "";
		this.cacheWidth = -1;
		this.cacheLines = null;
	}

	private key(): string {
		return this.entries.map((e) => `${e.path}:${e.added}:${e.removed}`).join("|");
	}

	render(width: number): string[] {
		if (this.entries.length === 0) return [];
		const key = this.key();
		if (this.cacheLines !== null && this.cacheKey === key && this.cacheWidth === width) return this.cacheLines;

		const shown = this.entries.slice(0, MAX_ROWS);
		const hidden = this.entries.length - shown.length;
		const labels = labelPaths(shown.map((e) => e.path));
		const lines: string[] = [];
		// Header in the UI's language (English), like every other chrome string.
		const count = this.entries.length;
		lines.push(theme.fg("dim", truncateToWidth(`${pluralCountLabel(count, "file", "files")} this turn`, width, "…")));

		for (const [i, entry] of shown.entries()) {
			const label = labels[i] ?? basename(entry.path);
			const counters = `+${entry.added} −${entry.removed}`;
			const nameCols = width - visibleWidth(counters) - 1;
			// Too narrow for both → the name wins; the counters are the redundant
			// half (the footer still has the repo total).
			if (nameCols < MIN_NAME_COLS) {
				lines.push(theme.fg("muted", truncateToWidth(label, width, "…")));
				continue;
			}
			const name = fitName(label, nameCols);
			const filler = " ".repeat(Math.max(1, nameCols - visibleWidth(name) + 1));
			const painted =
				theme.fg("muted", name) +
				filler +
				theme.fg("success", `+${entry.added}`) +
				" " +
				theme.fg("error", `−${entry.removed}`);
			lines.push(painted);
		}
		if (hidden > 0) lines.push(theme.fg("dim", truncateToWidth(`+${hidden} more`, width, "…")));

		this.cacheKey = key;
		this.cacheWidth = width;
		this.cacheLines = lines;
		return lines;
	}
}
