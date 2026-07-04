/**
 * Shared truecolor interpolation for animated UI (the working-loader breathing
 * pulse and the tool-gutter state fade). All helpers are truecolor-only: on
 * 256-color terminals interpolated shades would band through the color cube, so
 * callers fall back to discrete theme colors instead.
 */

import { getCapabilities, getSegmenter, HEARTBEAT_CYCLE_MS, visibleWidth } from "@pit/tui";
import { isReducedMotion } from "../../../utils/env-flags.ts";
import { theme as globalTheme, resolveThemeInstance, type Theme, type ThemeColor } from "./theme.ts";

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
	const text = getRgb(themeInstance, "text");
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

/**
 * Per-theme-instance cache of parsed RGB values. `parseTrueColorFg` regex-parses
 * a constant ANSI string per (theme, color) — cheap once, but `interpolateFg`
 * and `shimmerColorAt` call it per grapheme per frame during streaming fades
 * (e.g. `fadeLineTail`), so it adds up. `null` marks "parsed, not truecolor"
 * so that result is cached too instead of re-parsing every call.
 *
 * Keyed by the resolved real Theme instance, never the shared `theme` Proxy —
 * see {@link resolveThemeInstance}. A theme switch always installs a brand-new
 * Theme instance (initTheme/setTheme/setThemeInstance/hot-reload all construct
 * fresh objects, never mutate the current one), so the cache invalidates for
 * free: the new instance simply isn't in the WeakMap yet.
 */
const rgbCache = new WeakMap<Theme, Map<ThemeColor, Rgb | null>>();

/** Cached `parseTrueColorFg(themeInstance.getFgAnsi(color))`. See {@link rgbCache}. */
export function getRgb(themeInstance: Theme, color: ThemeColor): Rgb | undefined {
	const instance = resolveThemeInstance(themeInstance);
	let cache = rgbCache.get(instance);
	if (!cache) {
		cache = new Map();
		rgbCache.set(instance, cache);
	}
	const cached = cache.get(color);
	if (cached !== undefined) return cached === null ? undefined : cached;
	const rgb = parseTrueColorFg(instance.getFgAnsi(color)) ?? null;
	cache.set(color, rgb);
	return rgb ?? undefined;
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
	const a = getRgb(themeInstance, from);
	const b = getRgb(themeInstance, to);
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
 * Number of discrete intensity steps in the shimmer LUT (see
 * {@link buildShimmerLut}). The raised-cosine falloff is a smooth curve; 32
 * steps land well under the ~1 JND (just-noticeable-difference) threshold for
 * terminal-rendered color ramps, so the quantization is imperceptible while
 * cutting the per-grapheme cost to an array index.
 */
const SHIMMER_LUT_STEPS = 32;

/** Cached per-theme-instance LUT of precomputed `\x1b[38;2;r;g;bm` prefixes,
 * indexed by intensity bucket (0..{@link SHIMMER_LUT_STEPS}). Built once per
 * real Theme instance (muted/text/accent are fixed for the instance's
 * lifetime — Theme's color maps are populated once in its constructor and
 * never mutated), so this is safe to cache forever per instance. Keyed like
 * {@link rgbCache} — see {@link resolveThemeInstance}. */
const shimmerLutCache = new WeakMap<Theme, string[]>();

function buildShimmerLut(muted: Rgb, text: Rgb, accent: Rgb | undefined): string[] {
	const lut: string[] = new Array(SHIMMER_LUT_STEPS + 1);
	for (let i = 0; i <= SHIMMER_LUT_STEPS; i++) {
		const w = i / SHIMMER_LUT_STEPS;
		let color = lerpRgb(muted, text, w);
		if (accent) color = lerpRgb(color, accent, w * w * SHIMMER_ACCENT_KISS);
		lut[i] = `\x1b[38;2;${color.r};${color.g};${color.b}m`;
	}
	return lut;
}

function getShimmerLut(instance: Theme, muted: Rgb, text: Rgb, accent: Rgb | undefined): string[] {
	let lut = shimmerLutCache.get(instance);
	if (!lut) {
		lut = buildShimmerLut(muted, text, accent);
		shimmerLutCache.set(instance, lut);
	}
	return lut;
}

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

	const instance = resolveThemeInstance(themeInstance);
	const muted = getRgb(instance, "muted");
	const text = getRgb(instance, "text");
	const accent = getRgb(instance, "accent");
	if (!muted || !text) return mutedOnly;

	// Precomputed per-instance LUT of ANSI prefixes by intensity bucket — see
	// buildShimmerLut. Replaces a per-grapheme `lerpRgb` allocation + `rgbFg`
	// closure with an array index + string concat.
	const lut = getShimmerLut(instance, muted, text, accent);

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
				const bucket = Math.round(w * SHIMMER_LUT_STEPS);
				return `${lut[bucket]}${segment}\x1b[39m`;
			};
		});
}
