import { type Component, Spacer, type TUI } from "@pit/tui";
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
	// Per-turn sequence for unnamed `task` agents (reset on reset()).
	private taskOrdinal = 0;
	// True once an activity entry has been added in the current burst (since the
	// last divide/reset). Drives a single blank line BETWEEN consecutive activity
	// blocks for a little breathing room — navigation calls folded into the same
	// NavGroup stay tight (no blank between them).
	private addedInBurst = false;

	constructor(ui: TUI, addToChat: (component: Component) => void) {
		this.ui = ui;
		this.addToChat = addToChat;
	}

	/** Add a new activity block to the chat, preceded by one blank line when it is
	 * not the first block of the burst, so stacked tool blocks get some air. */
	private addEntry(component: Component): void {
		if (this.addedInBurst) this.addToChat(new Spacer(1));
		this.addToChat(component);
		this.addedInBurst = true;
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
			this.addEntry(line);
			// Number unnamed task agents per turn so they get a stable "Agente N".
			const ordinal = exec.getToolName() === "task" ? ++this.taskOrdinal : 0;
			line.setExec(exec, ordinal);
			return true;
		}
		if (!this.current) {
			this.current = new NavGroupComponent(this.ui);
			this.addEntry(this.current);
		}
		this.current.addCall(exec);
		return true;
	}

	/** Agent text or abort splits the burst without promoting state. */
	divide(): void {
		this.current = null;
		this.addedInBurst = false;
	}

	/** New turn / history rebuild: forget the open group and restart agent numbering. */
	reset(): void {
		this.current = null;
		this.taskOrdinal = 0;
		this.addedInBurst = false;
	}
}
