import type { LoaderColorFn } from "@pit/tui";
import { theme as globalTheme, type Theme } from "../theme/theme.ts";

/**
 * 4-phase symmetric pulse used by every "work in progress" Loader so the
 * agent's accent spinners breathe in unison: accent → muted → dim → muted → accent.
 *
 * Pass an explicit `themeInstance` only when the loader's caller already
 * receives a non-global theme (e.g., BorderedLoader); otherwise the global
 * theme proxy is the right default and tracks theme switches at runtime.
 */
export function workingPulsePalette(themeInstance: Theme = globalTheme): LoaderColorFn[] {
	return [
		(s) => themeInstance.fg("accent", s),
		(s) => themeInstance.fg("muted", s),
		(s) => themeInstance.fg("dim", s),
		(s) => themeInstance.fg("muted", s),
	];
}
