/**
 * Shared truecolor interpolation for animated UI (the working-loader breathing
 * pulse and the tool-gutter state fade). All helpers are truecolor-only: on
 * 256-color terminals interpolated shades would band through the color cube, so
 * callers fall back to discrete theme colors instead.
 */

import { getCapabilities, getSegmenter, HEARTBEAT_CYCLE_MS, visibleWidth } from "@pit/tui";
import { isReducedMotion } from "../../../utils/env-flags.ts";
import { theme as globalTheme, type Theme, type ThemeColor } from "./theme.ts";

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/**
 * Apply a per-grapheme color function across plain text. `colorAt` receives the
 * starting display column and total display width (`visibleWidth(text)`); each
 * grapheme cluster is wrapped in a single color call so surrogate pairs and
 * wide chars are never split.
 */
export function applyColumnGradient(
	text: string,
	colorAt: (col: number, cols: number) => (segment: string) => string,
): string {
	if (text.length === 0) return text;
	const cols = visibleWidth(text);
	if (cols === 0) return text;
	let result = "";
	let col = 0;
	for (const { segment } of getSegmenter().segment(text)) {
		const w = visibleWidth(segment);
		if (w === 0) {
			result += segment;
			continue;
		}
		result += colorAt(col, cols)(segment);
		col += w;
	}
	return result;
}

/** Bicolor fallback when truecolor interpolation is unavailable. */
export function bicolorColumnColor(col: number, themeInstance: Theme = globalTheme): (segment: string) => string {
	if (col % 2 === 1) {
		return (segment: string) => themeInstance.fg("accent", segment);
	}
	return (segment: string) => themeInstance.fg("thinkingXhigh", segment);
}

/**
 * PIT hero-logo gradient stops — brand green: neon → lime. Brand-fixed on
 * purpose (not theme keys): the wordmark reads the same across custom themes.
 * Light themes get deeper greens so the mark keeps contrast on white.
 */
const LOGO_NEON_DARK: Rgb = { r: 57, g: 255, b: 20 };
const LOGO_LIME_DARK: Rgb = { r: 201, g: 255, b: 41 };
const LOGO_NEON_LIGHT: Rgb = { r: 16, g: 138, b: 22 };
const LOGO_LIME_LIGHT: Rgb = { r: 104, g: 146, b: 0 };

/** Light text (high luminance) implies a dark terminal background. */
function hasDarkBackground(themeInstance: Theme): boolean {
	const text = parseTrueColorFg(themeInstance.getFgAnsi("text"));
	if (!text) return true;
	return (0.299 * text.r + 0.587 * text.g + 0.114 * text.b) / 255 >= 0.5;
}

/**
 * Hero-wordmark gradient: neon green → lime blended across the letters. The
 * ramp is diagonal — `row` shifts it so color flows top-left → bottom-right
 * over the block glyphs. Truecolor only; 256-color terminals fall back to the
 * theme's flat `success` green (banding through the color cube reads worse
 * than a solid brand green).
 */
export function pitLogoGradient(
	row: number,
	rows: number,
	themeInstance: Theme = globalTheme,
): (text: string) => string {
	return (text: string) => {
		if (!getCapabilities().trueColor) return themeInstance.fg("success", text);
		const dark = hasDarkBackground(themeInstance);
		const from = dark ? LOGO_NEON_DARK : LOGO_NEON_LIGHT;
		const to = dark ? LOGO_LIME_DARK : LOGO_LIME_LIGHT;
		const rowBias = rows <= 1 ? 0 : (row / (rows - 1)) * 0.35;
		return applyColumnGradient(text, (col, cols) => {
			const colT = cols <= 1 ? 0 : col / (cols - 1);
			return rgbFg(lerpRgb(from, to, colT * 0.65 + rowBias));
		});
	};
}

/** Wordmark gradient: teal → lavender (truecolor) or accent/lavender bicolor. */
export function wordmarkGradient(text: string, themeInstance: Theme = globalTheme): string {
	return applyColumnGradient(text, (col, cols) => {
		const t = cols <= 1 ? 0 : col / (cols - 1);
		if (getCapabilities().trueColor) {
			const grad = interpolateFg("accent", "thinkingXhigh", t, themeInstance);
			if (grad) return grad;
		}
		return bicolorColumnColor(col, themeInstance);
	});
}

/** H1 gradient: gold → tealBright → cyanBlue (stitched 2-stop) or bicolor fallback. */
export function h1Gradient(text: string, themeInstance: Theme = globalTheme): string {
	return applyColumnGradient(text, (col, cols) => {
		const t = cols <= 1 ? 0 : col / (cols - 1);
		if (getCapabilities().trueColor) {
			if (t <= 0.5) {
				const grad = interpolateFg("mdHeading", "borderAccent", t * 2, themeInstance);
				if (grad) return grad;
			} else {
				const grad = interpolateFg("borderAccent", "border", (t - 0.5) * 2, themeInstance);
				if (grad) return grad;
			}
		}
		return bicolorColumnColor(col, themeInstance);
	});
}

