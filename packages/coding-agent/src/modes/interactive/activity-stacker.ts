import type { Component, TUI } from "@pit/tui";
import { ActivityLineComponent } from "./components/activity-line.ts";
import { BashGroupComponent } from "./components/bash-group.ts";
import { NavGroupComponent } from "./components/nav-group.ts";
import { actionCoalesceKey } from "./components/tool-activity.ts";
import type { ToolExecutionComponent } from "./components/tool-execution.ts";

/** Tools that are a turn exchange with the user, not background activity:
 * rendered as their own turn block elsewhere, never in the activity stream. */
const TURN_EXCHANGE_TOOLS = new Set(["ask", "resolve"]);

/**
 * Owns the routing rule that maps a tool call into the activity stream.
 * Navigation folds into a NavGroup; consecutive `bash` actions fold into a
 * BashGroup; other actions close open groups and get their own ActivityLine;
 * consecutive identical actions fold into one line with a `×N` counter;
 * ask/resolve are skipped (returns false so the caller can render them as turn
 * blocks).
 *
 * Activity blocks stack tight — there is no blank between consecutive tool
 * blocks. The breathing room comes from the agent-text boundary (each
 * MessageShell / AssistantMessage brings its own leading blank), so a long
 * burst of tool calls reads as a compact list instead of a double-spaced one.
 */
export class ActivityStacker {
	private ui: TUI;
	private addToChat: (component: Component) => void;
	private current: NavGroupComponent | null = null;
	private currentBash: BashGroupComponent | null = null;
	// Per-turn sequence for unnamed `task` agents (reset on reset()).
	private taskOrdinal = 0;
	// The last action line placed + its coalesce fingerprint. A new action with
	// the SAME fingerprint folds into it (×N) instead of stacking an identical
	// row. Any navigation call, turn exchange, or divide/reset breaks the run.
	private lastAction: ActivityLineComponent | null = null;
	private lastActionKey: string | null = null;

	constructor(ui: TUI, addToChat: (component: Component) => void) {
		this.ui = ui;
		this.addToChat = addToChat;
	}

	/** Place a tool call. Navigation folds into the open group; an action closes
	 * the group and gets its own ActivityLine (or folds into the previous one when
	 * identical). Returns false when the tool is a turn exchange (ask/resolve) the
	 * caller should render itself. */
	placeCall(exec: ToolExecutionComponent): boolean {
		if (TURN_EXCHANGE_TOOLS.has(exec.getToolName())) {
			this.breakRun();
			return false;
		}
		if (exec.getActivityFamily() === "action") {
			this.current = null;
			if (exec.getToolName() === "bash") {
				this.lastAction = null;
				this.lastActionKey = null;
				if (!this.currentBash) {
					this.currentBash = new BashGroupComponent(this.ui);
					this.addToChat(this.currentBash);
				}
				this.currentBash.addCall(exec);
				return true;
			}
			this.currentBash = null;
			const key = actionCoalesceKey(exec.getToolName(), exec.getArgs());
			if (key !== null && this.lastAction && this.lastActionKey === key) {
				this.lastAction.coalesce(exec);
				return true;
			}
			const line = new ActivityLineComponent(this.ui);
			this.addToChat(line);
			// Number unnamed task agents per turn so they get a stable "Agente N".
			const ordinal = exec.getToolName() === "task" ? ++this.taskOrdinal : 0;
			line.setExec(exec, ordinal);
			this.lastAction = line;
			this.lastActionKey = key;
			return true;
		}
		// Navigation breaks any in-progress action/bash run, then folds into the group.
		this.lastAction = null;
		this.lastActionKey = null;
		this.currentBash = null;
		if (!this.current) {
			this.current = new NavGroupComponent(this.ui);
			this.addToChat(this.current);
		}
		this.current.addCall(exec);
		return true;
	}

	/** Agent text or abort splits the burst without promoting state. */
	divide(): void {
		this.breakRun();
	}

	/** New turn / history rebuild: forget the open group and restart agent numbering. */
	reset(): void {
		this.breakRun();
		this.taskOrdinal = 0;
	}

	/** Close the open NavGroup and the action-coalescing run so the next call
	 * starts fresh. Shared by divide/reset and the turn-exchange path. */
	private breakRun(): void {
		this.current = null;
		this.currentBash = null;
		this.lastAction = null;
		this.lastActionKey = null;
	}
}
