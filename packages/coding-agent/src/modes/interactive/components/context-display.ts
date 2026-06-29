/**
 * Shared renderers for supplementary context text (ask picker) and loaded
 * context files (startup listing). Uses the same tree geometry as goal/todo
 * overlays so context blocks read as one family in the TUI.
 */

import { truncateToWidth, visibleWidth } from "@pit/tui";
import { theme } from "../theme/theme.ts";

const CONNECTOR_WIDTH = 3;

function wrapPlain(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const out: string[] = [];
	for (const rawLine of text.split("\n")) {
		let line = "";
		for (const word of rawLine.split(/\s+/)) {
			if (!word) continue;
			if (line === "") {
				line = word;
			} else if (visibleWidth(`${line} ${word}`) <= width) {
				line = `${line} ${word}`;
			} else {
				out.push(line);
				line = word;
			}
		}
		out.push(line);
	}
	return out;
}

function treeRow(connector: string, body: string, width: number): string {
	const row = connector + body;
	return visibleWidth(row) > width ? truncateToWidth(row, width, "…") : row;
}

/** `1 skill` / `3 skills` — shared by startup resource sections. */
export function pluralCountLabel(count: number, singular: string, plural: string): string {
	return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

/** Startup section header: `● Title — count label`. */
export function formatLoadedSectionHeader(title: string, countLabel: string): string {
	return `${theme.fg("accent", "●")} ${theme.bold(title)} ${theme.fg("dim", "—")} ${theme.fg("muted", countLabel)}`;
}

/** Header for the startup context-files block: `● Context — N files`. */
export function formatContextFilesHeader(fileCount: number): string {
	return formatLoadedSectionHeader("Context", pluralCountLabel(fileCount, "file", "files"));
}

/** Collapsed startup row: `└─ a, b, c`. */
export function renderCompactItemRow(items: string[]): string {
	if (items.length === 0) return "";
	const joined = items.map((item) => theme.fg("muted", item)).join(theme.fg("dim", ", "));
	return `${theme.fg("dim", "└─ ")}${joined}`;
}

/**
 * Render loaded context file paths as a tree beneath {@link formatContextFilesHeader}.
 * Collapsed: one trailing row with comma-joined paths; expanded: one path per row.
 */
export function renderContextFilesBody(paths: string[], collapsed: boolean): string {
	if (paths.length === 0) return "";
	const dimConnector = (last: boolean) => theme.fg("dim", last ? "└─ " : "├─ ");
	if (collapsed) {
		const joined = paths.map((p) => theme.fg("muted", p)).join(theme.fg("dim", ", "));
		return `${dimConnector(true)}${joined}`;
	}
	return paths
		.map((p, idx) => {
			const last = idx === paths.length - 1;
			return `${dimConnector(last)}${theme.fg("muted", p)}`;
		})
		.join("\n");
}

/**
 * Render free-form supplementary context (ask picker `context` field) as a labeled
 * tree block. Returns [] when `text` is empty/whitespace.
 */
export function renderSupplementaryContext(text: string, width: number): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];

	const lines: string[] = [];
	lines.push(theme.fg("dim", "Context"));

	const rowBudget = Math.max(4, width - CONNECTOR_WIDTH);
	const wrapped = wrapPlain(trimmed, rowBudget);
	for (let i = 0; i < wrapped.length; i++) {
		const last = i === wrapped.length - 1;
		const connector = theme.fg("dim", last ? "└─ " : "├─ ");
		const body = theme.fg("muted", wrapped[i] ?? "");
		lines.push(treeRow(connector, body, width));
	}
	return lines;
}
