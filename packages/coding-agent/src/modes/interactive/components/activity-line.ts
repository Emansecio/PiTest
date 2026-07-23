import { Container, SPINNER_FRAMES, type TUI, truncateToWidth } from "@pit/tui";
import { formatElapsed } from "../../../core/goal/goal-manager.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { truncateWithEllipsis } from "../../../utils/surrogate.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { clampBashCommandRow } from "./bash-command-row.ts";
import { ColorEase } from "./color-ease.ts";
import { createSpinnerTicker, type SpinnerTicker } from "./spinner-ticker.ts";
import {
	activityTargetLabel,
	capDiffPreview,
	diffStat,
	EDIT_EXPANDED_MAX_LINES,
	GUTTER_DOT,
	isEditFamilyTool,
	mcpActivityTarget,
	parseMcpToolName,
	verbFor,
} from "./tool-activity.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

/** Max width of a derived agent label (from the task prompt). */
const TASK_LABEL_MAX = 40;

/** Quiet window before a pending line grows its `· Ns` elapsed suffix —
 * long enough that reads/edits never show it, short enough that a slow bash
 * or subagent gets a visible clock while the user still cares. */
const PENDING_ELAPSED_SUFFIX_AFTER_MS = 3000;

type LineState = "pending" | "success" | "error";

const ICON_SUCCESS = "✓"; // light check (U+2713), renders 1 cell — consistent with the rest of the UI
const ICON_ERROR = "✗";
const ICON_ABORTED = "◦"; // muted — user interrupt is not a failure

/** Steady color of the settled gutter dot — the existing "success" green, reused
 * as the row's fixed accent regardless of outcome (outcome moved to the trailing
 * icon). Reuses the theme's required `gutterToolSuccess` token rather than
 * `accent` (a different, cyan-branded hue elsewhere in the theme) or a new
 * optional token that could throw on a custom theme missing it. */
const GUTTER_DOT_COLOR: ThemeColor = "gutterToolSuccess";

/** One action call on its own verb-led line: a steady accent gutter dot leads
 * (a live call keeps the existing braille spinner in its place), the verb+target
 * follow, and a trailing ✓/✗/◦ reports the outcome once settled. The wrapped exec
 * renders only when expanded or on a genuine error. Used as a promoted
 * (edit/write/task/bookkeeping) row inside a WorkGroupComponent. */
export class ActivityLineComponent extends Container {
	private ui: TUI;
	private isFrozen: () => boolean;
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
	// flight, or an expanded body render (whose exec children may animate or
	// stream) always recompute.
	private linesCache: string[] | null = null;
	private linesCacheKey = "";
	// Sequence number for an unnamed `task` agent (assigned by ActivityStacker,
	// per turn). 0 = not a task / unassigned.
	private taskOrdinal = 0;
	// Count of identical actions folded into this one line. >1 renders
	// a muted `×N` suffix (e.g. `Updated todos ×4`) instead of stacking N rows.
	private count = 1;
	// Accumulated diffstat across coalesced edits to the same target.
	private statAdded = 0;
	private statRemoved = 0;
	// When the current exec went pending — drives the `· Ns` suffix that
	// separates "slow but alive" from "stuck" on long bash/task lines. The
	// spinner ticker's 1s reduced-motion tick (M0) keeps it advancing.
	private pendingSinceMs = 0;

	constructor(ui: TUI, isFrozen: () => boolean = () => false) {
		super();
		this.ui = ui;
		this.isFrozen = isFrozen;
		this.iconEase = new ColorEase(ui, () => this.ui.requestRender());
	}

	setExec(exec: ToolExecutionComponent, taskOrdinal = 0): void {
		this.exec = exec;
		this.taskOrdinal = taskOrdinal;
		this.linesCache = null;
		this.targetCache = null;
		this.statAdded = 0;
		this.statRemoved = 0;
		this.absorbDiffStat(exec);
		exec.setActivityChild(true);
		if (exec.getActivityState() === "pending") {
			this.pendingSinceMs = Date.now();
			this.ensureTicker();
		}
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
	 * for repeated same-target actions so they collapse to one row. */
	coalesce(exec: ToolExecutionComponent): void {
		this.count += 1;
		this.absorbDiffStat(exec);
		this.linesCache = null;
		this.targetCache = null;
		this.exec = exec;
		exec.setActivityChild(true);
		if (exec.getActivityState() === "pending") {
			this.pendingSinceMs = Date.now();
			this.ensureTicker();
		}
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
			this.isFrozen,
		);
	}

	private state(): LineState {
		const s = this.exec.getActivityState();
		if (s === "pending") return "pending";
		if (s === "error" && !this.exec.isAborted()) return "error";
		return "success";
	}

	/**
	 * Dim `· Ns` suffix for a pending line once it has run past the quiet
	 * window — a 90s `npm test` and a 200ms read no longer spin identically,
	 * so "slow but alive" is tellable from "stuck" without expanding anything.
	 * Fast tools stay suffix-free (no noise); the pending render path is never
	 * memo-served, and the reduced-motion 1s tick (M0) keeps the count moving.
	 */
	private pendingElapsedSuffix(): string {
		if (this.pendingSinceMs <= 0) return "";
		const elapsedMs = Date.now() - this.pendingSinceMs;
		if (elapsedMs < PENDING_ELAPSED_SUFFIX_AFTER_MS) return "";
		return ` ${theme.fg("dim", `· ${formatElapsed(elapsedMs)}`)}`;
	}

