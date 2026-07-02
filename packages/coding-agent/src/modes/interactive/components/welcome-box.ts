/**
 * Welcome box: the framed identity block shown at startup.
 *
 * Pit-native framing uses the shared {@link Card} primitive (`@pit/tui`) with
 * `visibleWidth()` / `truncateToWidth()` on every composed line — 4-sided
 * rounded frames are safe on narrow terminals.
 *
 * Layout (3 identity rows inside a card):
 *   ╭──────────────────────────────────────────────────────────╮
 *   │  █▀█ █ ▀█▀   coding agent in your terminal      v0.4.2  │
 *   │  █▀▀ █  █    ● Workspace — PiTest/src (main)            │
 *   │  ▀   ▀  ▀    ├─ Resuming · session-name   (when applicable)
 *   ╰──────────────────────────────────────────────────────────╯
 *
 * The hint/tip line is rendered separately (below) so its expand toggle stays
 * owned by interactive-mode.
 */

import { Card, type Component, truncateToWidth, visibleWidth } from "@pit/tui";
import type { GitDiffStats } from "../../../core/footer-data-provider.ts";
import { formatGitBranchWithDiff } from "../display-utils.ts";
import { wordmarkGradient } from "../theme/color-interpolation.ts";
import { theme } from "../theme/theme.ts";

// 3-row half-block wordmark spelling P-I-T. Each row is exactly 9 visible columns
// (U+2588/U+2580 + spaces are width-1). Wider/smoothed variants were tried and
// misread as other letters — keep this compact pixel font.
const WORDMARK_PIT: readonly string[] = ["█▀█ █ ▀█▀", "█▀▀ █  █ ", "▀   ▀  ▀ "];
const WORDMARK_WIDTH = 9;

export interface WelcomeBoxData {
	appName: string;
	version: string;
	/** One-line tagline, e.g. "coding agent in your terminal". */
	tagline: string;
	/** Display path of the session cwd (repo-relative or home-shortened). */
	cwdDisplay: string;
	/** `shell: …` when launcher cwd differs from session cwd. */
	shellCwdNote?: string;
	branch?: string;
	/** Working-tree diff stats for branch suffix (optional). */
	diffStats?: GitDiffStats | null;
	/** When resuming, the session name to surface in place of the cwd. */
	resumedSessionName?: string;
	/** Color function for the wordmark (lets interactive-mode ease it in on mount). */
	wordmarkColor?: (s: string) => string;
	/** Horizontal padding inside the card frame (default 1). */
	cardPaddingX?: number;
}

/** Renders the inner identity rows at the width Card gives its child. */
class WelcomeBoxBody implements Component {
	private host: WelcomeBox;

	constructor(host: WelcomeBox) {
		this.host = host;
	}

	invalidate(): void {
		// Body reads fresh from host each frame.
	}

	render(width: number): string[] {
		return this.host.computeInnerRows(width);
	}
}

/** `● Workspace — PiTest/src (main) · shell: ~/pit` — always shown for orientation. */
function formatWorkspaceLine(
	cwdDisplay: string,
	branch: string | undefined,
	diffStats: GitDiffStats | null | undefined,
	shellCwdNote: string | undefined,
	width: number,
): string {
	let path = theme.fg("accent", cwdDisplay);
	if (branch !== undefined && branch !== "") {
		const branchLabel = formatGitBranchWithDiff(branch, diffStats);
		path = `${path}${theme.fg("dim", " (")}${branchLabel}${theme.fg("dim", ")")}`;
	}
	if (shellCwdNote) {
		path = `${path}${theme.fg("dim", ` · ${shellCwdNote}`)}`;
	}
	const header = `${theme.fg("accent", "●")} ${theme.bold("Workspace")} ${theme.fg("dim", "—")} `;
	const line = header + path;
	return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
}

function formatResumeLine(sessionName: string, width: number): string {
	const body = theme.fg("muted", `Resuming · ${sessionName}`);
	const line = `${theme.fg("dim", "├─ ")}${body}`;
	return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
}

