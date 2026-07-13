import { Container, SPINNER_FRAMES, type TUI, truncateToWidth } from "@pit/tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { clampBashCommandRow } from "./bash-command-row.ts";
import { ColorEase } from "./color-ease.ts";
import { createSpinnerTicker, type SpinnerTicker } from "./spinner-ticker.ts";
import { glyphFor, pluralizeNoun, verbFor } from "./tool-activity.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

type GroupState = "pending" | "success" | "error";

const ICON_SUCCESS = "✓";
const ICON_ERROR = "✗";

/** Aggregates a contiguous burst of `bash` tool calls into one summary line
 * (`✓ $ Ran 3 commands`). A single command still shows its shortened target.
 * Children render only when expanded; a child that errors auto-expands. */
export class BashGroupComponent extends Container {
	private ui: TUI;
	private execs: ToolExecutionComponent[] = [];
	private expanded = false;
	private spinnerGlyph: string | null = null;
	private lastSpinnerGlyph: string | null = null;
	private stateCache: GroupState | null = null;
	private linesCache: string[] | null = null;
	private linesCacheKey = "";
	private ticker: SpinnerTicker | null = null;
	private prevState: GroupState | null = null;
	private readonly iconEase: ColorEase;
	private readonly countEase: ColorEase;

	constructor(ui: TUI) {
		super();
		this.ui = ui;
		this.iconEase = new ColorEase(ui, () => this.ui.requestRender());
		this.countEase = new ColorEase(ui, () => this.ui.requestRender());
	}

	addCall(exec: ToolExecutionComponent): void {
		exec.setActivityChild(true);
		this.execs.push(exec);
		this.stateCache = null;
		this.linesCache = null;
		this.countEase.begin("text", "toolOutput");
		if (this.aggregateState() === "pending") {
			this.ensureTicker();
		}
		this.ui.requestRender();
	}

	dispose(): void {
		this.ticker?.stop();
		this.ticker = null;
		this.iconEase.stop();
		this.countEase.stop();
		for (const e of this.execs) e.dispose();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.linesCache = null;
		for (const e of this.execs) e.setExpanded(expanded);
	}

	override invalidate(): void {
		super.invalidate();
		this.stateCache = null;
		this.linesCache = null;
		for (const e of this.execs) e.invalidate();
	}

	private ensureTicker(): void {
		if (this.ticker) return;
		this.ticker = createSpinnerTicker(
			this.ui,
			() => this.pendingFlagForTicker(),
			(g) => {
				this.spinnerGlyph = g;
				if (g !== null) this.lastSpinnerGlyph = g;
				if (g === null) {
					this.ticker?.stop();
					this.ticker = null;
				}
			},
		);
	}

	private pendingFlagForTicker(): boolean {
		for (const e of this.execs) {
			if (e.getActivityState() === "pending") return true;
		}
		return false;
	}

	private aggregateState(): GroupState {
		if (this.stateCache !== null) return this.stateCache;
		let anyPending = false;
		let anyError = false;
		for (const e of this.execs) {
			const s = e.getActivityState();
			if (s === "pending") anyPending = true;
			else if (s === "error" && !e.isAborted()) anyError = true;
		}
		const state: GroupState = anyPending ? "pending" : anyError ? "error" : "success";
		if (state !== "pending" && this.ticker === null) this.stateCache = state;
		return state;
	}

	private icon(state: GroupState): string {
		if (state === "pending") return theme.fg("gutterToolPending", this.spinnerGlyph ?? SPINNER_FRAMES[0]);
		const glyph = state === "error" ? ICON_ERROR : ICON_SUCCESS;
		const steady: ThemeColor = state === "error" ? "gutterToolError" : "gutterToolSuccess";
		if (this.iconEase.active && this.iconEase.progress < 0.5) {
			return this.iconEase.colorize(steady, this.lastSpinnerGlyph ?? SPINNER_FRAMES[0]);
		}
		return this.iconEase.colorize(steady, glyph);
	}

	private commandText(exec: ToolExecutionComponent, width: number): string {
		const args = exec.getArgs() ?? {};
		return clampBashCommandRow({
			command: String(args.command ?? ""),
			width: Math.max(0, width),
			colorKey: "toolTitle",
			prefix: false,
			elideCd: true,
			stripEcho: true,
			suppressExpandHint: true,
		});
	}

	private pendingExec(): ToolExecutionComponent | null {
		for (const e of this.execs) {
			if (e.getActivityState() === "pending") return e;
		}
		return null;
	}

	private summary(state: GroupState, width: number): string {
		const n = this.execs.length;
		const pending = state === "pending";
		const verb = verbFor("bash", pending);
		if (n === 1) {
			const target = this.commandText(this.execs[0]!, width);
			return `${this.icon(state)} ${glyphFor("bash")} ${theme.bold(verb)} ${target}`;
		}
		const noun = pluralizeNoun("command", n);
		const counter = this.countEase.colorize("toolOutput", `${n} ${noun}`);
		return `${this.icon(state)} ${glyphFor("bash")} ${theme.bold(verb)} ${counter}`;
	}

	private pendingSuffix(state: GroupState, width: number): string {
		if (state !== "pending" || this.execs.length <= 1) return "";
		const exec = this.pendingExec();
		if (!exec) return "";
		const target = this.commandText(exec, width);
		if (!stripAnsi(target).trim()) return "";
		return ` ${theme.fg("muted", `— ${target}`)}`;
	}

	override render(width: number): string[] {
		if (this.execs.length === 0) return [];
		const state = this.aggregateState();
		if (state !== this.prevState) {
			if (state !== "pending") {
				const from: ThemeColor = this.prevState === "pending" ? "gutterToolPending" : "dim";
				const to: ThemeColor = state === "error" ? "gutterToolError" : "gutterToolSuccess";
				this.iconEase.begin(from, to);
			}
			this.prevState = state;
		}
		const cacheable = state === "success" && !this.expanded && !this.iconEase.active && !this.countEase.active;
		const cacheKey = `${width}|${state}|${this.execs.length}|${this.expanded}`;
		if (cacheable && this.linesCache !== null && this.linesCacheKey === cacheKey) {
			return this.linesCache;
		}
		const prefixCells = stripAnsi(
			`${this.icon(state)} ${glyphFor("bash")} ${verbFor("bash", state === "pending")} `,
		).length;
		const summaryBudget = Math.max(0, width - prefixCells);
		const header = truncateToWidth(
			`${this.summary(state, summaryBudget)}${this.pendingSuffix(state, summaryBudget)}`,
			width,
		);
		const lines = [header];
		if (this.expanded) {
			for (const e of this.execs) {
				for (const l of e.render(width - 2)) lines.push(`  ${l}`);
			}
		}
		if (cacheable) {
			this.linesCache = lines;
			this.linesCacheKey = cacheKey;
		} else {
			this.linesCache = null;
		}
		return lines;
	}
}
