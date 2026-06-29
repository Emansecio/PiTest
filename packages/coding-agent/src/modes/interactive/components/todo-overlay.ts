/**
 * TodoOverlayComponent — the live "above editor" todo list. Auto-hides when
 * empty (render returns []), and animates the in_progress glyph. Reads fresh
 * state from the AgentSession on every render (FooterComponent pattern).
 */

import { performance } from "node:perf_hooks";
import { type Component, SPINNER_FRAME_MS, SPINNER_FRAMES, truncateToWidth, visibleWidth } from "@pit/tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { TodoItem } from "../../../core/todo/todo-manager.ts";
import { theme } from "../theme/theme.ts";

/** Cap on overlay rows; completed todos are hidden first when exceeded. */
const OVERLAY_MAX_ROWS = 12;
/** Progress bar width (visible block chars, excluding connector). */
const PROGRESS_BAR_WIDTH = 12;

function strike(text: string): string {
	return `\x1b[9m${text}\x1b[29m`;
}

/** in_progress first, then pending, then completed — active work stays on top. */
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
	const barWidth = Math.min(PROGRESS_BAR_WIDTH, Math.max(4, width - CONNECTOR_WIDTH - 8));
	const filled = Math.round((done / total) * barWidth);
	const empty = barWidth - filled;
	const filledPart = theme.fg("success", "█".repeat(filled));
	const emptyPart = theme.fg("dim", "░".repeat(empty));
	const pct = Math.round((done / total) * 100);
	const label = `${done}/${total} · ${pct}%`;
	return `${filledPart}${emptyPart} ${theme.fg("muted", label)}`;
}

export interface TodoOverlayData {
	items: TodoItem[];
	done: number;
	total: number;
}

// CONNECTOR_WIDTH: "├─ " or "└─ " = 3 visible chars added by renderTodoOverlay.
const CONNECTOR_WIDTH = 3;
// PREFIX_WIDTH: glyph + space inside the row ("⠏ " or "✓ " or "○ ") = 2 visible chars.
const ROW_PREFIX_WIDTH = 2;

function renderRow(item: TodoItem, spinner: string, width: number): string {
	// Budget for text inside the row, after accounting for the connector prefix.
	const rowBudget = Math.max(4, width - CONNECTOR_WIDTH);

	switch (item.status) {
		case "completed": {
			const subjectBudget = Math.max(4, rowBudget - ROW_PREFIX_WIDTH);
			const subject =
				visibleWidth(item.subject) > subjectBudget
					? truncateToWidth(item.subject, subjectBudget, "…")
					: item.subject;
			return `${theme.fg("success", "✓")} ${theme.fg("dim", strike(subject))}`;
		}
		case "in_progress": {
			if (item.activeForm) {
				// Reserve space for " — activeForm" suffix.
				const suffixText = ` — ${item.activeForm}`;
				const suffixWidth = visibleWidth(suffixText);
				const subjectBudget = Math.max(4, rowBudget - ROW_PREFIX_WIDTH - suffixWidth);
				const subject =
					visibleWidth(item.subject) > subjectBudget
						? truncateToWidth(item.subject, subjectBudget, "…")
						: item.subject;
				return `${theme.fg("warning", spinner)} ${theme.fg("accent", subject)}${theme.fg("dim", suffixText)}`;
			}
			const subjectBudget = Math.max(4, rowBudget - ROW_PREFIX_WIDTH);
			const subject =
				visibleWidth(item.subject) > subjectBudget
					? truncateToWidth(item.subject, subjectBudget, "…")
					: item.subject;
			return `${theme.fg("warning", spinner)} ${theme.fg("accent", subject)}`;
		}
		default: {
			const subjectBudget = Math.max(4, rowBudget - ROW_PREFIX_WIDTH);
			const subject =
				visibleWidth(item.subject) > subjectBudget
					? truncateToWidth(item.subject, subjectBudget, "…")
					: item.subject;
			return `${theme.fg("muted", "○")} ${subject}`;
		}
	}
}

/** Pure renderer (testable): returns [] when there are no todos. */
export function renderTodoOverlay(data: TodoOverlayData, width: number, spinner: string): string[] {
	// Auto-hide when there are no todos OR every todo is done — the list vanishes
	// once the work is complete instead of lingering as struck-through items.
	if (data.items.length === 0 || data.done === data.total) return [];

	// Truncation: keep all non-completed; drop oldest completed first.
	let rows = sortTodosForDisplay(data.items);
	let hiddenCompleted = 0;
	if (rows.length > OVERLAY_MAX_ROWS) {
		const completed = rows.filter((t) => t.status === "completed");
		const active = rows.filter((t) => t.status !== "completed");
		const keep = Math.max(0, OVERLAY_MAX_ROWS - active.length);
		hiddenCompleted = Math.max(0, completed.length - keep);
		rows = [...active, ...completed.slice(completed.length - keep)];
	}

	const lines: string[] = [];
	const header = `${theme.fg("accent", "●")} ${theme.bold("Tasks")} ${theme.fg("dim", "—")} ${theme.fg("muted", `${data.done}/${data.total}`)}`;
	lines.push(visibleWidth(header) > width ? truncateToWidth(header, width, "…") : header);

	const progress = renderProgressBar(data.done, data.total, width);
	if (progress) {
		const progressLine = `${theme.fg("dim", "├─ ")}${progress}`;
		lines.push(visibleWidth(progressLine) > width ? truncateToWidth(progressLine, width, "…") : progressLine);
	}

	rows.forEach((item, idx) => {
		const isLast = idx === rows.length - 1 && hiddenCompleted === 0;
		const connector = theme.fg("dim", isLast ? "└─ " : "├─ ");
		const row = connector + renderRow(item, spinner, width);
		lines.push(visibleWidth(row) > width ? truncateToWidth(row, width, "…") : row);
	});
	if (hiddenCompleted > 0) {
		lines.push(theme.fg("dim", `└─ … ${hiddenCompleted} done hidden`));
	}
	return lines;
}

class TodoOverlayComponent implements Component {
	private session: AgentSession;
	private readonly clock: () => number;

	// Default clock is the same monotonic source the animation ticker feeds every
	// other spinner (`performance.now()`), so when the overlay repaints during
	// active work its half-moon frame is phase-locked with the loader/tool/goal
	// spinners instead of running on a separate `Date.now()` epoch (P7).
	constructor(session: AgentSession, clock: () => number = () => performance.now()) {
		this.session = session;
		this.clock = clock;
	}

	/** Rebind to the current session after a /new, fork, or session switch. */
	setSession(session: AgentSession): void {
		this.session = session;
	}

	invalidate(): void {
		// No cached state.
	}

	render(width: number): string[] {
		const data = this.session.todoForOverlay();
		if (data.items.length === 0 || data.done === data.total) return [];
		const frame = SPINNER_FRAMES[Math.floor(this.clock() / SPINNER_FRAME_MS) % SPINNER_FRAMES.length];
		const lines = renderTodoOverlay(data, width, frame ?? SPINNER_FRAMES[0]);
		// A leading blank line separates the overlay from the chat above it.
		return lines.length > 0 ? ["", ...lines] : [];
	}
}

export type TodoOverlay = Component & { setSession(session: AgentSession): void };

export function createTodoOverlay(session: AgentSession, clock?: () => number): TodoOverlay {
	return new TodoOverlayComponent(session, clock);
}
