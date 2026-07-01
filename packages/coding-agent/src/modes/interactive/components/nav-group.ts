import { basename } from "node:path";
import { Container, SPINNER_FRAMES, type TUI, truncateToWidth } from "@pit/tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { truncateWithEllipsis } from "../../../utils/surrogate.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { ColorEase } from "./color-ease.ts";
import { createSpinnerTicker, type SpinnerTicker } from "./spinner-ticker.ts";
import { capErrorPreview, nounFor, pluralizeNoun } from "./tool-activity.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

type GroupState = "pending" | "success" | "error";

const ICON_SUCCESS = "✓"; // light check (U+2713), renders 1 cell — consistent with the rest of the UI
const ICON_ERROR = "✗";

/** Up to this many calls, a pure file-read group lists basenames inline
 * (`config.ts · theme.ts`) instead of collapsing to a `N files` counter — the
 * identity of a handful of reads is more useful than their count. */
const BASENAME_LIST_MAX = 4;

/** Aggregates a contiguous burst of NAVIGATION tool calls into one summary line
 * (`✔ Explored 3 files · 1 search`). Actions get their own ActivityLine instead.
 * Children render only when expanded; a child that errors auto-expands. No
 * gutter — the state icon carries the framing. */
export class NavGroupComponent extends Container {
	private ui: TUI;
	private execs: ToolExecutionComponent[] = [];
	private expanded = false;
	private spinnerGlyph: string | null = null;
	// Last non-null spinner frame, kept after the ticker stops so the settle
	// crossfade can hold the glyph through the first half of the icon ease.
	private lastSpinnerGlyph: string | null = null;
	// Counters depend only on the group's composition (tool names), so cache the
	// rendered string and rebuild it lazily on addCall instead of every frame.
	private countsCache: string | null = null;
	// Frozen aggregate state. Once every exec has settled (non-pending) the
	// group can never go back to pending without addCall — exec states are
	// terminal — so the O(execs) scan is computed once and reused. Never frozen
	// while pending or while the ticker is still live (its check fn polls
	// aggregateState each tick and must see fresh values until it self-stops).
	private stateCache: GroupState | null = null;
	// Assembled-output memo for the settled, collapsed, success header line —
	// same pattern as ActivityLineComponent. Rebuilding header + summary +
	// truncateToWidth every frame dominates the steady-state cost of resolved
	// groups in history. NEVER served while an animation is live: pending
	// (spinner ticking), the icon ease in flight, the counter ease in flight, or
	// any body render (expanded / auto-shown error children may animate or
	// stream) always recompute.
	private linesCache: string[] | null = null;
	private linesCacheKey = "";
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

	addCall(exec: ToolExecutionComponent): void {
		exec.setActivityChild(true);
		this.execs.push(exec);
		this.countsCache = null;
		this.stateCache = null;
		this.linesCache = null;
		// Brighten the counter from full-bright back to its steady muted tone so a
		// freshly-folded call reads as motion without a layout shift.
		this.countEase.begin("text", "toolOutput");
		if (this.aggregateState() === "pending") this.ensureTicker();
		this.ui.requestRender();
	}

	/** Stop every animation this group owns — its spinner ticker, the icon/counter
	 * eases, and every wrapped exec's own callbacks — when the group is discarded
	 * while still pending (history rebuild / compaction clear). Without this the
	 * ticker keeps polling aggregateState() on the loop forever. Idempotent. */
	dispose(): void {
		this.ticker?.stop();
		this.ticker = null;
		this.iconEase.stop();
		this.countEase.stop();
		for (const e of this.execs) e.dispose();
	}

