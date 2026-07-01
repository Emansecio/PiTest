import { Container, SPINNER_FRAMES, type TUI, truncateToWidth } from "@pit/tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { truncateWithEllipsis } from "../../../utils/surrogate.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { clampBashCommandRow } from "./bash-command-row.ts";
import { ColorEase } from "./color-ease.ts";
import { createSpinnerTicker, type SpinnerTicker } from "./spinner-ticker.ts";
import {
	capDiffPreview,
	capErrorPreview,
	diffStat,
	EDIT_EXPANDED_MAX_LINES,
	EDIT_SUCCESS_PREVIEW_LINES,
	glyphFor,
	hasEditDiff,
	isEditFamilyTool,
	verbFor,
} from "./tool-activity.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

/** Max width of a derived agent label (from the task prompt). */
const TASK_LABEL_MAX = 40;
const SLOW_ACTION_ELAPSED_SEC = 4;

type LineState = "pending" | "success" | "error";

const ICON_SUCCESS = "✓"; // light check (U+2713), renders 1 cell — consistent with the rest of the UI
const ICON_ERROR = "✗";

/** One action call on its own verb-led line. No gutter — the state icon frames
 * it. The wrapped exec renders only when expanded or on a genuine error.
 * Sibling of NavGroupComponent. */
export class ActivityLineComponent extends Container {
	private ui: TUI;
	private exec!: ToolExecutionComponent;
	private expanded = false;
	private spinnerGlyph: string | null = null;
	// Last non-null spinner frame, kept after the ticker stops so the settle
	// crossfade can hold the glyph through the first half of the icon ease.
	private lastSpinnerGlyph: string | null = null;
	private ticker: SpinnerTicker | null = null;
	private prevState: LineState | null = null;
	private readonly iconEase: ColorEase;
	private targetCache: string | null = null;
	private targetCacheKey = "";
	// Assembled-output memo for the settled, collapsed header line. Rebuilding
	// the header (stripAnsi + theme.bold + truncateToWidth) every frame
	// dominates the steady-state cost of a long activity stack; once a line has
	// settled its bytes only change with width. The cache is NEVER served while
	// an animation is live — pending (spinner ticking), the icon ease in
	// flight, or any body render (expanded / auto-shown error, whose exec
	// children may animate or stream) always recompute.
	private linesCache: string[] | null = null;
	private linesCacheKey = "";
	private liveEditBodyCache: string[] | null = null;
	private liveEditBodyKey = "";
	// Sequence number for an unnamed `task` agent (assigned by ActivityStacker,
	// per turn). 0 = not a task / unassigned.
	private taskOrdinal = 0;
	// Count of identical consecutive actions folded into this one line. >1 renders
	// a muted `×N` suffix (e.g. `Updated todos ×4`) instead of stacking N rows.
	private count = 1;
	// Accumulated diffstat across coalesced edits to the same target.
	private statAdded = 0;
	private statRemoved = 0;
	private execStartedAtMs = 0;

	constructor(ui: TUI) {
		super();
		this.ui = ui;
		this.iconEase = new ColorEase(ui, () => this.ui.requestRender());
	}

	setExec(exec: ToolExecutionComponent, taskOrdinal = 0): void {
		this.exec = exec;
		this.taskOrdinal = taskOrdinal;
		this.execStartedAtMs = Date.now();
		this.linesCache = null;
		this.liveEditBodyCache = null;
		this.targetCache = null;
		this.statAdded = 0;
		this.statRemoved = 0;
		this.absorbDiffStat(exec);
		exec.setActivityChild(true);
		if (exec.getActivityState() === "pending") this.ensureTicker();
		this.ui.requestRender();
	}

	private absorbDiffStat(exec: ToolExecutionComponent): void {
		const { added, removed } = diffStat(exec.getResultDetails()?.diff);
		this.statAdded += added;
		this.statRemoved += removed;
	}

	/** Live diffstat for a single action; accumulated totals when coalesced (×N). */
	private editDiffStat(): { added: number; removed: number } {
		if (this.count > 1) {
			return { added: this.statAdded, removed: this.statRemoved };
		}
		return diffStat(this.exec.getResultDetails()?.diff);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.linesCache = null;
		this.exec?.setExpanded(expanded);
	}

