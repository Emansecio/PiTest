import { basename } from "node:path";
import { Container, SPINNER_FRAMES, type TUI, truncateToWidth } from "@pit/tui";
import { isTruthyEnvFlag } from "../../../utils/env-flags.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { ActivityLineComponent } from "./activity-line.ts";
import { ColorEase } from "./color-ease.ts";
import { createSpinnerTicker, type SpinnerTicker } from "./spinner-ticker.ts";
import { actionCoalesceKey, COUNTER_SEP, isEditFamilyTool, nounFor, pluralizeNoun } from "./tool-activity.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

type GroupState = "pending" | "success" | "error";
type ExpandMode = "none" | "last" | "phase";

const ICON_SUCCESS = "✓"; // light check (U+2713), 1 cell — consistent with the rest of the UI
const ICON_ERROR = "✗";

/** Action tools promoted to their OWN line inside a WorkGroup instead of folding
 * into the cross-family counter: file mutations (edit/write), delegations (task),
 * and the low-information bookkeeping rewrites (todo/plan, coalesced to `×N`).
 * Everything else — navigation, bash, and misc actions — is COUNTED in the
 * header summary (`5 searches·8 commands`). */
const PROMOTED_TOOLS = new Set(["edit", "edit_v2", "ast_edit", "write", "task", "todo", "plan"]);
const BOOKKEEPING_TOOLS = new Set(["todo", "plan"]);

/** Kill-switch (on-by-default retroactive collapse): `PIT_NO_PHASE_COLLAPSE=1` keeps
 * every sealed phase in its full live layout instead of shrinking it to a one-line
 * summary — for anyone who prefers the un-collapsed transcript. Read once at load. */
const PHASE_COLLAPSE_DISABLED = isTruthyEnvFlag(process.env.PIT_NO_PHASE_COLLAPSE);

/** Up to this many calls, a pure file-read phase lists basenames inline
 * (`config.ts·theme.ts`) instead of a `N files` counter — the identity of a
 * handful of reads is more useful than their count. */
const BASENAME_LIST_MAX = 4;

/** Max settled promoted lines shown in the live (unsealed) layout. Pending and
 * genuine-error rows always stay visible; excess settled rows fold into the header. */
const LIVE_PROMOTED_VISIBLE = 2;

/** True when a tool call earns its own promoted line rather than a tick in the
 * cross-family counter. The ActivityStacker consults this only for task ordinal
 * numbering; the WorkGroup applies the same split internally. */
export function isPromotedTool(toolName: string): boolean {
	return PROMOTED_TOOLS.has(toolName);
}

/** Collapsed-summary noun: fold the edit family + write into one `edit` bucket and
 * name a `task` an `agent`, so a sealed phase reads `3 edits·1 agent` rather than
 * the noisier `2 edits·1 file written·1 step`. Bookkeeping keeps its own noun. */
function collapseNoun(toolName: string): string {
	if (isEditFamilyTool(toolName) || toolName === "write") return "edit";
	return nounFor(toolName);
}

interface PromotedEntry {
	line: ActivityLineComponent;
	// Newest exec folded into this line — drives the entry's settled state and, in a
	// sealed collapse, whether it still surfaces as a visible error row.
	exec: ToolExecutionComponent;
	toolName: string;
	key: string | null;
	// Number of calls folded here (×N); feeds the collapsed counter's `N edits`.
	calls: number;
}

/**
 * One PHASE of background work — every tool call between two agent-text divides.
 * Folds navigation + bash + misc actions into a single dense cross-family counter
 * (`5 searches·8 commands`) and promotes high-signal calls (edits, writes, task
 * delegations, todo/plan bookkeeping) to their own line beneath it.
 *
 * Two axes of state:
 *  - `sealed` — set by the ActivityStacker on divide/reset once the phase is past.
 *    A sealed, unexpanded phase collapses to a single summary line that reabsorbs
 *    the promoted calls into the counter (`5 searches·8 commands·2 edits·1 agent`);
 *    genuine error rows stay visible so a failure never hides in the count.
 *  - `expandMode` — driven by the ctrl+o cycle (Expandable). `last` opens only the
 *    newest child body; `phase` re-expands the sealed layout and opens every child.
 *
 * Children render directly (not as Container kids), mirroring NavGroupComponent, so
 * the same cache/ease/ticker discipline applies.
 */
