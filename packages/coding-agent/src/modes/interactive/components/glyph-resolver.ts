/**
 * Shared glyph families with ASCII fallbacks for dumb terminals / opt-in.
 *
 * Predicate (same spirit as the original gauge helper):
 *   `PIT_ASCII=1` | `PIT_ASCII_GAUGE=1` (legacy alias) | `TERM=dumb`
 *
 * Call sites that paint rare Unicode (fold ⊞⊟, system ⟳⑂, tree ├└, braille
 * spinner) should route through these resolvers so a single flag covers the UI.
 */

import { SPINNER_FRAMES as BRAILLE_SPINNER_FRAMES } from "@pit/tui";
import { isTruthyEnvFlag } from "../../../utils/env-flags.ts";

/** True when the UI should prefer ASCII-safe glyphs over decorative Unicode. */
export function isAsciiGlyphMode(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_ASCII) || isTruthyEnvFlag(env.PIT_ASCII_GAUGE) || env.TERM === "dumb";
}

// --- Gauge (footer / todo fill) ------------------------------------------------

export const GAUGE_FILLED = "▰";
export const GAUGE_EMPTY = "▱";

export function resolveGaugeGlyphs(env: NodeJS.ProcessEnv = process.env): {
	filled: string;
	empty: string;
} {
	if (isAsciiGlyphMode(env)) {
		return { filled: "●", empty: "○" };
	}
	return { filled: GAUGE_FILLED, empty: GAUGE_EMPTY };
}

// --- Tree connectors (agents-live, session-selector, …) ------------------------

export type TreeConnectors = {
	branch: string;
	last: string;
	pipe: string;
	/** session-selector style: "├─ " / "└─ " */
	branchPad: string;
	lastPad: string;
	pipePad: string;
};

export function resolveTreeConnectors(env: NodeJS.ProcessEnv = process.env): TreeConnectors {
	if (isAsciiGlyphMode(env)) {
		return {
			branch: "+",
			last: "+",
			pipe: "|",
			branchPad: "+- ",
			lastPad: "+- ",
			pipePad: "|  ",
		};
	}
	return {
		branch: "├",
		last: "└",
		pipe: "│",
		branchPad: "├─ ",
		lastPad: "└─ ",
		pipePad: "│  ",
	};
}

// --- Fold markers (tree-selector) ----------------------------------------------

export type FoldGlyphs = {
	folded: string;
	expanded: string;
	leaf: string;
};

export function resolveFoldGlyphs(env: NodeJS.ProcessEnv = process.env): FoldGlyphs {
	if (isAsciiGlyphMode(env)) {
		return { folded: "+", expanded: "-", leaf: "-" };
	}
	return { folded: "⊞", expanded: "⊟", leaf: "─" };
}

// --- Spinner frames ------------------------------------------------------------

/** Classic ASCII spinner; phase-locks with the same SPINNER_FRAME_MS cadence. */
export const ASCII_SPINNER_FRAMES = ["|", "/", "-", "\\"] as const;

/**
 * Active spinner frame set: braille by default, `|/-\\` under ASCII mode.
 * Length differs (10 vs 4); always modulo against the returned array.
 */
export function resolveSpinnerFrames(env: NodeJS.ProcessEnv = process.env): readonly string[] {
	return isAsciiGlyphMode(env) ? ASCII_SPINNER_FRAMES : BRAILLE_SPINNER_FRAMES;
}
