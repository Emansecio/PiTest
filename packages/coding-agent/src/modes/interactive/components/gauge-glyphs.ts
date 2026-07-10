import { isTruthyEnvFlag } from "../../../utils/env-flags.ts";

/** Filled / empty gauge cells (footer + todo). Fallback: ● / ○ if font lacks U+25B0. */
export const GAUGE_FILLED = "▰";
export const GAUGE_EMPTY = "▱";

const ASCII_FILLED = "●";
const ASCII_EMPTY = "○";

/**
 * Resolve gauge glyphs for the current terminal. Prefer parallelograms; fall
 * back to filled/empty circles when `PIT_ASCII_GAUGE=1` or `TERM=dumb` (A03).
 */
export function resolveGaugeGlyphs(): { filled: string; empty: string } {
	if (isTruthyEnvFlag(process.env.PIT_ASCII_GAUGE) || process.env.TERM === "dumb") {
		return { filled: ASCII_FILLED, empty: ASCII_EMPTY };
	}
	return { filled: GAUGE_FILLED, empty: GAUGE_EMPTY };
}
