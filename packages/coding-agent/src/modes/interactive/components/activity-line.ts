import { Container, SPINNER_FRAMES, type TUI } from "@pit/tui";
import { theme } from "../theme/theme.ts";
import { createSpinnerTicker } from "./spinner-ticker.ts";
import { formatActionSummary } from "./tool-activity.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

const ICON_SUCCESS = "✓";
const ICON_ERROR = "✗";

/** Wraps a single action tool call as a clean summary line
 * (`✓ Edited path +1 -1`). The wrapped exec is the expandable detail (its own
 * renderCall/renderResult), rendered gutter-less. Errors auto-expand. */
export class ActivityLineComponent extends Container {
	private ui: TUI;
	private exec: ToolExecutionComponent;
	private expanded = false;
	private errorAutoExpanded = false;
	private spinnerGlyph: string | null = null;

	constructor(exec: ToolExecutionComponent, ui: TUI) {
		super();
		this.exec = exec;
		this.ui = ui;
		exec.setActivityChild(true);
		createSpinnerTicker(
			ui,
			() => this.exec.getActivityState() === "pending",
			(g) => {
				this.spinnerGlyph = g;
				this.ui.requestRender();
			},
		);
	}

	/** Duck-typed Expandable (interactive-mode's ctrl+o loop). */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.exec.setExpanded(expanded);
	}

	private icon(): string {
		const state = this.exec.getActivityState();
		if (state === "pending") return theme.fg("gutterToolPending", this.spinnerGlyph ?? SPINNER_FRAMES[0]);
		if (state === "error") {
			return this.exec.isAborted() ? theme.fg("muted", ICON_ERROR) : theme.fg("gutterToolError", ICON_ERROR);
		}
		return theme.fg("gutterToolSuccess", ICON_SUCCESS);
	}

	private header(): string {
		const { verb, identifier, diffstat } = formatActionSummary(
			this.exec.getToolName(),
			this.exec.getArgs(),
			this.exec.getResultDetails(),
		);
		let line = `${this.icon()} ${theme.bold(verb)}`;
		if (identifier) line += ` ${theme.fg("toolOutput", identifier)}`;
		if (diffstat) {
			line += ` ${theme.fg("gutterToolSuccess", `+${diffstat.added}`)} ${theme.fg("gutterToolError", `-${diffstat.removed}`)}`;
		}
		return line;
	}

	override render(width: number): string[] {
		const state = this.exec.getActivityState();
		// Real errors auto-expand their detail; an abort/interruption does not —
		// the user already chose to stop, so don't dump the captured output.
		const isRealError = state === "error" && !this.exec.isAborted();
		if (isRealError && !this.errorAutoExpanded) {
			this.exec.setExpanded(true);
			this.errorAutoExpanded = true;
		}
		const lines = [this.header()];
		if (this.expanded || isRealError) {
			for (const l of this.exec.render(width - 2)) lines.push(`  ${l}`);
		}
		return lines;
	}
}
