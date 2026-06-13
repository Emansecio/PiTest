// Pure formatter for the @pit/ai runtime-diagnostics channel, shared by the
// interactive `/diagnostics` command. Kept theme-aware but TUI-free so it is
// unit-testable in isolation (no Container / TUI instance required).

import type { DiagnosticContext, DiagnosticSnapshot } from "@pit/ai";
import { theme } from "./theme/theme.ts";

const LEVEL_COLOR = {
	info: "dim",
	warn: "warning",
	error: "error",
} as const;

// Render a context object as a compact `key=value` tail, e.g. `bytes=8388608 ms=120000`.
function formatContext(context: DiagnosticContext | undefined): string {
	if (!context) return "";
	const parts: string[] = [];
	for (const [key, value] of Object.entries(context)) {
		if (value === undefined) continue;
		parts.push(`${key}=${value}`);
	}
	return parts.join(" ");
}

/**
 * Build the `/diagnostics` summary block: total event count plus one line per
 * category (count, level, last source/context), ordered by count descending.
 * Returns the empty-state line when nothing has been recorded this session.
 */
export function formatRuntimeDiagnostics(snapshot: DiagnosticSnapshot): string {
	if (snapshot.total === 0) {
		return theme.fg("muted", "No runtime diagnostics recorded this session.");
	}

	const rows = Object.entries(snapshot.counters).sort((a, b) => b[1].count - a[1].count);

	let info = `${theme.bold("Runtime Diagnostics")}\n\n`;
	info += `${theme.fg("dim", "Total events:")} ${snapshot.total}\n\n`;

	for (const [category, counter] of rows) {
		const levelColor = LEVEL_COLOR[counter.level];
		// Recover the source of the most recent event in this category (walk the
		// ring backward; `findLast` would require an es2023 lib target).
		let source = "";
		for (let i = snapshot.recent.length - 1; i >= 0; i--) {
			if (snapshot.recent[i].category === category) {
				source = snapshot.recent[i].source;
				break;
			}
		}
		const ctx = formatContext(counter.lastContext);
		const detail = [source, ctx].filter((p) => p.length > 0).join(" ");
		const suffix = detail.length > 0 ? `  ${theme.fg("dim", `(${detail})`)}` : "";
		info += `${category}  ${theme.fg("dim", `×${counter.count}`)}  ${theme.fg(levelColor, counter.level)}${suffix}\n`;
	}

	return info.trimEnd();
}
