import { type Component, Spacer, type TUI } from "@pit/tui";
import type { ToolExecutionComponent } from "./components/tool-execution.ts";
import { WorkGroupComponent } from "./components/work-group.ts";

/** Tools that are a turn exchange with the user, not background activity:
 * rendered as their own turn block elsewhere, never in the activity stream. */
const TURN_EXCHANGE_TOOLS = new Set(["ask", "resolve"]);

/**
 * Routes tool calls into the activity stream as a sequence of WORK PHASES. Every
 * call between two agent-text divides folds into one {@link WorkGroupComponent}:
 * navigation + bash + misc actions collapse into a dense cross-family counter
 * (`5 searches·8 commands`), while high-signal calls — edits, writes, task
 * delegations, and todo/plan bookkeeping — are promoted to their own line beneath
 * it. An action in the middle no longer fragments the phase into three blocks.
 *
 * `divide()` (visible agent text) seals the open phase, and a sealed phase collapses
 * to a single summary line; the next call opens a fresh phase. Activity phases stack
 * tight — a blank divides bursts only where agent narration intervenes, so narration
 * gets breathing room without double-spacing a long tool run.
 *
 * ask/resolve are turn exchanges, not activity: placeCall returns false so the
 * caller renders them as their own turn block.
 */
export class ActivityStacker {
	private ui: TUI;
	private addToChat: (component: Component) => void;
	private current: WorkGroupComponent | null = null;
	// Per-turn sequence for unnamed `task` agents (reset on reset()).
	private taskOrdinal = 0;
	private gapBeforeNextActivity = false;
	/** When true, activity spinners hold still so the working loader owns motion. */
	private spinnersFrozen = false;
	private readonly isFrozen = (): boolean => this.spinnersFrozen;

	constructor(ui: TUI, addToChat: (component: Component) => void) {
		this.ui = ui;
		this.addToChat = addToChat;
	}

	/** Freeze/unfreeze WorkGroup + ActivityLine spinners (one animated zone). */
	setSpinnersFrozen(frozen: boolean): void {
		this.spinnersFrozen = frozen;
	}

	private appendActivity(component: Component): void {
		if (this.gapBeforeNextActivity) {
			this.addToChat(new Spacer(1));
			this.gapBeforeNextActivity = false;
		}
		this.addToChat(component);
	}

	/** Place a tool call into the current work phase, opening one if needed. Returns
	 * false when the tool is a turn exchange (ask/resolve) the caller renders itself. */
	placeCall(exec: ToolExecutionComponent): boolean {
		if (TURN_EXCHANGE_TOOLS.has(exec.getToolName())) {
			this.seal();
			this.gapBeforeNextActivity = false;
			return false;
		}
		if (!this.current) {
			this.current = new WorkGroupComponent(this.ui, this.isFrozen);
			this.appendActivity(this.current);
		}
		// Number unnamed task agents per turn so they get a stable "Agent N".
		const ordinal = exec.getToolName() === "task" ? ++this.taskOrdinal : 0;
		this.current.addCall(exec, ordinal);
		return true;
	}

	/** Agent text or abort splits the burst: seal the open phase and leave a gap so
	 * the next real activity block has one leading blank. */
	divide(): void {
		this.seal();
		this.gapBeforeNextActivity = true;
	}

	/** New turn / history rebuild: seal the open phase and restart agent numbering. */
	reset(): void {
		this.seal();
		this.gapBeforeNextActivity = false;
		this.taskOrdinal = 0;
	}

	/** Seal the open phase (so it collapses to its summary) and detach it, so the
	 * next call opens a fresh phase. Shared by divide/reset and the turn-exchange path. */
	private seal(): void {
		this.current?.seal();
		this.current = null;
	}
}