	/** Fold an identical repeated action into this line: bump the `×N` counter and
	 * adopt the newest exec so the line's state/spinner/target track the latest
	 * call (the earlier identical call has already settled). Used by ActivityStacker
	 * for consecutive same-target actions so they collapse to one row. */
	coalesce(exec: ToolExecutionComponent): void {
		this.count += 1;
		this.execStartedAtMs = Date.now();
		this.absorbDiffStat(exec);
		this.linesCache = null;
		this.targetCache = null;
		this.exec = exec;
		exec.setActivityChild(true);
		if (exec.getActivityState() === "pending") this.ensureTicker();
		this.ui.requestRender();
	}

	/** Stop every animation this line owns — its spinner ticker, the icon ease,
	 * and the wrapped exec's own callbacks — when the line is discarded while
	 * still pending (history rebuild / compaction clear). Without this the ticker
	 * keeps polling the exec's state on the loop forever. Idempotent. */
	dispose(): void {
		this.ticker?.stop();
		this.ticker = null;
		this.iconEase.stop();
		this.exec?.dispose();
	}

	override invalidate(): void {
		super.invalidate();
		// Theme change / forced re-render: drop both memos (they hold colored
		// bytes) and let the wrapped exec rebuild too — it is rendered directly,
		// not as a Container child, so super.invalidate() does not reach it.
		this.linesCache = null;
		this.targetCache = null;
		this.exec?.invalidate();
	}

