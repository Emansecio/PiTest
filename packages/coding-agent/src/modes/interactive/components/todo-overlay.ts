/**
 * TodoOverlayComponent — the live "above editor" todo list. Auto-hides when
 * empty (render returns []), and animates the in_progress glyph. Reads fresh
 * state from the AgentSession on every render (FooterComponent pattern).
 */

import { performance } from "node:perf_hooks";
import { type Component, truncateToWidth, visibleWidth } from "@pit/tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { TodoItem } from "../../../core/todo/todo-manager.ts";
import { theme } from "../theme/theme.ts";
import { resolveGaugeGlyphs } from "./gauge-glyphs.ts";
import { spinnerGlyphAt } from "./spinner-ticker.ts";

/** Cap on overlay rows; completed todos are hidden first when exceeded. */
const OVERLAY_MAX_ROWS = 12;
/**
 * A fully-completed list lingers this long before auto-hiding, so the last
 * item flipping to ✓ and the bar reaching 100% are actually seen instead of
 * vanishing in the same frame. Mirrors GOAL_COMPLETE_LINGER_MS next door.
 */
export const TODO_COMPLETE_LINGER_MS = 4000;
/** Progress bar width (visible block chars, excluding connector). */
const PROGRESS_BAR_WIDTH = 12;
// CONNECTOR_WIDTH: "├─ " or "└─ " = 3 visible chars.
const CONNECTOR_WIDTH = 3;
// PREFIX_WIDTH: glyph + space inside the row ("⠏ " or "✓ " or "○ ") = 2 visible chars.
const ROW_PREFIX_WIDTH = 2;

function fitWidth(text: string, width: number): string {
	return visibleWidth(text) > width ? truncateToWidth(text, width, "…") : text;
}

function strike(text: string): string {
	return `\x1b[9m${text}\x1b[29m`;
}

function sortTodosForDisplay(items: TodoItem[]): TodoItem[] {
	const rank = (status: TodoItem["status"]): number => {
		switch (status) {
			case "in_progress":
				return 0;
			case "pending":
				return 1;
			default:
				return 2;
		}
	};
	return [...items].sort((a, b) => rank(a.status) - rank(b.status));
}

function renderProgressBar(done: number, total: number, width: number): string {
	if (total <= 1) return "";
	const { filled: GAUGE_FILLED, empty: GAUGE_EMPTY } = resolveGaugeGlyphs();
	const barWidth = Math.min(PROGRESS_BAR_WIDTH, Math.max(4, width - CONNECTOR_WIDTH - 8));
	const filled = Math.round((done / total) * barWidth);
	const empty = barWidth - filled;
	const filledPart = theme.fg("success", GAUGE_FILLED.repeat(filled));
	const emptyPart = theme.fg("dim", GAUGE_EMPTY.repeat(empty));
	const pct = Math.round((done / total) * 100);
	const label = `${done}/${total} · ${pct}%`;
	return `${filledPart}${emptyPart} ${theme.fg("muted", label)}`;
}

export interface TodoOverlayData {
	items: TodoItem[];
	done: number;
	total: number;
}

function todoOverlayDataKey(data: TodoOverlayData, sorted: TodoItem[]): string {
	let key = `${data.done}/${data.total}`;
	for (const item of sorted) {
		key += `|${item.id}:${item.status}:${item.subject}:${item.activeForm ?? ""}`;
	}
	return key;
}

type TodoOverlayRow = { kind: "static"; line: string } | { kind: "spinner"; connector: string; item: TodoItem };

interface TodoOverlayRenderCache {
	dataKey: string;
	width: number;
	header: string[];
	rows: TodoOverlayRow[];
	footer?: string;
}

function truncateSubject(subject: string, budget: number): string {
	return fitWidth(subject, Math.max(4, budget));
}

function materializeTodoOverlayCache(cache: TodoOverlayRenderCache, spinner: string, width: number): string[] {
	const lines = [...cache.header];
	for (const row of cache.rows) {
		if (row.kind === "static") {
			lines.push(row.line);
			continue;
		}
		lines.push(fitWidth(row.connector + renderRow(row.item, spinner, width), width));
	}
	if (cache.footer) lines.push(cache.footer);
	return lines;
}

function cappedDisplayRows(sorted: TodoItem[]): { rows: TodoItem[]; hiddenCompleted: number } {
	const rows = sorted;
	let hiddenCompleted = 0;
	if (rows.length <= OVERLAY_MAX_ROWS) {
		return { rows, hiddenCompleted };
	}
	const completed = rows.filter((t) => t.status === "completed");
	const active = rows.filter((t) => t.status !== "completed");
	const keep = Math.max(0, OVERLAY_MAX_ROWS - active.length);
	hiddenCompleted = Math.max(0, completed.length - keep);
	return { rows: [...active, ...completed.slice(completed.length - keep)], hiddenCompleted };
}