	/** Duck-typed Expandable (interactive-mode's ctrl+o loop). */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.linesCache = null;
		for (const e of this.execs) e.setExpanded(expanded);
	}

	override invalidate(): void {
		super.invalidate();
		// Theme change / forced re-render: drop every memo holding colored bytes
		// and let the wrapped execs rebuild too — they are rendered directly, not
		// as Container children, so super.invalidate() does not reach them.
		this.countsCache = null;
		this.stateCache = null;
		this.linesCache = null;
		for (const e of this.execs) e.invalidate();
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
		// Freeze only once settled AND the ticker has self-stopped: exec states
		// are terminal, and addCall/invalidate clear the freeze.
		if (state !== "pending" && this.ticker === null) this.stateCache = state;
		return state;
	}

	private icon(state: GroupState): string {
		// All state glyphs (spinner, ✓, ✗) render a single cell, matching the width
		// model — so the header's single space shows cleanly and the label never
		// shifts column when the spinner settles.
		if (state === "pending") return theme.fg("gutterToolPending", this.spinnerGlyph ?? SPINNER_FRAMES[0]);
		const glyph = state === "error" ? ICON_ERROR : ICON_SUCCESS;
		const steady: ThemeColor = state === "error" ? "gutterToolError" : "gutterToolSuccess";
		// Crossfade on settle: hold the last spinner frame through the first half of
		// the color ease, then hand off to the check/cross glyph instead of snapping.
		// No-op under reduced-motion (the ease never starts).
		if (this.iconEase.active && this.iconEase.progress < 0.5) {
			return this.iconEase.colorize(steady, this.lastSpinnerGlyph ?? SPINNER_FRAMES[0]);
		}
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

	/** Basenames of a small, pure file-read group (`config.ts · theme.ts`), or
	 * `null` when the group is large, mixed, or any read lacks a usable path —
	 * the caller then falls back to the `N files` counter. */
	private fileBasenames(): string[] | null {
		if (this.execs.length === 0 || this.execs.length > BASENAME_LIST_MAX) return null;
		const names: string[] = [];
		for (const e of this.execs) {
			if (e.getToolName() !== "read") return null;
			const args = e.getArgs() ?? {};
			const raw = typeof args.file_path === "string" ? args.file_path : "";
			const name = basename(raw.replace(/[\\/]+$/, ""));
			if (!name) return null;
			names.push(name);
		}
		return names;
	}

	private summary(width: number): string {
		const names = this.fileBasenames();
		if (!names) return this.countEase.colorize("toolOutput", this.counts());
		// Width-clamp the inline list so a handful of long paths can't overflow the
		// terminal; the reticência is U+2026 (truncateToWidth's default).
		const list = truncateToWidth(names.join(" · "), Math.max(0, width));
		return this.countEase.colorize("toolOutput", list);
	}

	private pendingTargetLabel(): string | null {
		for (const e of this.execs) {
			if (e.getActivityState() !== "pending") continue;
			const name = e.getToolName();
			const args = (e.getArgs() ?? {}) as Record<string, unknown>;
			if (name === "read") {
				const raw = typeof args.file_path === "string" ? args.file_path : "";
				const nameOnly = basename(raw.replace(/[\\/]+$/, ""));
				if (nameOnly) return nameOnly;
			}
			if (name === "grep" || name === "find" || name === "ast_grep") {
				const pat = typeof args.pattern === "string" ? args.pattern : "";
				if (pat) return truncateWithEllipsis(pat, 32);
			}
			return name;
		}
		return null;
	}

	private header(state: GroupState, width: number): string {
		const verb = state === "pending" ? "Exploring" : "Explored";
		const prefix = `${this.icon(state)} ${theme.bold(verb)} `;
		let pendingSuffix = "";
		let summaryBudget = Math.max(0, width);
		if (state === "pending") {
			const pending = this.pendingTargetLabel();
			if (pending) {
				pendingSuffix = theme.fg("muted", ` — ${pending}`);
				summaryBudget = Math.max(0, summaryBudget - stripAnsi(pendingSuffix).length);
			}
		}
		// Budget the summary against the space the icon + verb + two spaces consume,
		// so the basename list truncates to the remaining cells rather than the full
		// width. ANSI in the prefix is width-free, so measure the visible verb only.
		const prefixCells = stripAnsi(prefix).length;
		summaryBudget = Math.max(0, summaryBudget - prefixCells);
		return `${prefix}${this.summary(summaryBudget)}${pendingSuffix}`;
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
		// Serve the memo only on the settled, collapsed, animation-free path:
		// pending (spinner live), an in-flight icon/counter ease, and the body
		// renders (expanded / auto-shown error children) keep recomputing every
		// frame. state === "error" always renders at least one child body, so only
		// the success header is ever memoized.
		const cacheable = state === "success" && !this.expanded && !this.iconEase.active && !this.countEase.active;
		const cacheKey = `${width}|${state}|${this.spinnerGlyph ?? ""}|${this.execs.length}|${this.expanded}`;
		if (cacheable && this.linesCache !== null && this.linesCacheKey === cacheKey) {
			return this.linesCache;
		}
		const lines = [this.header(state, width)];
		if (this.expanded) {
			for (const e of this.execs) {
				for (const l of e.render(width - 2)) lines.push(`  ${l}`);
			}
		} else if (state === "error") {
			// Auto-show only genuinely failed child(ren); aborts and successes
			// stay collapsed in the counter. The error body is capped so one
			// failed call cannot flood the CLI — the rest is one ctrl+o away.
			for (const e of this.execs) {
				if (e.getActivityState() !== "error" || e.isAborted()) continue;
				e.setResultExpanded(true);
				for (const l of capErrorPreview(e.render(width - 2), width - 2)) lines.push(`  ${l}`);
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
