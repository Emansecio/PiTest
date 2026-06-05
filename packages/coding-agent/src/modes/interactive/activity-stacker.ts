import type { Component, TUI } from "@pit/tui";
import { ActivityLineComponent } from "./components/activity-line.ts";
import { NavGroupComponent } from "./components/nav-group.ts";
import type { ToolExecutionComponent } from "./components/tool-execution.ts";

/** Tools that are a turn exchange with the user, not background activity:
 * rendered as their own turn block elsewhere, never in the activity stream. */
const TURN_EXCHANGE_TOOLS = new Set(["ask", "resolve"]);

/**
 * Owns the routing rule that maps a tool call into the activity stream.
 * Navigation folds into a NavGroup; an action closes the open group and gets
 * its own ActivityLine; ask/resolve are skipped (returns false so the caller
 * can render them as turn blocks).
 */
export class ActivityStacker {
	private ui: TUI;
	private addToChat: (component: Component) => void;
	private current: NavGroupComponent | null = null;

	constructor(ui: TUI, addToChat: (component: Component) => void) {
		this.ui = ui;
		this.addToChat = addToChat;
	}

	/** Place a tool call. Navigation folds into the open group; an action closes
	 * the group and gets its own ActivityLine. Returns false when the tool is a
	 * turn exchange (ask/resolve) the caller should render itself. */
	placeCall(exec: ToolExecutionComponent): boolean {
		if (TURN_EXCHANGE_TOOLS.has(exec.getToolName())) {
			this.current = null;
			return false;
		}
		if (exec.getActivityFamily() === "action") {
			this.current = null;
			const line = new ActivityLineComponent(this.ui);
			this.addToChat(line);
			line.setExec(exec);
			return true;
		}
		if (!this.current) {
			this.current = new NavGroupComponent(this.ui);
			this.addToChat(this.current);
		}
		this.current.addCall(exec);
		return true;
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
