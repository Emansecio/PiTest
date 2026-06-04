import type { Component, TUI } from "@pit/tui";
import { NavGroupComponent } from "./components/nav-group.ts";
import type { ToolExecutionComponent } from "./components/tool-execution.ts";

/**
 * Owns the single rule that folds a stream of tool components into one activity
 * group. Every call accumulates into the current group; the group is divided
 * only by visible agent text (divide) or a new turn / history rebuild (reset).
 * Pure placement logic so it can be unit-tested without the interactive mode.
 */
export class ActivityStacker {
	private ui: TUI;
	private addToChat: (component: Component) => void;
	private current: NavGroupComponent | null = null;

	constructor(ui: TUI, addToChat: (component: Component) => void) {
		this.ui = ui;
		this.addToChat = addToChat;
	}

	/** Fold a tool call into the current activity group (created on demand). */
	placeCall(exec: ToolExecutionComponent): void {
		if (!this.current) {
			this.current = new NavGroupComponent(this.ui);
			this.addToChat(this.current);
		}
		this.current.addCall(exec);
	}

	/** Agent text or abort splits the burst without promoting state. */
	divide(): void {
		this.current = null;
	}

	/** New turn / history rebuild: forget the open group. */
	reset(): void {
		this.current = null;
	}
}
