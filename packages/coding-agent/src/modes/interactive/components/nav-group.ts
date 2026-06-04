import { Container, SPINNER_FRAMES, type TUI } from "@pit/tui";
import { theme } from "../theme/theme.ts";
import { createSpinnerTicker } from "./spinner-ticker.ts";
import { navNounFor, pluralizeNoun } from "./tool-activity.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

type GroupState = "pending" | "success" | "error";

const ICON_SUCCESS = "✓";
const ICON_ERROR = "✗";

/** Aggregates a contiguous burst of navigation tool calls into one summary line
 * (`✓ Explored 3 files · 1 search`). Children render only when expanded; a child
 * that errors auto-expands. No gutter — the state icon carries the framing. */
export class NavGroupComponent extends Container {
	private ui: TUI;
	private execs: ToolExecutionComponent[] = [];
	private expanded = false;
	private spinnerGlyph: string | null = null;

	constructor(ui: TUI) {
		super();
		this.ui = ui;
		createSpinnerTicker(
			ui,
			() => this.aggregateState() === "pending",
			(g) => {
				this.spinnerGlyph = g;
				this.ui.requestRender();
			},
		);
	}

	addCall(exec: ToolExecutionComponent): void {
		exec.setActivityChild(true);
		this.execs.push(exec);
		this.ui.requestRender();
	}

	/** Duck-typed Expandable (interactive-mode's ctrl+o loop). */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const e of this.execs) e.setExpanded(expanded);
	}

	private aggregateState(): GroupState {
		let anyPending = false;
		let anyError = false;
		for (const e of this.execs) {
			const s = e.getActivityState();
			if (s === "pending") anyPending = true;
			else if (s === "error" && !e.isAborted()) anyError = true;
		}
		return anyPending ? "pending" : anyError ? "error" : "success";
	}

	private icon(state: GroupState): string {
		if (state === "pending") return theme.fg("gutterToolPending", this.spinnerGlyph ?? SPINNER_FRAMES[0]);
		if (state === "error") return theme.fg("gutterToolError", ICON_ERROR);
		return theme.fg("gutterToolSuccess", ICON_SUCCESS);
	}

	private counts(): string {
		const byNoun = new Map<string, number>();
		for (const e of this.execs) {
			const noun = navNounFor(e.getToolName());
			byNoun.set(noun, (byNoun.get(noun) ?? 0) + 1);
		}
		const parts: string[] = [];
		for (const [noun, n] of byNoun) parts.push(`${n} ${pluralizeNoun(noun, n)}`);
		return parts.join(" · ");
	}

	private header(state: GroupState): string {
		const verb = state === "pending" ? "Exploring" : "Explored";
		return `${this.icon(state)} ${theme.bold(verb)} ${theme.fg("toolOutput", this.counts())}`;
	}

	override render(width: number): string[] {
		if (this.execs.length === 0) return [];
		const state = this.aggregateState();
		const lines = [this.header(state)];
		if (this.expanded) {
			for (const e of this.execs) {
				for (const l of e.render(width - 2)) lines.push(`  ${l}`);
			}
		} else if (state === "error") {
			// Auto-expand only genuinely failed child(ren); aborts and successes
			// stay collapsed in the counter.
			for (const e of this.execs) {
				if (e.getActivityState() !== "error" || e.isAborted()) continue;
				e.setExpanded(true);
				for (const l of e.render(width - 2)) lines.push(`  ${l}`);
			}
		}
		return lines;
	}
}
