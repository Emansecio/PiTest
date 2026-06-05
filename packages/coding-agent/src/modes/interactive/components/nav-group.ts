import { Container, SPINNER_FRAMES, type TUI } from "@pit/tui";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { ColorEase } from "./color-ease.ts";
import { createSpinnerTicker, type SpinnerTicker } from "./spinner-ticker.ts";
import { nounFor, pluralizeNoun } from "./tool-activity.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

type GroupState = "pending" | "success" | "error";

const ICON_SUCCESS = "✔︎"; // heavy check, text presentation
const ICON_ERROR = "✗";

/** Aggregates a contiguous burst of NAVIGATION tool calls into one summary line
 * (`✔ Explored 3 files · 1 search`). Actions get their own ActivityLine instead.
 * Children render only when expanded; a child that errors auto-expands. No
 * gutter — the state icon carries the framing. */
export class NavGroupComponent extends Container {
	private ui: TUI;
	private execs: ToolExecutionComponent[] = [];
	private expanded = false;
	private spinnerGlyph: string | null = null;
	// Counters depend only on the group's composition (tool names), so cache the
	// rendered string and rebuild it lazily on addCall instead of every frame.
	private countsCache: string | null = null;
	private ticker: SpinnerTicker | null = null;
	private prevState: GroupState | null = null;
	private readonly iconEase: ColorEase;
	// Brief brighten of the counter each time a call is folded in (live increment).
	private readonly countEase: ColorEase;

	constructor(ui: TUI) {
		super();
		this.ui = ui;
		this.iconEase = new ColorEase(ui, () => this.ui.requestRender());
		this.countEase = new ColorEase(ui, () => this.ui.requestRender());
	}

	/** Run the spinner ticker only while there is pending work. It self-stops on
	 * resolve (onFrame null), so a finished group in history costs no per-frame
	 * aggregateState scan; addCall re-arms it when a new pending call arrives. */
	private ensureTicker(): void {
		if (this.ticker) return;
		this.ticker = createSpinnerTicker(
			this.ui,
			() => this.aggregateState() === "pending",
			(g) => {
				this.spinnerGlyph = g;
				if (g === null) {
					this.ticker?.stop();
					this.ticker = null;
				}
				this.ui.requestRender();
			},
		);
	}

	addCall(exec: ToolExecutionComponent): void {
		exec.setActivityChild(true);
		this.execs.push(exec);
		this.countsCache = null;
		// Brighten the counter from full-bright back to its steady muted tone so a
		// freshly-folded call reads as motion without a layout shift.
		this.countEase.begin("text", "toolOutput");
		if (this.aggregateState() === "pending") this.ensureTicker();
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
		const glyph = state === "error" ? ICON_ERROR : ICON_SUCCESS;
		const steady: ThemeColor = state === "error" ? "gutterToolError" : "gutterToolSuccess";
		return this.iconEase.colorize(steady, glyph);
	}

	private counts(): string {
		if (this.countsCache !== null) return this.countsCache;
		const byNoun = new Map<string, number>();
		for (const e of this.execs) {
			const noun = nounFor(e.getToolName());
			byNoun.set(noun, (byNoun.get(noun) ?? 0) + 1);
		}
		const parts: string[] = [];
		for (const [noun, n] of byNoun) parts.push(`${n} ${pluralizeNoun(noun, n)}`);
		this.countsCache = parts.join(" · ");
		return this.countsCache;
	}

	private header(state: GroupState): string {
		const verb = state === "pending" ? "Exploring" : "Explored";
		return `${this.icon(state)} ${theme.bold(verb)} ${this.countEase.colorize("toolOutput", this.counts())}`;
	}

	override render(width: number): string[] {
		if (this.execs.length === 0) return [];
		const state = this.aggregateState();
		// Ease the state icon on settle (pending → ✔/✗), mirroring ActivityLine.
		if (state !== this.prevState) {
			if (state !== "pending") {
				const from: ThemeColor = this.prevState === "pending" ? "gutterToolPending" : "dim";
				const to: ThemeColor = state === "error" ? "gutterToolError" : "gutterToolSuccess";
				this.iconEase.begin(from, to);
			}
			this.prevState = state;
		}
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
