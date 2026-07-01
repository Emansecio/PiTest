/**
 * Shared truecolor interpolation for animated UI (the working-loader breathing
 * pulse and the tool-gutter state fade). All helpers are truecolor-only: on
 * 256-color terminals interpolated shades would band through the color cube, so
 * callers fall back to discrete theme colors instead.
 */

import { getCapabilities, getSegmenter, visibleWidth } from "@pit/tui";
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
