import type { Component, TUI } from "@pit/tui";
import { ActivityLineComponent } from "./components/activity-line.ts";
import { NavGroupComponent } from "./components/nav-group.ts";
import type { ToolExecutionComponent } from "./components/tool-execution.ts";

/**
 * Owns the single rule that turns a stream of tool components into grouped
 * activity: contiguous navigation accumulates in one NavGroup; an action closes
 * it and gets its own line; agent text / abort / a new turn divide the burst.
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

	placeNavigation(exec: ToolExecutionComponent): void {
		if (!this.current) {
			this.current = new NavGroupComponent(this.ui);
			this.addToChat(this.current);
		}
		this.current.addCall(exec);
	}

	placeAction(exec: ToolExecutionComponent): void {
		this.current = null;
		this.addToChat(new ActivityLineComponent(exec, this.ui));
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