	private ensureTicker(): void {
		if (this.ticker) return;
		this.ticker = createSpinnerTicker(
			this.ui,
			() => this.exec.getActivityState() === "pending",
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

	private state(): LineState {
		const s = this.exec.getActivityState();
		if (s === "pending") return "pending";
		if (s === "error" && !this.exec.isAborted()) return "error";
		return "success";
	}

	private icon(state: LineState): string {
		// All state glyphs (spinner, ✓, ✗) render a single cell, matching the width
		// model — so the header's single space shows cleanly and the label never
		// shifts column when the spinner settles.
		if (state === "pending") return theme.fg("gutterToolPending", this.spinnerGlyph ?? SPINNER_FRAMES[0]);
		const glyph = state === "error" ? ICON_ERROR : ICON_SUCCESS;
		const steady: ThemeColor = state === "error" ? "gutterToolError" : "gutterToolSuccess";
		// Crossfade on settle: hold the last spinner frame through the first half of
		// the color ease, then hand off to ✓/✗ — the glyph eases into the check
		// instead of snapping. Reduced-motion skips the ease, so this is a no-op there.
		if (this.iconEase.active && this.iconEase.progress < 0.5) {
			return this.iconEase.colorize(steady, this.lastSpinnerGlyph ?? SPINNER_FRAMES[0]);
		}
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
				// The row already carries the `$` family glyph + "Ran" verb, so drop the
				// redundant `$ ` sigil and elide the `cd …/dir &&` boilerplate; the
				// verbatim command stays available on expand.
				prefix: false,
				elideCd: true,
			});
		}
		if (name === "web_search") {
			return theme.fg("toolTitle", String(args.query ?? ""));
		}
		// edit / write / ast_edit / edit_v2 and unknown action tools
		const path = String(args.path ?? args.file_path ?? "");
		let line = theme.fg("toolTitle", path);
		const { added, removed } = this.editDiffStat();
		if (added || removed) {
			// Show only the non-zero side(s): `+12` for a write, `-3` for a deletion,
			// `+12 -3` for a real edit — no noisy `+0`/`-0` filler.
			const stat: string[] = [];
			if (added) stat.push(theme.fg("gutterToolSuccess", `+${added}`));
			if (removed) stat.push(theme.fg("gutterToolError", `-${removed}`));
			line += ` ${stat.join(" ")}`;
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
		if (prompt) return truncateWithEllipsis(prompt, TASK_LABEL_MAX);
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
		const name = this.exec.getToolName();
		const pending = state === "pending";
		const autoError = !this.expanded && state === "error" && !this.exec.isAborted();
		const editFamily = isEditFamilyTool(name);
		const autoEditPreview =
			!this.expanded && state === "success" && editFamily && hasEditDiff(this.exec.getResultDetails());
		const liveEditPreview = pending && editFamily;
		const showEditBody = autoEditPreview || liveEditPreview;
		// Serve the memo only on the settled, collapsed, animation-free path:
		// pending (spinner live), an in-flight icon ease, and the body renders
		// (expanded / auto error / edit preview) must keep recomputing every frame.
		const cacheable = !pending && !this.expanded && !autoError && !showEditBody && !this.iconEase.active;
		const cacheKey = `${width}|${state}|${this.count}|${this.statAdded}|${this.statRemoved}`;
		if (cacheable && this.linesCache !== null && this.linesCacheKey === cacheKey) {
			return this.linesCache;
		}
		let label: string;
		let target: string;
		if (name === "task") {
			// Mark a sub-agent explicitly: a "Delegating/Delegated" verb in the header
			// makes the task line read as an agent, not a plain tool. The agent's own
			// label (delegated name / prompt snippet / "Agent N") rides in the target.
			label = pending ? "Delegating" : "Delegated";
			target = theme.fg("toolTitle", this.taskLabel());
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
		// `<state-icon> <type-glyph> <verb> <target>`: the state icon shows
		// pending/ok/error, the type glyph (✎ $ ⌕ ▸ ◆) lets edit/run/search/read be
		// told apart at a glance. Both render a single cell.
		const glyph = glyphFor(name);
		// `×N` when identical actions were folded in; muted so it reads as a counter.
		const countSuffix = this.count > 1 ? ` ${theme.fg("muted", `×${this.count}`)}` : "";
		const rawHeader = stripAnsi(target).trim()
			? `${this.icon(state)} ${glyph} ${theme.bold(label)} ${target}${countSuffix}`
			: `${this.icon(state)} ${glyph} ${theme.bold(label)}${countSuffix}`;
		let headerText = rawHeader;
		if (pending) {
			const elapsedSec = Math.floor((Date.now() - this.execStartedAtMs) / 1000);
			if (elapsedSec >= SLOW_ACTION_ELAPSED_SEC) {
				headerText += ` ${theme.fg("muted", `· ${elapsedSec}s`)}`;
			}
		}
		// Cap the assembled header once so no branch (free-form agent label, MCP tool
		// name, web_search query, edit path) can overflow the terminal width. ANSI is
		// width-free here, so the colorized header is clamped to `width` cells; the
		// reticência is U+2026 (truncateToWidth's default).
		const header = truncateToWidth(headerText, width);
		const bodyWidth = width - 2;
		const lines = [header];
		if (this.expanded) {
			const bodyLines = this.exec.render(bodyWidth);
			const capped = editFamily ? capDiffPreview(bodyLines, bodyWidth, EDIT_EXPANDED_MAX_LINES) : bodyLines;
			for (const l of capped) lines.push(`  ${l}`);
		} else if (autoError) {
			// Auto-shown error: render the full error body but cap the visible
			// lines so a failure never floods the CLI — the rest is one ctrl+o away.
			this.exec.setResultExpanded?.(true);
			for (const l of capErrorPreview(this.exec.render(bodyWidth), bodyWidth)) lines.push(`  ${l}`);
		} else if (autoEditPreview) {
			this.exec.setResultExpanded?.(true);
			for (const l of capDiffPreview(this.exec.render(bodyWidth), bodyWidth, EDIT_SUCCESS_PREVIEW_LINES)) {
				lines.push(`  ${l}`);
			}
		} else if (liveEditPreview) {
			const bodyKey = `${this.exec.getActivityState()}|${String(this.exec.getArgs()?.path ?? "")}|${String(this.exec.getResultDetails() ?? "")}`;
			if (this.liveEditBodyCache === null || this.liveEditBodyKey !== bodyKey) {
				this.liveEditBodyCache = this.exec.render(bodyWidth);
				this.liveEditBodyKey = bodyKey;
			}
			for (const l of this.liveEditBodyCache) lines.push(`  ${l}`);
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
