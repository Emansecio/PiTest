/**
 * Welcome box: the framed identity block shown at startup.
 *
 * Pit-native framing = a single horizontal rule (─), not a 4-sided box: a side
 * `│` gutter forces exact per-line width math and risks the "Rendered line
 * exceeds terminal width" crash on narrow terminals, and a second full-width
 * rule above the logo is dead weight for a first impression — the whitespace
 * above does the framing, the one rule below closes the block. Every emitted
 * line is truncated to the viewport width (the TUI host enforces this for
 * custom components).
 *
 * Layout (3 identity rows closed by one rule):
 *     █▀█ █ ▀█▀   coding agent in your terminal            v0.4.2
 *     █▀▀ █  █    ~/proj (main)
 *     ▀   ▀  ▀
 *   ────────────────────────────────────────────────────────────
 *
 * The hint/tip line is rendered separately (below) so its expand toggle stays
 * owned by interactive-mode.
 */

import { type Component, truncateToWidth, visibleWidth } from "@pit/tui";
import { theme } from "../theme/theme.ts";

// 3-row half-block wordmark for the default app name "pit". Each row is exactly
// 9 visible columns wide (all U+2588/U+2580 + spaces are width-1).
const WORDMARK_PIT: readonly string[] = ["█▀█ █ ▀█▀", "█▀▀ █  █ ", "▀   ▀  ▀ "];
const WORDMARK_WIDTH = 9;

export interface WelcomeBoxData {
	appName: string;
	version: string;
	/** One-line tagline, e.g. "coding agent in your terminal". */
	tagline: string;
	/** Display path of the cwd (already home-shortened). */
	cwdDisplay: string;
	branch?: string;
	/** When resuming, the session name to surface in place of the cwd. */
	resumedSessionName?: string;
	/** Color function for the wordmark (lets interactive-mode ease it in on mount). */
	wordmarkColor?: (s: string) => string;
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
	}

	setData(data: WelcomeBoxData): void {
		this.data = data;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedData = null;
		this.cachedLines = null;
	}

	render(width: number): string[] {
		const cacheable = this.data.wordmarkColor === undefined;
		if (cacheable && this.cachedLines !== null && this.cachedWidth === width && this.cachedData === this.data) {
			return this.cachedLines;
		}
		const lines = this.computeRender(width);
		if (cacheable) {
			this.cachedWidth = width;
			this.cachedData = this.data;
			this.cachedLines = lines;
		} else {
			this.cachedLines = null;
		}
		return lines;
	}

	private computeRender(width: number): string[] {
		const w = Math.max(8, width);
		const d = this.data;
		// Muted hairline, not the saturated blue `border`: the welcome rule frames
		// the identity block as quiet structure, matching the chat-flow rules.
		const rule = theme.fg("borderMuted", "─".repeat(w));
		const useWordmark = d.appName === "pit" && w >= WORDMARK_WIDTH + 24;
		const wordmarkColor = d.wordmarkColor ?? ((s: string) => theme.fg("accent", s));

		// Right-hand body lines (three rows next to the wordmark). The active model
		// is intentionally NOT shown here — it lives permanently in the footer, so
		// repeating it would be redundant. The welcome carries identity
		// (logo/tagline/version) + cwd orientation only.
		// Tagline/version are secondary but must stay LEGIBLE: `muted` (one step
		// up from `dim`, which sat at the edge of readability) keeps the
		// de-emphasis without making the reader squint.
		const versionText = theme.fg("muted", `v${d.version}`);
		const taglineText = theme.fg("muted", d.tagline);
		const cwd = d.branch ? `${d.cwdDisplay} (${d.branch})` : d.cwdDisplay;
		// In the home dir with no project context (`~`, no branch, no resumed
		// session) the cwd line orients nothing — a lone "~" reads like a leftover
		// placeholder. Drop it; the footer still carries the live cwd.
		const homeWithoutContext = !d.resumedSessionName && !d.branch && d.cwdDisplay === "~";
		let contextText: string;
		if (d.resumedSessionName) {
			contextText = theme.fg("muted", `Resuming · ${d.resumedSessionName}`);
		} else if (homeWithoutContext) {
			contextText = "";
		} else {
			contextText = theme.fg("muted", cwd);
		}

		const bodyW = this.bodyWidth(w, useWordmark);
		const bodies = useWordmark
			? // The wordmark IS the name, so don't repeat "pit" as a text label.
				[composeLeftRight(taglineText, versionText, bodyW), contextText, ""]
			: [composeLeftRight(theme.bold(theme.fg("accent", d.appName)), versionText, bodyW), taglineText, contextText];

		const rows: string[] = [];
		for (let i = 0; i < 3; i++) {
			const body = bodies[i] ?? "";
			if (useWordmark) {
				const wm = wordmarkColor(WORDMARK_PIT[i]);
				rows.push(`  ${wm}   ${body}`);
			} else {
				rows.push(`  ${body}`);
			}
		}

		// One rule only, below: it closes the identity block and separates it from
		// the content underneath. The whitespace above the logo frames the top.
		const out = [...rows, rule];
		return out.map((line) => truncateToWidth(line, w));
	}

	private bodyWidth(width: number, useWordmark: boolean): number {
		// Columns available to the right of the left gutter (+ wordmark, if shown).
		const gutter = useWordmark ? 2 + WORDMARK_WIDTH + 3 : 2;
		return Math.max(8, width - gutter);
	}
}