/** Parse a foreground SGR like `\x1b[38;2;r;g;bm` into RGB; undefined when it is
 * not a truecolor sequence (e.g. a 256-color `38;5;n`). */
export function parseTrueColorFg(ansi: string): Rgb | undefined {
	const match = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	if (!match) return undefined;
	return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

/** Linear RGB interpolation; `t` is clamped to [0,1]. */
export function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
	const u = t < 0 ? 0 : t > 1 ? 1 : t;
	return {
		r: Math.round(a.r + (b.r - a.r) * u),
		g: Math.round(a.g + (b.g - a.g) * u),
		b: Math.round(a.b + (b.b - a.b) * u),
	};
}

/** Foreground-color wrapper for an RGB value (resets the color afterwards). */
export function rgbFg({ r, g, b }: Rgb): (text: string) => string {
	const prefix = `\x1b[38;2;${r};${g};${b}m`;
	return (text) => `${prefix}${text}\x1b[39m`;
}

/**
 * Foreground color function eased from theme color `from` to `to` by `t` in
 * [0,1]. Returns undefined when the terminal lacks truecolor or either color
 * does not resolve to RGB, so the caller can snap to a discrete theme color.
 */
export function interpolateFg(
	from: ThemeColor,
	to: ThemeColor,
	t: number,
	themeInstance: Theme = globalTheme,
): ((text: string) => string) | undefined {
	if (!getCapabilities().trueColor) return undefined;
	const a = parseTrueColorFg(themeInstance.getFgAnsi(from));
	const b = parseTrueColorFg(themeInstance.getFgAnsi(to));
	if (!a || !b) return undefined;
	return rgbFg(lerpRgb(a, b, t));
}

/** Width (display columns) of the shimmer's bright band. Soft-edged, so the
 * effective glow is a little wider than this at low intensity. */
const SHIMMER_BAND_COLUMNS = 6;
/** How strongly the band center leans past `text` toward `accent` (kept subtle
 * so the shimmer reads as a brightness sweep, not a color sweep). */
const SHIMMER_ACCENT_KISS = 0.35;

/**
 * Time-aware label painter: text sits in the `muted` base with a soft brightness
 * band (~{@link SHIMMER_BAND_COLUMNS} columns) that sweeps left→right once per
 * `cycleMs` and wraps around. The band peaks toward the `text` color and kisses
 * `accent` at its very center, with a raised-cosine falloff so its edges melt
 * into the muted base instead of stepping. Only colors change — the visible
 * characters and their width are untouched.
 *
 * Truecolor only: when the terminal lacks truecolor OR reduced motion is active,
 * this returns a plain `(t) => theme.fg("muted", t)` painter with no sweep.
 */
export function shimmerColorAt(
	now: number,
	themeInstance: Theme = globalTheme,
	cycleMs: number = HEARTBEAT_CYCLE_MS,
): (text: string) => string {
	const mutedOnly = (text: string) => themeInstance.fg("muted", text);
	if (!getCapabilities().trueColor || isReducedMotion()) return mutedOnly;

	const muted = parseTrueColorFg(themeInstance.getFgAnsi("muted"));
	const text = parseTrueColorFg(themeInstance.getFgAnsi("text"));
	const accent = parseTrueColorFg(themeInstance.getFgAnsi("accent"));
	if (!muted || !text) return mutedOnly;

	// Band center sweeps from just off the left edge to just off the right edge
	// over one cycle, so it fully enters and exits; the next cycle wraps it back.
	const period = cycleMs > 0 ? cycleMs : HEARTBEAT_CYCLE_MS;
	const phase = (((now % period) + period) % period) / period;
	const half = SHIMMER_BAND_COLUMNS / 2;

	return (input: string) =>
		applyColumnGradient(input, (_col, cols) => {
			const center = phase * (cols + SHIMMER_BAND_COLUMNS) - half;
			return (segment: string) => {
				const dist = Math.abs(_col - center);
				if (dist >= half) return themeInstance.fg("muted", segment);
				// Raised cosine: 1 at the band center, 0 at its edges.
				const w = (1 + Math.cos((dist / half) * Math.PI)) / 2;
				let color = lerpRgb(muted, text, w);
				if (accent) color = lerpRgb(color, accent, w * w * SHIMMER_ACCENT_KISS);
				return rgbFg(color)(segment);
			};
		});
}
