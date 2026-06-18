/**
 * TodoManager — session-scoped task list, modelled after the
 * `@juicesharp/rpiv-todo` extension (MVP: no dependency graph).
 *
 * Pure state machine over a list of todos — no UI/theme deps, so it stays
 * usable from headless modes. The AgentSession owns persistence and restore;
 * the interactive `TodoOverlayComponent` owns colored rendering. Mirrors the
 * GoalManager pattern (see goal/goal-manager.ts).
 */

import { truncateWithEllipsis } from "../../utils/surrogate.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	id: number;
	subject: string;
	description?: string;
	/** Present-continuous label shown next to an in_progress todo. */
	activeForm?: string;
	status: TodoStatus;
}

export interface TodoState {
	items: TodoItem[];
	nextId: number;
}

export interface CreateTodoInput {
	subject: string;
	description?: string;
	activeForm?: string;
}

export interface UpdateTodoInput {
	id: number;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TodoStatus;
}

const SUBJECT_MAX = 200;

function clampSubject(s: string): string {
	return truncateWithEllipsis(s.trim(), SUBJECT_MAX);
}

export class TodoManager {
	private items: TodoItem[] = [];
	private nextId = 1;
	private dirty = false;
	private changeListener?: () => void;

	/** Returns whether state changed since the last call, then resets the flag. */
	takeDirty(): boolean {
		const was = this.dirty;
		this.dirty = false;
		return was;
	}

	/**
	 * Register a listener fired synchronously after every mutation. The interactive
	 * mode points this at `ui.requestRender()` so the live overlay repaints the
	 * instant a todo is created/updated/deleted/cleared, instead of waiting for an
	 * incidental render (loader tick, tool event). Pass `undefined` to clear.
	 */
	setChangeListener(listener: (() => void) | undefined): void {
		this.changeListener = listener;
	}

	/** Mark the state dirty (for persistence) and notify the live-render listener. */
	private markChanged(): void {
		this.dirty = true;
		this.changeListener?.();
	}

	list(filter?: { status?: TodoStatus }): TodoItem[] {
		const all = this.items.map((t) => ({ ...t }));
		return filter?.status ? all.filter((t) => t.status === filter.status) : all;
	}

	get(id: number): TodoItem | undefined {
		const found = this.items.find((t) => t.id === id);
		return found ? { ...found } : undefined;
	}

	create(input: CreateTodoInput): TodoItem {
		// Starting fresh work after the previous batch is fully done: drop the
		// completed list so new todos don't pile up as "next steps" under stale
		// checked-off items.
		if (this.items.length > 0 && this.items.every((t) => t.status === "completed")) {
			this.items = [];
			this.nextId = 1;
		}
		const item: TodoItem = {
			id: this.nextId++,
			subject: clampSubject(input.subject),
			description: input.description?.trim() || undefined,
			activeForm: input.activeForm?.trim() || undefined,
			status: "pending",
		};
		this.items.push(item);
		this.markChanged();
		return { ...item };
	}

	update(input: UpdateTodoInput): TodoItem | undefined {
		const item = this.items.find((t) => t.id === input.id);
		if (!item) return undefined;
		if (input.subject !== undefined) item.subject = clampSubject(input.subject);
		if (input.description !== undefined) item.description = input.description.trim() || undefined;
		if (input.activeForm !== undefined) item.activeForm = input.activeForm.trim() || undefined;
		if (input.status !== undefined) item.status = input.status;
		this.markChanged();
		return { ...item };
	}

	delete(id: number): boolean {
		const before = this.items.length;
		this.items = this.items.filter((t) => t.id !== id);
		const changed = this.items.length < before;
		if (changed) this.markChanged();
		return changed;
	}

	clear(): void {
		const had = this.items.length > 0;
		this.items = [];
		if (had) this.markChanged();
	}

	counts(): { done: number; total: number } {
		return { done: this.items.filter((t) => t.status === "completed").length, total: this.items.length };
	}

	isEmpty(): boolean {
		return this.items.length === 0;
	}

	hasInProgress(): boolean {
		return this.items.some((t) => t.status === "in_progress");
	}

	serialize(): TodoState {
		return { items: this.items.map((t) => ({ ...t })), nextId: this.nextId };
	}

	restore(data: TodoState | undefined): void {
		if (!data || !Array.isArray(data.items)) {
			this.items = [];
			this.nextId = 1;
			return;
		}
		this.items = data.items.map((t) => ({ ...t }));
		const maxId = this.items.reduce((m, t) => Math.max(m, t.id), 0);
		this.nextId = Math.max(typeof data.nextId === "number" ? data.nextId : 1, maxId + 1);
	}

	/** Human-readable multi-line summary for the `/todos` command. */
	summaryText(): string {
		if (this.items.length === 0) return "No todos. The agent creates them with the `todo` tool.";
		const { done, total } = this.counts();
		const glyph: Record<TodoStatus, string> = { completed: "✓", in_progress: "◐", pending: "○" };
		const lines = [`Todos (${done}/${total})`];
		for (const t of this.items) {
			const active = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
			lines.push(`  ${glyph[t.status]} #${t.id} ${t.subject}${active}`);
		}
		return lines.join("\n");
	}

	/** Section injected into the system prompt while there is (or could be) work to track. */
	systemPromptSection(): string {
		if (this.items.length === 0) return "";
		const open = this.items.filter((t) => t.status !== "completed").length;
		const glyph: Record<TodoStatus, string> = { completed: "✓", in_progress: "◐", pending: "○" };
		const itemLines = this.items.map((t) => {
			const active = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
			return `${glyph[t.status]} #${t.id} ${t.subject}${active}`;
		});
		return [
			"<todos>",
			`Current task list (${open} open of ${this.items.length}):`,
			...itemLines,
			"Keep it current with the `todo` tool:",
			"- Mark exactly one todo in_progress at a time before you start it, with a short present-continuous activeForm.",
			"- Mark a todo completed immediately when it is done — do not batch completions.",
			"- Add new todos as you discover follow-up work; keep subjects short and outcome-focused.",
			"</todos>",
		].join("\n");
	}
}

// ---------------------------------------------------------------------------
// Module-level "current session" registry, mirroring goal-manager / preview-queue.
// The `todo` tool reaches the active manager through this without per-call plumbing.
// ---------------------------------------------------------------------------

let currentTodoManager: TodoManager | undefined;

export function setCurrentTodoManager(mgr: TodoManager | undefined): void {
	currentTodoManager = mgr;
}

export function getCurrentTodoManager(): TodoManager | undefined {
	return currentTodoManager;
}