	/** Pending spinner color by tool family (bash/task stand out; others stay muted). */
	private pendingIconColor(): ThemeColor {
		const name = this.exec?.getToolName() ?? "";
		if (name === "bash") return "gutterBash";
		if (name === "task") return "gutterCustom";
		return "gutterToolPending";
	}

	/**
	 * Leading gutter glyph: the braille spinner while the call is in flight, then
	 * a steady accent dot once settled — same dot for success, error, and abort,
	 * since the outcome itself now rides on {@link trailingIcon} instead. Crossfades
	 * from the last spinner frame through the first half of the settle ease so the
	 * spinner eases into the dot instead of snapping (reduced-motion skips the ease).
	 */
	private gutter(state: LineState): string {
		if (state === "pending") return theme.fg(this.pendingIconColor(), this.spinnerGlyph ?? SPINNER_FRAMES[0]);
		if (this.iconEase.active && this.iconEase.progress < 0.5) {
			return this.iconEase.colorize(GUTTER_DOT_COLOR, this.lastSpinnerGlyph ?? SPINNER_FRAMES[0]);
		}
		return this.iconEase.colorize(GUTTER_DOT_COLOR, GUTTER_DOT);
	}

	/** Trailing outcome glyph: empty while pending (the gutter spinner already
	 * says "in flight"), muted `◦` on a user abort/interrupt (never success-green
	 * or error-red), else `✓`/`✗`. */
	private trailingIcon(state: LineState): string {
		if (state === "pending") return "";
		if (this.exec.isAborted()) return theme.fg("muted", ICON_ABORTED);
		return state === "error" ? theme.fg("gutterToolError", ICON_ERROR) : theme.fg("gutterToolSuccess", ICON_SUCCESS);
	}

	/** Verb color by lifecycle: accent while live, muted when collapsed, text when expanded. */
	private verbStyle(label: string, pending: boolean): string {
		if (pending) return theme.bold(theme.fg("accent", label));
		if (!this.expanded) return theme.bold(theme.fg("muted", label));
		return theme.bold(theme.fg("text", label));
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
				colorKey: "bashMode",
				// The row already carries the `$` family glyph + "Ran" verb, so drop the
				// redundant `$ ` sigil and elide the `cd …/dir &&` boilerplate; the
				// verbatim command stays available on expand.
				prefix: false,
				elideCd: true,
				stripEcho: true,
				suppressExpandHint: true,
			});
		}
		if (name === "web_search") {
			return theme.fg("mdLink", String(args.query ?? ""));
		}
		// edit / write / ast_edit / edit_v2 and unknown action tools — basename only
		// in the header; the full path stays in the expanded diff (ctrl+o).
		const path = activityTargetLabel(name, args) || String(args.path ?? args.file_path ?? "");
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
		// Ease the gutter dot's color on settle: pending → dot hands off from the
		// spinner gray; a line that appears already resolved (history, instant tool)
		// fades in from dim. Always eases toward the same steady dot color — the
		// outcome (✓/✗/◦) rides on the trailing icon, not this glyph. Snaps without
		// truecolor (see ColorEase).
		if (state !== this.prevState) {
			if (state !== "pending") {
				const from: ThemeColor = this.prevState === "pending" ? this.pendingIconColor() : "dim";
				this.iconEase.begin(from, GUTTER_DOT_COLOR);
			}
			this.prevState = state;
		}
		const name = this.exec.getToolName();
		const pending = state === "pending";
		const editFamily = isEditFamilyTool(name);
		// Serve the memo only on the settled, collapsed, animation-free path:
		// pending (spinner live), an in-flight icon ease, and expanded body renders
		// must keep recomputing every frame.
		const cacheable = !pending && !this.expanded && !this.iconEase.active;
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
			target = theme.fg("customMessageLabel", this.taskLabel());
		} else {
			label = verbFor(name, pending);
			target = this.target(width);
			// MCP-style names: keep Ran/Running + server/tool target instead of a bare
			// `server__tool` label that scans poorly in a long activity stack.
			if (!stripAnsi(target).trim() && parseMcpToolName(name)) {
				target = mcpActivityTarget(name);
			} else if (label === verbFor("", pending) && name !== "bash" && !stripAnsi(target).trim()) {
				// Unknown action with no extractable target → use the tool name as
				// the label instead of a bare fallback verb ("Ran") with nothing after it.
				// Capitalized so it matches the cased action verbs (Read/Edited/…).
				label = name.charAt(0).toUpperCase() + name.slice(1);
				target = "";
			}
		}
		const styledVerb = this.verbStyle(label, pending);
		// `×N` when identical actions were folded in; muted so it reads as a counter.
		const countSuffix = this.count > 1 ? ` ${theme.fg("muted", `×${this.count}`)}` : "";
		const elapsedSuffix = pending ? this.pendingElapsedSuffix() : "";
		const trailing = this.trailingIcon(state);
		const trailingSuffix = trailing ? ` ${trailing}` : "";
		const rawHeader = stripAnsi(target).trim()
			? `${this.gutter(state)} ${styledVerb} ${target}${countSuffix}${elapsedSuffix}${trailingSuffix}`
			: `${this.gutter(state)} ${styledVerb}${countSuffix}${elapsedSuffix}${trailingSuffix}`;
		const headerText = rawHeader;
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
