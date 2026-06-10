/**
 * Welcome box: the framed identity block shown at startup.
 *
 * Pit-native framing = horizontal rules (─), not a 4-sided box: a side `│`
 * gutter forces exact per-line width math and risks the "Rendered line exceeds
 * terminal width" crash on narrow terminals. The rules anchor the screen just as
 * well while staying width-safe. Every emitted line is truncated to the viewport
 * width (the TUI host enforces this for custom components).
 *
 * Layout (3 identity rows between two rules):
 *   ────────────────────────────────────────────────────────────
 *     █▀█ █ ▀█▀   pit                                     v0.4.2
 *     █▀▀ █  █    coding agent in your terminal
 *     ▀   ▀  ▀    ~/proj (main)              opus-4.8 · thinking high
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

	constructor(data: WelcomeBoxData) {
		this.data = data;
	}

	setData(data: WelcomeBoxData): void {
		this.data = data;
	}

	invalidate(): void {
		// Stateless render; nothing cached.
	}

	render(width: number): string[] {
		const w = Math.max(8, width);
		const d = this.data;
		const rule = theme.fg("border", "─".repeat(w));
		const useWordmark = d.appName === "pit" && w >= WORDMARK_WIDTH + 24;
		const wordmarkColor = d.wordmarkColor ?? ((s: string) => theme.fg("accent", s));

		// Right-hand body lines (three rows next to the wordmark). The active model
		// is intentionally NOT shown here — it lives permanently in the footer, so
		// repeating it would be redundant. The welcome carries identity
		// (logo/tagline/version) + cwd orientation only.
		const versionText = theme.fg("dim", `v${d.version}`);
		const taglineText = theme.fg("dim", d.tagline);
		const cwd = d.branch ? `${d.cwdDisplay} (${d.branch})` : d.cwdDisplay;
		const contextText = d.resumedSessionName
			? theme.fg("muted", `Resuming · ${d.resumedSessionName}`)
			: theme.fg("muted", cwd);

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

		const out = [rule, ...rows, rule];
		return out.map((line) => truncateToWidth(line, w));
	}

	private bodyWidth(width: number, useWordmark: boolean): number {
		// Columns available to the right of the left gutter (+ wordmark, if shown).
		const gutter = useWordmark ? 2 + WORDMARK_WIDTH + 3 : 2;
		return Math.max(8, width - gutter);
	}
}
