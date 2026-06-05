import { Container, SPINNER_FRAMES, type TUI } from "@pit/tui";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { clampBashCommandRow } from "./bash-command-row.ts";
import { ColorEase } from "./color-ease.ts";
import { createSpinnerTicker, type SpinnerTicker } from "./spinner-ticker.ts";
import { diffStat, verbFor } from "./tool-activity.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

type LineState = "pending" | "success" | "error";

const ICON_SUCCESS = "✔︎"; // heavy check, text presentation
const ICON_ERROR = "✗";

/** One action call on its own verb-led line. No gutter — the state icon frames
 * it. The wrapped exec renders only when expanded or on a genuine error.
 * Sibling of NavGroupComponent. */
export class ActivityLineComponent extends Container {
	private ui: TUI;
	private exec!: ToolExecutionComponent;
	private expanded = false;
	private spinnerGlyph: string | null = null;
	private ticker: SpinnerTicker | null = null;
	private prevState: LineState | null = null;
	private readonly iconEase: ColorEase;
	private targetCache: string | null = null;
	private targetCacheKey = "";

	constructor(ui: TUI) {
		super();
		this.ui = ui;
		this.iconEase = new ColorEase(ui, () => this.ui.requestRender());
	}

	setExec(exec: ToolExecutionComponent): void {
		this.exec = exec;
		exec.setActivityChild(true);
		if (exec.getActivityState() === "pending") this.ensureTicker();
		this.ui.requestRender();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.exec?.setExpanded(expanded);
	}

	private ensureTicker(): void {
		if (this.ticker) return;
		this.ticker = createSpinnerTicker(
			this.ui,
			() => this.exec.getActivityState() === "pending",
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

	private state(): LineState {
		const s = this.exec.getActivityState();
		if (s === "pending") return "pending";
		if (s === "error" && !this.exec.isAborted()) return "error";
		return "success";
	}

	private icon(state: LineState): string {
		if (state === "pending") return theme.fg("gutterToolPending", this.spinnerGlyph ?? SPINNER_FRAMES[0]);
		const glyph = state === "error" ? ICON_ERROR : ICON_SUCCESS;
		const steady: ThemeColor = state === "error" ? "gutterToolError" : "gutterToolSuccess";
		return this.iconEase.colorize(steady, glyph);
	}

	private target(width: number): string {
		// The spinner re-renders ~12×/s while pending; cache the computed target so
		// clampBashCommandRow/diffStat don't rerun every frame. State is part of the
		// key so the diffstat (only known on completion) refreshes on settle.
		const key = `${width}|${this.state()}`;
		if (this.targetCache !== null && this.targetCacheKey === key) return this.targetCache;
		const computed = this.computeTarget(width);
		this.targetCache = computed;
		this.targetCacheKey = key;
		return computed;
	}

	private computeTarget(width: number): string {
		const name = this.exec.getToolName();
		const args = this.exec.getArgs() ?? {};
		if (name === "bash") {
			return clampBashCommandRow({
				command: String(args.command ?? ""),
				width: Math.max(0, width - 12),
				colorKey: "toolTitle",
			});
		}
		if (name === "web_search") {
			return theme.fg("toolTitle", String(args.query ?? ""));
		}
		// edit / write / ast_edit / edit_v2 and unknown action tools
		const path = String(args.path ?? args.file_path ?? "");
		let line = theme.fg("toolTitle", path);
		const { added, removed } = diffStat(this.exec.getResultDetails()?.diff);
		if (added || removed) {
			line += ` ${theme.fg("gutterToolSuccess", `+${added}`)} ${theme.fg("gutterToolError", `-${removed}`)}`;
		}
		return line;
	}

	override render(width: number): string[] {
		if (!this.exec) return [];
		const state = this.state();
		// Ease the state icon's color on settle: pending → ✔/✗ hands off from the
		// spinner gray; a line that appears already resolved (history, instant tool)
		// fades in from dim. Snaps without truecolor (see ColorEase).
		if (state !== this.prevState) {
			if (state !== "pending") {
				const from: ThemeColor = this.prevState === "pending" ? "gutterToolPending" : "dim";
				const to: ThemeColor = state === "error" ? "gutterToolError" : "gutterToolSuccess";
				this.iconEase.begin(from, to);
			}
			this.prevState = state;
		}
		const pending = state === "pending";
		const verb = verbFor(this.exec.getToolName(), pending);
		const header = `${this.icon(state)} ${theme.bold(verb)} ${this.target(width)}`;
		const lines = [header];
		const showBody = this.expanded || (state === "error" && !this.exec.isAborted());
		if (showBody) {
			if (state === "error") this.exec.setExpanded(true);
			for (const l of this.exec.render(width - 2)) lines.push(`  ${l}`);
		}
		return lines;
	}
}
