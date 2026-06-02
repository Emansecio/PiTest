/**
 * TodoOverlayComponent — the live "above editor" todo list. Auto-hides when
 * empty (render returns []), and animates the in_progress glyph. Reads fresh
 * state from the AgentSession on every render (FooterComponent pattern).
 */

import type { Component } from "@pit/tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { TodoItem } from "../../../core/todo/todo-manager.ts";
import { theme } from "../theme/theme.ts";

/** Half-moon spinner frames for in_progress todos (matches the package look). */
export const TODO_SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const SPINNER_INTERVAL_MS = 120;
/** Cap on overlay rows; completed todos are hidden first when exceeded. */
const OVERLAY_MAX_ROWS = 12;

function strike(text: string): string {
	return `\x1b[9m${text}\x1b[29m`;
}

export interface TodoOverlayData {
	items: TodoItem[];
	done: number;
	total: number;
}

function renderRow(item: TodoItem, spinner: string, width: number): string {
	const max = Math.max(10, width - 30);
	const subject = item.subject.length > max ? `${item.subject.slice(0, max - 1)}…` : item.subject;
	switch (item.status) {
		case "completed":
			return `${theme.fg("success", "✓")} ${theme.fg("dim", strike(subject))}`;
		case "in_progress": {
			const head = `${theme.fg("warning", spinner)} ${subject}`;
			return item.activeForm ? `${head}  ${theme.fg("dim", `(${item.activeForm})`)}` : head;
		}
		default:
			return `${theme.fg("muted", "○")} ${subject}`;
	}
}

/** Pure renderer (testable): returns [] when there are no todos. */
export function renderTodoOverlay(data: TodoOverlayData, width: number, spinner: string): string[] {
	// Auto-hide when there are no todos OR every todo is done — the list vanishes
	// once the work is complete instead of lingering as struck-through items.
	if (data.items.length === 0 || data.done === data.total) return [];

	// Truncation: keep all non-completed; drop oldest completed first.
	let rows = data.items;
	let hiddenCompleted = 0;
	if (rows.length > OVERLAY_MAX_ROWS) {
		const completed = rows.filter((t) => t.status === "completed");
		const active = rows.filter((t) => t.status !== "completed");
		const keep = Math.max(0, OVERLAY_MAX_ROWS - active.length);
		hiddenCompleted = Math.max(0, completed.length - keep);
		rows = [...completed.slice(completed.length - keep), ...active];
	}

	const lines: string[] = [];
	lines.push(`${theme.fg("accent", "●")} ${theme.bold(`Todos (${data.done}/${data.total})`)}`);
	rows.forEach((item, idx) => {
		const isLast = idx === rows.length - 1 && hiddenCompleted === 0;
		const connector = theme.fg("dim", isLast ? "└─ " : "├─ ");
		lines.push(connector + renderRow(item, spinner, width));
	});
	if (hiddenCompleted > 0) {
		lines.push(theme.fg("dim", `└─ … ${hiddenCompleted} completed hidden`));
	}
	return lines;
}

class TodoOverlayComponent implements Component {
	private session: AgentSession;
	private readonly clock: () => number;

	constructor(session: AgentSession, clock: () => number = () => Date.now()) {
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
		const frame = TODO_SPINNER_FRAMES[Math.floor(this.clock() / SPINNER_INTERVAL_MS) % TODO_SPINNER_FRAMES.length];
		const lines = renderTodoOverlay(data, width, frame ?? TODO_SPINNER_FRAMES[0]);
		// A leading blank line separates the overlay from the chat above it.
		return lines.length > 0 ? ["", ...lines] : [];
	}
}

export type TodoOverlay = Component & { setSession(session: AgentSession): void };

export function createTodoOverlay(session: AgentSession, clock?: () => number): TodoOverlay {
	return new TodoOverlayComponent(session, clock);
}