/** Place `left` and `right` on one line `width` wide, right-aligning `right`. */
function composeLeftRight(left: string, right: string, width: number): string {
	const rightW = visibleWidth(right);
	const leftMax = Math.max(0, width - rightW - 1);
	const leftFit = visibleWidth(left) > leftMax ? truncateToWidth(left, leftMax) : left;
	const gap = Math.max(1, width - visibleWidth(leftFit) - rightW);
	return leftFit + " ".repeat(gap) + right;
}

export class WelcomeBox implements Component {
	private data: WelcomeBoxData;
	private card: Card;
	private body: WelcomeBoxBody;
	// Memoized output, keyed by (width, data reference). The data object is
	// treated as immutable — setData swaps the reference, so a reference match
	// plus equal width means byte-identical output. Theme changes are covered by
	// `ui.invalidate()` cascading down to this component. When `wordmarkColor` is
	// present the memo is bypassed entirely: it may be a time-varying closure
	// (e.g. an ease animating the logo on mount), so the same (width, data) pair
	// could legitimately produce different bytes between frames.
	private cachedWidth = -1;
	private cachedData: WelcomeBoxData | null = null;
	private cachedLines: string[] | null = null;

	constructor(data: WelcomeBoxData) {
		this.data = data;
		this.body = new WelcomeBoxBody(this);
		this.card = new Card(
			data.cardPaddingX ?? 1,
			0,
			(s) => theme.bg("cardBg", s),
			(s) => theme.fg("borderMuted", s),
		);
		this.card.addChild(this.body);
	}

	setData(data: WelcomeBoxData): void {
		this.data = data;
		const paddingX = data.cardPaddingX ?? 1;
		this.card.setPadding(paddingX, 0);
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedData = null;
		this.cachedLines = null;
		this.card.invalidate();
	}

	render(width: number): string[] {
		const cacheable = this.data.wordmarkColor === undefined;
		if (!cacheable) {
			this.card.invalidate();
		}
		if (cacheable && this.cachedLines !== null && this.cachedWidth === width && this.cachedData === this.data) {
			return this.cachedLines;
		}
		const lines = this.card.render(Math.max(8, width));
		if (cacheable) {
			this.cachedWidth = width;
			this.cachedData = this.data;
			this.cachedLines = lines;
		} else {
			this.cachedLines = null;
		}
		return lines;
	}

	computeInnerRows(width: number): string[] {
		const w = Math.max(8, width);
		const d = this.data;
		const useWordmark = d.appName === "pit" && w >= WORDMARK_WIDTH + 24;
		const wordmarkColor = d.wordmarkColor ?? wordmarkGradient;

		const versionText = theme.fg("dim", `v${d.version}`);
		const taglineText = theme.fg("muted", d.tagline);
		const bodyW = this.bodyWidth(w, useWordmark);
		const workspaceLine = formatWorkspaceLine(d.cwdDisplay, d.branch, d.diffStats, d.shellCwdNote, bodyW);
		const resumeLine = d.resumedSessionName ? formatResumeLine(d.resumedSessionName, bodyW) : "";
		const bodies = useWordmark
			? [composeLeftRight(taglineText, versionText, bodyW), workspaceLine, resumeLine]
			: d.resumedSessionName
				? [
						composeLeftRight(theme.bold(theme.fg("accent", d.appName)), versionText, bodyW),
						workspaceLine,
						resumeLine,
					]
				: [
						composeLeftRight(theme.bold(theme.fg("accent", d.appName)), versionText, bodyW),
						taglineText,
						workspaceLine,
					];

		const rows: string[] = [];
		for (let i = 0; i < 3; i++) {
			const body = bodies[i] ?? "";
			if (useWordmark) {
				const wm = wordmarkColor(WORDMARK_PIT[i] ?? "");
				rows.push(`  ${wm}   ${body}`);
			} else {
				rows.push(`  ${body}`);
			}
		}

		return rows.map((line) => truncateToWidth(line, w));
	}

	private bodyWidth(width: number, useWordmark: boolean): number {
		const gutter = useWordmark ? 2 + WORDMARK_WIDTH + 3 : 2;
		return Math.max(8, width - gutter);
	}
}
