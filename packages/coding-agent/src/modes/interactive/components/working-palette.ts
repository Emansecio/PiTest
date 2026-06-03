import { getCapabilities, type LoaderColorFn } from "@pit/tui";
import { lerpRgb, parseTrueColorFg, rgbFg } from "../theme/color-interpolation.ts";
import { theme as globalTheme, type Theme } from "../theme/theme.ts";

/**
 * Number of phases in the truecolor breathing gradient. The Loader sweeps the
 * whole palette once per breath cycle, so more phases = smoother (not slower).
 */
const BREATH_PHASES = 16;

/**
 * Spinner color pulse for every "work in progress" Loader.
 *
 * On truecolor terminals it returns a smooth, raised-cosine breathing gradient
 * that eases `accent → dim → accent` (dwelling gently at each pole). On
 * 256-color terminals \u2014 where interpolated shades would band \u2014 it falls back to
 * the original 4-phase symmetric pulse `accent → muted → dim → muted`.
 *
 * Pass an explicit `themeInstance` only when the caller already holds a
 * non-global theme (e.g. BorderedLoader); otherwise the global theme proxy is
 * the right default and tracks theme switches at runtime.
 */
export function workingPulsePalette(themeInstance: Theme = globalTheme): LoaderColorFn[] {
	return (
		breathingGradient(themeInstance) ?? [
			(s) => themeInstance.fg("accent", s),
			(s) => themeInstance.fg("muted", s),
			(s) => themeInstance.fg("dim", s),
			(s) => themeInstance.fg("muted", s),
		]
	);
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
		palette.push(rgbFg(lerpRgb(accent, dim, t)));
	}
	return palette;
}