function buildTodoOverlayCache(
	data: TodoOverlayData,
	width: number,
	dataKey: string,
	sorted: TodoItem[],
): TodoOverlayRenderCache {
	const header: string[] = [];
	const headerText = `${theme.fg("accent", "●")} ${theme.bold("Tasks")} ${theme.fg("dim", "—")} ${theme.fg("muted", `${data.done}/${data.total}`)}`;
	header.push(fitWidth(headerText, width));

	const progress = renderProgressBar(data.done, data.total, width);
	if (progress) {
		header.push(fitWidth(`${theme.fg("dim", "├─ ")}${progress}`, width));
	}

	const { rows: displayRows, hiddenCompleted } = cappedDisplayRows(sorted);
	const rows: TodoOverlayRow[] = [];
	displayRows.forEach((item, idx) => {
		const isLast = idx === displayRows.length - 1 && hiddenCompleted === 0;
		const connector = theme.fg("dim", isLast ? "└─ " : "├─ ");
		if (item.status === "in_progress") {
			rows.push({ kind: "spinner", connector, item });
			return;
		}
		rows.push({ kind: "static", line: fitWidth(connector + renderRow(item, "", width), width) });
	});

	const footer = hiddenCompleted > 0 ? theme.fg("dim", `└─ … ${hiddenCompleted} done hidden`) : undefined;
	return { dataKey, width, header, rows, footer };
}

function renderRow(item: TodoItem, spinner: string, width: number): string {
	const rowBudget = Math.max(4, width - CONNECTOR_WIDTH);

	switch (item.status) {
		case "completed": {
			const subject = truncateSubject(item.subject, rowBudget - ROW_PREFIX_WIDTH);
			return `${theme.fg("success", "✓")} ${theme.fg("dim", strike(subject))}`;
		}
		case "in_progress": {
			if (item.activeForm) {
				const suffixText = ` — ${item.activeForm}`;
				const suffixWidth = visibleWidth(suffixText);
				const subject = truncateSubject(item.subject, rowBudget - ROW_PREFIX_WIDTH - suffixWidth);
				return `${theme.fg("warning", spinner)} ${theme.fg("accent", subject)}${theme.fg("dim", suffixText)}`;
			}
			const subject = truncateSubject(item.subject, rowBudget - ROW_PREFIX_WIDTH);
			return `${theme.fg("warning", spinner)} ${theme.fg("accent", subject)}`;
		}
		default: {
			const subject = truncateSubject(item.subject, rowBudget - ROW_PREFIX_WIDTH);
			return `${theme.fg("muted", "○")} ${subject}`;
		}
	}
}

/**
 * Pure renderer (testable): returns [] when there are no todos, or when a
 * fully-completed list has lingered past `TODO_COMPLETE_LINGER_MS`
 * (signalled by `completeAgeMs`; omit it to hide a complete list at once).
 */
export function renderTodoOverlay(
	data: TodoOverlayData,
	width: number,
	spinner: string,
	completeAgeMs?: number,
): string[] {
	if (data.items.length === 0) return [];
	if (data.done === data.total && (completeAgeMs === undefined || completeAgeMs > TODO_COMPLETE_LINGER_MS)) {
		return [];
	}
	const sorted = sortTodosForDisplay(data.items);
	const dataKey = todoOverlayDataKey(data, sorted);
	return materializeTodoOverlayCache(buildTodoOverlayCache(data, width, dataKey, sorted), spinner, width);
}

class TodoOverlayComponent implements Component {
	private session: AgentSession;
	private readonly clock: () => number;
	private renderCache: TodoOverlayRenderCache | undefined;
	// First render at which the list was seen fully complete (goal-overlay's
	// completeSeenAt pattern) — drives the linger window before auto-hide.
	private completeSeenAt: number | undefined;

	constructor(session: AgentSession, clock: () => number = () => performance.now()) {
		this.session = session;
		this.clock = clock;
	}

	setSession(session: AgentSession): void {
		this.session = session;
		this.renderCache = undefined;
		this.completeSeenAt = undefined;
	}

	invalidate(): void {
		this.renderCache = undefined;
	}

	render(width: number): string[] {
		const data = this.session.todoForOverlay();
		if (data.items.length === 0) {
			this.renderCache = undefined;
			this.completeSeenAt = undefined;
			return [];
		}
		if (data.done === data.total) {
			if (this.completeSeenAt === undefined) this.completeSeenAt = this.clock();
			if (this.clock() - this.completeSeenAt > TODO_COMPLETE_LINGER_MS) {
				this.renderCache = undefined;
				return [];
			}
		} else {
			this.completeSeenAt = undefined;
		}
		const spinner = spinnerGlyphAt(this.clock());
		const sorted = sortTodosForDisplay(data.items);
		const dataKey = todoOverlayDataKey(data, sorted);
		if (this.renderCache?.dataKey !== dataKey || this.renderCache.width !== width) {
			this.renderCache = buildTodoOverlayCache(data, width, dataKey, sorted);
		}
		return ["", ...materializeTodoOverlayCache(this.renderCache, spinner, width)];
	}
}

export type TodoOverlay = Component & { setSession(session: AgentSession): void };

export function createTodoOverlay(session: AgentSession, clock?: () => number): TodoOverlay {
	return new TodoOverlayComponent(session, clock);
}