export class WorkGroupComponent extends Container {
	private ui: TUI;
	private isFrozen: () => boolean;
	private counted: ToolExecutionComponent[] = [];
	private promoted: PromotedEntry[] = [];
	private bookkeepingIndex = new Map<string, PromotedEntry>();
	private sealed = false;
	private expandMode: ExpandMode = "none";
	private lastExpandedEntry: PromotedEntry | ToolExecutionComponent | null = null;
	// Bumped on every addCall/coalesce so the collapsed memo keys on composition; a
	// sealed phase never mutates again, so its cache is stable.
	private version = 0;
	private spinnerGlyph: string | null = null;
	private lastSpinnerGlyph: string | null = null;
	private countsCache: string | null = null;
	private headerStateCache: GroupState | null = null;
	private linesCache: string[] | null = null;
	private linesCacheKey = "";
	private ticker: SpinnerTicker | null = null;
	private prevState: GroupState | null = null;
	private readonly iconEase: ColorEase;
	private readonly countEase: ColorEase;

	constructor(ui: TUI, isFrozen: () => boolean = () => false) {
		super();
		this.ui = ui;
		this.isFrozen = isFrozen;
		this.iconEase = new ColorEase(ui, () => this.ui.requestRender());
		this.countEase = new ColorEase(ui, () => this.ui.requestRender());
	}

	/** Route one call into the phase: counted (nav/bash/misc) folds into the header
	 * counter; a promoted tool gets/extends its own line. `taskOrdinal` numbers an
	 * unnamed `task` agent (assigned by the ActivityStacker, per turn). */
	addCall(exec: ToolExecutionComponent, taskOrdinal = 0): void {
		this.version++;
		this.linesCache = null;
		const name = exec.getToolName();
		if (!PROMOTED_TOOLS.has(name)) {
			exec.setActivityChild(true);
			this.counted.push(exec);
			this.countsCache = null;
			this.headerStateCache = null;
			this.countEase.begin("text", "toolOutput");
			if (this.headerState() === "pending") this.ensureTicker();
			this.ui.requestRender();
			return;
		}
		// Bookkeeping (todo/plan): one coalesced row per tool for the whole phase.
		if (BOOKKEEPING_TOOLS.has(name)) {
			const existing = this.bookkeepingIndex.get(name);
			if (existing) {
				existing.line.coalesce(exec);
				existing.exec = exec;
				existing.calls++;
				this.ui.requestRender();
				return;
			}
		} else {
			// Consecutive same-target edits/writes fold into the previous promoted row.
			const key = actionCoalesceKey(name, exec.getArgs());
			const last = this.promoted[this.promoted.length - 1];
			if (key !== null && last && last.key === key) {
				last.line.coalesce(exec);
				last.exec = exec;
				last.calls++;
				this.ui.requestRender();
				return;
			}
		}
		const line = new ActivityLineComponent(this.ui, this.isFrozen);
		line.setExec(exec, taskOrdinal);
		const entry: PromotedEntry = {
			line,
			exec,
			toolName: name,
			key: actionCoalesceKey(name, exec.getArgs()),
			calls: 1,
		};
		this.promoted.push(entry);
		if (BOOKKEEPING_TOOLS.has(name)) this.bookkeepingIndex.set(name, entry);
		this.ui.requestRender();
	}

