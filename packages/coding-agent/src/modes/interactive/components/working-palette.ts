import { getCapabilities, type LoaderColorFn } from "@pit/tui";
import { isReducedMotion } from "../../../utils/env-flags.ts";
import { lerpRgb, parseTrueColorFg, type Rgb, rgbFg } from "../theme/color-interpolation.ts";
import { theme as globalTheme, type Theme } from "../theme/theme.ts";

/**
 * Number of phases in the truecolor breathing gradient. The Loader sweeps the
 * whole palette once per breath cycle, so more phases = smoother (not slower).
 */
const BREATH_PHASES = 24;

/**
 * Brand lime (`#c9ff29`) — the bright end of the PIT hero-logo gradient. The
 * breathing pulse blends its accent toward this at the raised-cosine peak so the
 * spinner "touches" the brand at its brightest instant. Brand-fixed (not a theme
 * key) on purpose, matching the wordmark.
 */
const BRAND_LIME: Rgb = { r: 201, g: 255, b: 41 };
/** Phases either side of the peak (i≈0) that receive any brand blend. Keeps the
 * kiss to the brightest ~2-3 of the 24 phases. */
const BRAND_PEAK_SPAN = 3;
/** Peak blend fraction toward {@link BRAND_LIME} at the exact brightest phase. */
const BRAND_PEAK_BLEND = 0.25;

/**
 * Spinner color pulse for every "work in progress" Loader.
 *
 * On truecolor terminals it returns a smooth, raised-cosine breathing gradient
 * that eases `accent → dim → accent` (dwelling gently at each pole). On
 * 256-color terminals \u2014 where interpolated shades would band \u2014 it falls back to
 * the original 4-phase symmetric pulse `accent → muted → dim → muted`, unless
 * `muted` and `dim` quantize to adjacent 256 grays (the light theme: ~#6c6c6c
 * and ~#767676 land on neighbouring ramp indices, making the muted/dim core
 * imperceptible). There it drops to a 2-phase `accent → dim` pulse with a
 * visibly wider swing.
 *
 * Pass an explicit `themeInstance` only when the caller already holds a
 * non-global theme (e.g. BorderedLoader); otherwise the global theme proxy is
 * the right default and tracks theme switches at runtime.
 */
export function workingPulsePalette(themeInstance: Theme = globalTheme): LoaderColorFn[] {
	if (isReducedMotion()) {
		// Reduced-motion: steady accent on a frozen spinner frame (see spinner-ticker).
		return [(s) => themeInstance.fg("accent", s)];
	}
	const gradient = breathingGradient(themeInstance);
	if (gradient) return gradient;
	if (grayPolesCollapse(themeInstance)) {
		return [(s) => themeInstance.fg("accent", s), (s) => themeInstance.fg("dim", s)];
	}
	return [
		(s) => themeInstance.fg("accent", s),
		(s) => themeInstance.fg("muted", s),
		(s) => themeInstance.fg("dim", s),
		(s) => themeInstance.fg("muted", s),
	];
}

/** Parse the index `n` out of a 256-color SGR `\x1b[38;5;nm`; undefined for any
 * other sequence (truecolor / default). */
function parse256Index(ansi: string): number | undefined {
	const match = ansi.match(/\x1b\[38;5;(\d+)m/);
	return match ? Number(match[1]) : undefined;
}

/** True when `muted` and `dim` resolve to adjacent 256-color indices, so the
 * symmetric pulse's inner `muted -> dim -> muted` swing is indistinguishable.
 * Only meaningful on the 256-color fallback path; truecolor never reaches here. */
function grayPolesCollapse(themeInstance: Theme): boolean {
	const muted = parse256Index(themeInstance.getFgAnsi("muted"));
	const dim = parse256Index(themeInstance.getFgAnsi("dim"));
	if (muted === undefined || dim === undefined) return false;
	return Math.abs(muted - dim) <= 1;
}

/** Build the truecolor breathing gradient, or undefined when truecolor is
 * unavailable / the theme colors are not resolvable as RGB (256-color theme). */
function breathingGradient(themeInstance: Theme): LoaderColorFn[] | undefined {
	if (!getCapabilities().trueColor) return undefined;
	const accent = parseTrueColorFg(themeInstance.getFgAnsi("accent"));
	const dim = parseTrueColorFg(themeInstance.getFgAnsi("dim"));
	if (!accent || !dim) return undefined;

	const palette: LoaderColorFn[] = [];
	for (let i = 0; i < BREATH_PHASES; i++) {
		// Raised cosine: 0 at accent, 1 at dim, back to 0 \u2014 eased at both ends so
		// the pulse lingers at the poles instead of sliding through them linearly.
		const t = (1 - Math.cos((i / BREATH_PHASES) * 2 * Math.PI)) / 2;
		let color = lerpRgb(accent, dim, t);
		// At the brightest (accent) pole \u2014 i\u22480, wrapping so late phases near i=24
		// count too \u2014 kiss the accent toward the brand lime with a raised-cosine
		// window, so the pulse just touches the brand at its peak and eases back.
		const peakDist = Math.min(i, BREATH_PHASES - i);
		if (peakDist < BRAND_PEAK_SPAN) {
			const peak = (1 + Math.cos((peakDist / BRAND_PEAK_SPAN) * Math.PI)) / 2;
			color = lerpRgb(color, BRAND_LIME, peak * BRAND_PEAK_BLEND);
		}
		palette.push(rgbFg(color));
	}
	return palette;
}
