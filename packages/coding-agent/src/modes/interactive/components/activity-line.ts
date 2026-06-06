import { Container, SPINNER_FRAMES, type TUI } from "@pit/tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { clampBashCommandRow } from "./bash-command-row.ts";
import { ColorEase } from "./color-ease.ts";
import { createSpinnerTicker, type SpinnerTicker } from "./spinner-ticker.ts";
import { diffStat, verbFor } from "./tool-activity.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

/** Max width of a derived agent label (from the task prompt). */
const TASK_LABEL_MAX = 40;

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
	// Sequence number for an unnamed `task` agent (assigned by ActivityStacker,
	// per turn). 0 = not a task / unassigned.
	private taskOrdinal = 0;

	constructor(ui: TUI) {
		super();
		this.ui = ui;
		this.iconEase = new ColorEase(ui, () => this.ui.requestRender());
	}

	setExec(exec: ToolExecutionComponent, taskOrdinal = 0): void {
		this.exec = exec;
		this.taskOrdinal = taskOrdinal;
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
		// Uniform 2-cell icon slot. ICON_SUCCESS (✔︎) renders 2 cells in emoji-
		// presentation terminals, while the spinner and ✗ render 1 — pad the narrow
		// glyphs with a trailing space so the icon slot is a consistent width. This
		// keeps a visible gap before the label and stops the label from shifting a
		// column when the spinner settles into ✔/✗.
		if (state === "pending") return `${theme.fg("gutterToolPending", this.spinnerGlyph ?? SPINNER_FRAMES[0])} `;
		const glyph = state === "error" ? ICON_ERROR : ICON_SUCCESS;
		const steady: ThemeColor = state === "error" ? "gutterToolError" : "gutterToolSuccess";
		// Trailing space on every state. With the header's own space that yields two
		// columns after the glyph, so the wide ✔︎ (drawn 2 cells while the width model
		// counts 1) still leaves one visible space before the label.
		return `${this.iconEase.colorize(steady, glyph)} `;
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

	/** Display label for a `task` agent: the delegated `name`, else a short prompt
	 * snippet, else a per-turn "Agent N". */
	private taskLabel(): string {
		const args = this.exec.getArgs() ?? {};
		const name = typeof args.name === "string" ? args.name.trim() : "";
		if (name) return name;
		const prompt = typeof args.prompt === "string" ? args.prompt.trim().replace(/\s+/g, " ") : "";
		if (prompt) return prompt.length > TASK_LABEL_MAX ? `${prompt.slice(0, TASK_LABEL_MAX - 1)}…` : prompt;
		return `Agent ${this.taskOrdinal || 1}`;
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
		const name = this.exec.getToolName();
		let label: string;
		let target: string;
		if (name === "task") {
			label = this.taskLabel();
			target = "";
		} else {
			label = verbFor(name, pending);
			target = this.target(width);
			// Unknown/MCP action with no extractable target → use the tool name as
			// the label instead of a bare fallback verb ("Ran") with nothing after it.
			if (label === verbFor("", pending) && name !== "bash" && !stripAnsi(target).trim()) {
				label = name;
				target = "";
			}
		}
		const header = stripAnsi(target).trim()
			? `${this.icon(state)} ${theme.bold(label)} ${target}`
			: `${this.icon(state)} ${theme.bold(label)}`;
		const lines = [header];
		const showBody = this.expanded || (state === "error" && !this.exec.isAborted());
		if (showBody) {
			if (state === "error") this.exec.setExpanded(true);
			for (const l of this.exec.render(width - 2)) lines.push(`  ${l}`);
		}
		return lines;
	}
}