	/** Seal the phase: the ActivityStacker calls this on divide/reset once the phase
	 * is past. A sealed, unexpanded phase renders as its one-line collapsed summary. */
	seal(): void {
		if (this.sealed) return;
		this.sealed = true;
		// History rows are frozen — drop in-flight settle eases so a collapsed
		// summary never sticks on a mid-ease spinner glyph (esp. when the host
		// animation ticker is paused or a test TUI never ticks callbacks).
		this.iconEase.stop();
		this.countEase.stop();
		this.ticker?.stop();
		this.ticker = null;
		this.linesCache = null;
		this.ui.requestRender();
	}

	/** True once the phase holds no renderable calls — the stacker skips appending it. */
	isEmpty(): boolean {
		return this.counted.length === 0 && this.promoted.length === 0;
	}

	/** Open only the newest child body (scoped-first ctrl+o step). */
	expandLastChild(): void {
		this.expandMode = "last";
		this.linesCache = null;
		for (const e of this.counted) e.setExpanded(false);
		for (const entry of this.promoted) entry.line.setExpanded(false);
		const lastPromoted = this.promoted[this.promoted.length - 1];
		if (lastPromoted) {
			lastPromoted.line.setExpanded(true);
			this.lastExpandedEntry = lastPromoted;
		} else {
			const lastCounted = this.counted[this.counted.length - 1];
			if (lastCounted) {
				lastCounted.setExpanded(true);
				this.lastExpandedEntry = lastCounted;
			} else {
				this.lastExpandedEntry = null;
			}
		}
		this.ui.requestRender();
	}

	/** True when only the last child is expanded (not the full phase). */
	isLastChildExpanded(): boolean {
		return this.expandMode === "last";
	}

	/** Duck-typed Expandable (interactive-mode's ctrl+o loop): re-expand a sealed
	 * phase and open every child body. */
	setExpanded(expanded: boolean): void {
		this.expandMode = expanded ? "phase" : "none";
		this.lastExpandedEntry = null;
		this.linesCache = null;
		for (const e of this.counted) e.setExpanded(expanded);
		for (const entry of this.promoted) entry.line.setExpanded(expanded);
	}

	dispose(): void {
		this.ticker?.stop();
		this.ticker = null;
		this.iconEase.stop();
		this.countEase.stop();
		for (const e of this.counted) e.dispose();
		for (const entry of this.promoted) entry.line.dispose();
	}

	override invalidate(): void {
		super.invalidate();
		this.countsCache = null;
		this.headerStateCache = null;
		this.linesCache = null;
		for (const e of this.counted) e.invalidate();
		for (const entry of this.promoted) entry.line.invalidate();
	}

	private get expanded(): boolean {
		return this.expandMode !== "none";
	}

	private ensureTicker(): void {
		if (this.ticker) return;
		this.ticker = createSpinnerTicker(
			this.ui,
			() => this.anyCountedPending(),
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

	private anyCountedPending(): boolean {
		for (const e of this.counted) {
			if (e.getActivityState() === "pending") return true;
		}
		return false;
	}

	/** State of the COUNTED calls — drives the header icon and the spinner ticker. */
	private headerState(): GroupState {
		if (this.headerStateCache !== null) return this.headerStateCache;
		const state = this.aggregate(this.counted);
		if (state !== "pending" && this.ticker === null) this.headerStateCache = state;
		return state;
	}

	/** State across counted + promoted — the icon shown on the collapsed summary. */
	private overallState(): GroupState {
		const c = this.aggregate(this.counted);
		if (c === "pending") return "pending";
		let anyError = c === "error";
		for (const entry of this.promoted) {
			const s = entry.exec.getActivityState();
			if (s === "pending") return "pending";
			if (s === "error" && !entry.exec.isAborted()) anyError = true;
		}
		return anyError ? "error" : "success";
	}

	private aggregate(execs: ToolExecutionComponent[]): GroupState {
		let anyError = false;
		for (const e of execs) {
			const s = e.getActivityState();
			if (s === "pending") return "pending";
			if (s === "error" && !e.isAborted()) anyError = true;
		}
		return anyError ? "error" : "success";
	}

	private icon(state: GroupState): string {
		if (state === "pending") return theme.fg("gutterToolPending", this.spinnerGlyph ?? SPINNER_FRAMES[0]);
		const glyph = state === "error" ? ICON_ERROR : ICON_SUCCESS;
		const steady: ThemeColor = state === "error" ? "gutterToolError" : "gutterToolSuccess";
		// First half of the live settle ease holds the last spinner frame (crossfade
		// into ✓/✗). Sealed phases always snap — they are history, not live chrome.
		if (!this.sealed && this.iconEase.active && this.iconEase.progress < 0.5) {
			return this.iconEase.colorize(steady, this.lastSpinnerGlyph ?? SPINNER_FRAMES[0]);
		}
		return this.iconEase.colorize(steady, glyph);
	}

	/** Basenames of a small, pure file-read counted set (`config.ts·theme.ts`), or
	 * `null` when it is large, mixed, or any read lacks a usable path — the caller
	 * then falls back to the `N files` counter. */
	private countedBasenames(): string[] | null {
		if (this.counted.length === 0 || this.counted.length > BASENAME_LIST_MAX) return null;
		const names: string[] = [];
		for (const e of this.counted) {
			if (e.getToolName() !== "read") return null;
			const args = e.getArgs() ?? {};
			const raw = typeof args.file_path === "string" ? args.file_path : "";
			const name = basename(raw.replace(/[\\/]+$/, ""));
			if (!name) return null;
			names.push(name);
		}
		return names;
	}

	private isPromotedMustShow(entry: PromotedEntry): boolean {
		const s = entry.exec.getActivityState();
		if (s === "pending") return true;
		if (s === "error" && !entry.exec.isAborted()) return true;
		return false;
	}

	/** Promoted rows visible in the live layout: always pending/errors, plus the
	 * newest settled rows up to {@link LIVE_PROMOTED_VISIBLE}. */
	private visiblePromotedEntries(): { visible: PromotedEntry[]; hidden: PromotedEntry[] } {
		const mustShow: PromotedEntry[] = [];
		const settled: PromotedEntry[] = [];
		for (const entry of this.promoted) {
			if (this.isPromotedMustShow(entry)) mustShow.push(entry);
			else settled.push(entry);
		}
		const keptSettled = settled.slice(-LIVE_PROMOTED_VISIBLE);
		const hiddenSettled = settled.slice(0, Math.max(0, settled.length - LIVE_PROMOTED_VISIBLE));
		const visibleSet = new Set([...mustShow, ...keptSettled]);
		const visible = this.promoted.filter((e) => visibleSet.has(e));
		return { visible, hidden: hiddenSettled };
	}

	/** Dense per-noun counter over the counted calls only (`5 searches·8 commands`),
	 * or the inline basename list for a small pure-read set. Optionally folds in
	 * hidden promoted settled rows so the live header still accounts for them. */
	private countedCounts(extraPromoted: PromotedEntry[] = []): string {
		if (extraPromoted.length === 0 && this.countsCache !== null) return this.countsCache;
		const names = extraPromoted.length === 0 ? this.countedBasenames() : null;
		if (names) {
			this.countsCache = names.join(COUNTER_SEP);
			return this.countsCache;
		}
		const byNoun = new Map<string, number>();
		for (const e of this.counted) {
			const noun = nounFor(e.getToolName());
			byNoun.set(noun, (byNoun.get(noun) ?? 0) + 1);
		}
		for (const entry of extraPromoted) {
			const noun = collapseNoun(entry.toolName);
			byNoun.set(noun, (byNoun.get(noun) ?? 0) + entry.calls);
		}
		const joined = this.joinCounts(byNoun);
		if (extraPromoted.length === 0) this.countsCache = joined;
		return joined;
	}

	/** Collapsed summary: counted counts plus the promoted calls reabsorbed by
	 * bucket (`5 searches·8 commands·2 edits·1 agent·5 plans`). */
	private collapsedCounts(): string {
		// A sealed phase that was nothing but a few reads keeps the basename list, so
		// its collapsed summary matches its live header instead of flipping to `N files`.
		if (this.promoted.length === 0) {
			const names = this.countedBasenames();
			if (names) return names.join(COUNTER_SEP);
		}
		const byNoun = new Map<string, number>();
		for (const e of this.counted) {
			const noun = nounFor(e.getToolName());
			byNoun.set(noun, (byNoun.get(noun) ?? 0) + 1);
		}
		for (const entry of this.promoted) {
			const noun = collapseNoun(entry.toolName);
			byNoun.set(noun, (byNoun.get(noun) ?? 0) + entry.calls);
		}
		return this.joinCounts(byNoun);
	}

	private joinCounts(byNoun: Map<string, number>): string {
		const parts: string[] = [];
		for (const [noun, n] of byNoun) parts.push(`${n} ${pluralizeNoun(noun, n)}`);
		return parts.join(COUNTER_SEP);
	}

	private renderCollapsed(width: number): string[] {
		const state = this.overallState();
		const summary = this.collapsedCounts();
		const header = summary
			? truncateToWidth(`${this.icon(state)} ${theme.fg("toolOutput", summary)}`, width)
			: truncateToWidth(this.icon(state), width);
		const lines = [header];
		// A genuine error never hides in the count: keep failed promoted rows visible.
		// Counted failures stay header-only until expand (ctrl+o).
		for (const entry of this.promoted) {
			if (entry.exec.getActivityState() === "error" && !entry.exec.isAborted()) {
				for (const l of entry.line.render(width)) lines.push(l);
			}
		}
		return lines;
	}

	private renderLive(width: number): string[] {
		const lines: string[] = [];
		const { visible, hidden } = this.visiblePromotedEntries();
		const summary = this.countedCounts(hidden);
		if (summary) {
			const icon = this.icon(this.headerState());
			lines.push(truncateToWidth(`${icon} ${this.countEase.colorize("toolOutput", summary)}`, width));
		}
		for (const entry of visible) {
			for (const l of entry.line.render(width)) lines.push(l);
		}
		if (this.expandMode === "phase") {
			for (const e of this.counted) {
				for (const l of e.render(width - 2)) lines.push(`  ${l}`);
			}
		} else if (this.expandMode === "last" && this.lastExpandedEntry) {
			const target = this.lastExpandedEntry;
			// Promoted rows already render their body via ActivityLine.setExpanded.
			// Counted tools need an explicit indented body here.
			if (!("line" in target)) {
				for (const l of target.render(width - 2)) lines.push(`  ${l}`);
			}
		}
		return lines;
	}

	override render(width: number): string[] {
		if (this.isEmpty()) return [];
		const hstate = this.headerState();
		// Ease the header icon on settle (pending → ✔/✗), mirroring NavGroupComponent.
		if (hstate !== this.prevState) {
			if (hstate !== "pending") {
				const from: ThemeColor = this.prevState === "pending" ? "gutterToolPending" : "dim";
				const to: ThemeColor = hstate === "error" ? "gutterToolError" : "gutterToolSuccess";
				this.iconEase.begin(from, to);
			}
			this.prevState = hstate;
		}
		const collapsed = this.sealed && !this.expanded && !PHASE_COLLAPSE_DISABLED;
		// Memoize only the stable case: a sealed, collapsed, settled phase in history.
		// Live/expanded paths recompute (children may animate or stream); the promoted
		// ActivityLines carry their own memos.
		const cacheable =
			collapsed && this.overallState() !== "pending" && !this.iconEase.active && !this.countEase.active;
		const cacheKey = `${width}|${this.version}`;
		if (cacheable && this.linesCache !== null && this.linesCacheKey === cacheKey) {
			return this.linesCache;
		}
		const lines = collapsed ? this.renderCollapsed(width) : this.renderLive(width);
		if (cacheable) {
			this.linesCache = lines;
			this.linesCacheKey = cacheKey;
		} else {
			this.linesCache = null;
		}
		return lines;
	}
}
