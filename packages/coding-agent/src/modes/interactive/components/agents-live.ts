import { Container, type TUI, truncateToWidth, visibleWidth } from "@pit/tui";
import { formatElapsed, formatTokens } from "../../../utils/format-display.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { ColorEase } from "./color-ease.ts";
import { resolveSpinnerFrames, resolveTreeConnectors } from "./glyph-resolver.ts";
import { createSpinnerTicker, type SpinnerTicker } from "./spinner-ticker.ts";

/** Cap on agent rows; the overflow collapses into a trailing `+N more`. */
const MAX_AGENT_ROWS = 10;

/** Quiet window before a live row grows its dim elapsed clock — mirrors the
 * activity line's PENDING_ELAPSED_SUFFIX_AFTER_MS intent: fast agents stay
 * clock-free, slow ones get a visible counter while the user still cares. */
const ROW_CLOCK_AFTER_MS = 5000;

/**
 * Soft "still alive?" mark: no progress for this long (but under
 * {@link ROW_QUIET_WARN_MS}) → dim `waiting…` instead of total elapsed.
 * Bridges the gap between the 5s elapsed clock and the 120s warning so long
 * tool turns (progress only per turn) don't look frozen then suddenly "quiet".
 */
const ROW_SOFT_WAITING_MS = 12_000;

/** No event from a live agent for this long → the clock escalates to a warning
 * `quiet Ns` (time since the LAST event, not total elapsed): "slow but alive"
 * becomes tellable from "stuck" per agent, same reading as the bash stall.
 * Generous on purpose: progress fires once per TURN, and a single legitimate
 * tool call (a 2-minute test suite) emits nothing in between — a tighter
 * window would cry wolf on every build-heavy agent. */
const ROW_QUIET_WARN_MS = 120_000;

type AgentStatus = "running" | "done" | "error" | "cancelled";

/**
 * One tracked subagent. `turn`/`lastTool` are the live signals (fed by
 * `subagent_progress`); `turns`/`totalTokens` are the settle metrics reported by
 * `subagent_complete` and may be absent — a settled row simply omits the parts
 * the event did not carry.
 */
interface AgentEntry {
	handle: string;
	/** Insertion rank (first upsertStart). Rows always render in this order. */
	order: number;
	status: AgentStatus;
	turn: number;
	lastTool: string;
	turns?: number;
	totalTokens?: number;
	/** Date.now() at settle; 0 while running. Breaks the overflow tie (newest kept). */
	settledAt: number;
	/** Date.now() at (re)start — origin of the row's dim elapsed clock. */
	startedAt: number;
	/** Date.now() of the last lifecycle event — origin of the `quiet Ns` warning. */
	lastEventAt: number;
	/** Spinner frame frozen at settle so the crossfade eases OUT of it. */
	settleGlyph?: string;
	/** One-shot spinner→outcome color crossfade, created at first settle. */
	settleEase?: ColorEase;
}

function dim(text: string): string {
	return theme.fg("dim", text);
}

/**
 * Live, multi-line strip for parallel subagents — one row per agent, updated
 * in place. Rendered in the transient band above the editor; auto-hides (render
 * returns []) while no agent is tracked.
 *
 * A single agent renders as one bare line (no header, no connector) so the strip
 * reads exactly like the old single-line agent status; two or more grow a header
 * plus tree connectors.
 *
 * Animation rides ONE shared spinner ticker for the whole strip, so every live
 * row shows the same braille frame instead of drifting out of phase. The ticker
 * is lazily (re)created whenever an agent goes live and self-stops on the frame
 * after the last one settles — a fully settled strip holds no animation
 * subscription at all.
 */
export class AgentsLiveComponent extends Container {
	private ui: TUI;
	private agents = new Map<string, AgentEntry>();
	private nextOrder = 0;
	/** Date.now() at the first upsertStart — the origin of summaryLine's elapsed. */
	private firstStartedAt = 0;
	private ticker: SpinnerTicker | null = null;
	private spinnerGlyph: string | null = null;
	/** One-shot header lead ease when the strip becomes fully settled (mixed → done). */
	private headerEase: ColorEase | undefined;
	/** Frozen spinner frame held through the first half of {@link headerEase}. */
	private headerSettleGlyph: string | undefined;
	/** Outcome glyph the header eases into (`✓` or `✗`). */
	private headerOutcome: "✓" | "✗" | "-" | undefined;
	/**
	 * When true, render collapses to a single dense summary line (same text as
	 * {@link summaryLine}) for a short beat before the host disposes the strip
	 * into the transcript — softens the multi-row → chat hard cut.
	 */
	private collapsePreview = false;
	// Bumped on every mutation so the render memo keys on content; the spinner
	// glyph is part of the key because live rows repaint per frame.
	private version = 0;
	private renderCache: { version: number; width: number; glyph: string; second: number; lines: string[] } | null =
		null;

	constructor(ui: TUI) {
		super();
		this.ui = ui;
	}

	upsertStart(handle: string): void {
		const now = Date.now();
		const existing = this.agents.get(handle);
		if (existing) {
			// Revive in place: a re-started handle keeps its row (and its slot in the
			// insertion order) instead of jumping to the bottom of the strip. The
			// clocks restart — this is a new run of the handle, not the old one.
			// Drop any in-flight settle ease/glyph from the previous wave so the
			// row doesn't keep coloring a frozen spinner through a half-finished
			// ColorEase while status is already "running" again.
			existing.settleEase?.stop();
			existing.settleEase = undefined;
			existing.settleGlyph = undefined;
			existing.status = "running";
			existing.settledAt = 0;
			existing.startedAt = now;
			existing.lastEventAt = now;
			// Fresh run: clear last-wave metrics so the live row doesn't show stale
			// "4 turns · 9.3k tok" under a spinning glyph until new progress lands.
			existing.turns = undefined;
			existing.totalTokens = undefined;
			existing.lastTool = "";
			existing.turn = 1;
			// A new live row means the strip is no longer fully settled — drop any
			// header all-done ease so the lead can go back to spinner / mixed mark.
			this.clearHeaderSettle();
		} else {
			if (this.firstStartedAt === 0) this.firstStartedAt = now;
			this.agents.set(handle, {
				handle,
				order: this.nextOrder++,
				status: "running",
				// An agent that has started is on its first turn; the first progress
				// event overwrites this, so the row never shows "turn 0".
				turn: 1,
				lastTool: "",
				settledAt: 0,
				startedAt: now,
				lastEventAt: now,
			});
			this.clearHeaderSettle();
		}
		this.touch();
	}

	upsertProgress(handle: string, turn: number, lastTool?: string, totalTokens?: number): void {
		const entry = this.ensureEntry(handle);
		// A settled row stays settled: a progress event that arrives after the
		// agent's completion is stale reordering, and reviving the row here would
		// leave a spinner nothing will ever settle again (the completion already
		// happened). Only an explicit upsertStart revives a handle.
		if (entry.status !== "running") return;
		// Transport events may arrive out of order; never make a live row look as
		// though an agent went backwards (notably across retry/phase telemetry).
		entry.turn = Math.max(entry.turn, turn);
		entry.lastEventAt = Date.now();
		if (lastTool) entry.lastTool = lastTool;
		if (totalTokens !== undefined) entry.totalTokens = Math.max(entry.totalTokens ?? 0, totalTokens);
		this.touch();
	}

	complete(handle: string, status: "done" | "error" | "cancelled", turns?: number, totalTokens?: number): void {
		const entry = this.ensureEntry(handle);
		const wasRunning = entry.status === "running";
		// A terminal row is immutable until an explicit upsertStart opens a new
		// wave. Transport retries can deliver a stale completion after the real
		// outcome; allowing it to overwrite the status makes an error look done.
		if (!wasRunning) return;
		entry.status = status;
		entry.settledAt = Date.now();
		entry.lastEventAt = entry.settledAt;
		if (turns !== undefined) entry.turns = turns;
		if (totalTokens !== undefined) entry.totalTokens = totalTokens;
		// Only start the spinner→outcome ease on the running→settled edge. A
		// duplicate complete (reordered event) must not restart the crossfade
		// mid-flight or re-trigger the header settle.
		if (wasRunning) {
			entry.settleGlyph = this.spinnerGlyph ?? resolveSpinnerFrames()[0]!;
			entry.settleEase ??= new ColorEase(this.ui, () => {
				this.renderCache = null;
				this.ui.requestRender();
			});
			entry.settleEase.begin("gutterCustom", status === "done" ? "success" : "warning");
			// Last agent down: ease the header lead into the strip outcome so rows
			// and header settle together (mixed "·" would otherwise snap to ✓/✗).
			if (this.allSettled() && this.agents.size >= 2) {
				this.beginHeaderSettle();
			}
		}
		this.touch();
	}

	allSettled(): boolean {
		if (this.agents.size === 0) return false;
		for (const entry of this.agents.values()) {
			if (entry.status === "running") return false;
		}
		return true;
	}

	hasAgents(): boolean {
		return this.agents.size > 0;
	}

	summaryLine(): string {
		const entries = [...this.agents.values()];
		if (entries.length === 0) return "";
		let done = 0;
		let failed = 0;
		let cancelled = 0;
		let tokens = 0;
		let anyTokens = false;
		for (const entry of entries) {
			if (entry.status === "error") failed++;
			else if (entry.status === "cancelled") cancelled++;
			else if (entry.status === "done") done++;
			if (entry.totalTokens !== undefined) {
				tokens += entry.totalTokens;
				anyTokens = true;
			}
		}
		const leader =
			failed > 0 ? theme.fg("warning", "✗") : cancelled > 0 ? theme.fg("muted", "-") : theme.fg("success", "✓");
		if (entries.length === 1) {
			const entry = entries[0]!;
			let line = `${leader} ${theme.fg("text", entry.handle)}`;
			// Falls back to the last live turn when the settle event carried no count —
			// the transcript line should still say how much work the agent did.
			const turns = entry.turns ?? entry.turn;
			if (turns > 0) line += `${dim("·")}${dim(`${turns} ${turns === 1 ? "turn" : "turns"}`)}`;
			if (anyTokens) line += `${dim("·")}${dim(`${formatTokens(tokens)} tok`)}`;
			return line;
		}
		let counts = `${dim(`${done}`)}${theme.fg("success", "✓")}`;
		if (failed > 0) counts += ` ${dim(`${failed}`)}${theme.fg("warning", "✗")}`;
		if (cancelled > 0) counts += ` ${dim(`${cancelled}`)}${theme.fg("muted", "-")}`;
		const elapsed = formatElapsed(Date.now() - this.firstStartedAt);
		let line = `${leader} ${dim(`${entries.length} agents`)}${dim("·")}${counts}${dim("·")}${dim(elapsed)}`;
		if (anyTokens) line += `${dim("·")}${dim(`${formatTokens(tokens)} tok`)}`;
		return line;
	}

	/**
	 * Enter the pre-dispose collapse beat: strip paints as one summary line.
	 * Idempotent. Cleared on dispose or a new lifecycle mutation via touch.
	 */
	enterCollapsePreview(): void {
		if (this.collapsePreview || this.agents.size === 0) return;
		this.collapsePreview = true;
		// Summary line doesn't use header/row eases — stop them so they don't
		// keep requesting renders through the preview beat.
		this.ticker?.stop();
		this.ticker = null;
		this.clearHeaderSettle();
		for (const entry of this.agents.values()) entry.settleEase?.stop();
		this.renderCache = null;
		this.ui.requestRender();
	}

	/** True while {@link enterCollapsePreview} is active. */
	isCollapsePreview(): boolean {
		return this.collapsePreview;
	}

	override render(width: number): string[] {
		if (this.agents.size === 0) return [];
		// Pre-dispose beat: one dense line matching what will land in the transcript.
		if (this.collapsePreview) {
			const summary = this.summaryLine();
			if (!summary) return [];
			return [truncateToWidth(summary, width, theme.ellipsis("dim"))];
		}
		const now = Date.now();
		const glyph = this.spinnerGlyph ?? resolveSpinnerFrames()[0]!;
		// The row clocks advance at 1s granularity, so the memo keys on the second
		// bucket; a settle crossfade blends a new color every frame, so while any
		// ease is in flight the cache is bypassed entirely.
		const second = Math.floor(now / 1000);
		const easing =
			(this.headerEase?.active ?? false) || [...this.agents.values()].some((entry) => entry.settleEase?.active);
		const cache = this.renderCache;
		if (
			!easing &&
			cache &&
			cache.version === this.version &&
			cache.width === width &&
			cache.glyph === glyph &&
			cache.second === second
		) {
			return cache.lines;
		}

		const { rows, hidden } = this.visibleRows();
		const tree = resolveTreeConnectors();
		const lines: string[] = [];
		if (this.agents.size === 1) {
			lines.push(`${this.glyphFor(rows[0]!, glyph)} ${this.rowBody(rows[0]!, true, now, width - 2)}`);
		} else {
			lines.push(this.header(glyph));
			rows.forEach((entry, idx) => {
				const isLast = hidden === 0 && idx === rows.length - 1;
				lines.push(
					`${dim(isLast ? tree.last : tree.branch)} ${this.glyphFor(entry, glyph)} ${this.rowBody(entry, false, now, width - 4)}`,
				);
			});
			if (hidden > 0) lines.push(dim(`${tree.last} +${hidden} more`));
		}

		// Every emitted line MUST fit the viewport: the TUI render guard rejects any
		// component line wider than `width`, and a handle can be arbitrarily long.
		const rendered = lines.map((line) => truncateToWidth(line, width, theme.ellipsis("dim")));
		this.renderCache = easing ? null : { version: this.version, width, glyph, second, lines: rendered };
		return rendered;
	}

	override invalidate(): void {
		super.invalidate();
		this.renderCache = null;
	}

	dispose(): void {
		this.ticker?.stop();
		this.ticker = null;
		this.spinnerGlyph = null;
		this.collapsePreview = false;
		this.clearHeaderSettle();
		for (const entry of this.agents.values()) entry.settleEase?.stop();
		this.agents.clear();
		this.renderCache = null;
	}

	/** Look up a handle, registering it as live when an event arrives out of order
	 * (progress/complete before start) so no agent goes unrendered. */
	private ensureEntry(handle: string): AgentEntry {
		const existing = this.agents.get(handle);
		if (existing) return existing;
		this.upsertStart(handle);
		return this.agents.get(handle)!;
	}

	private touch(): void {
		// A live mutation cancels any pre-dispose collapse beat — the strip is
		// still wanted (new agent / progress), not folding into the transcript.
		this.collapsePreview = false;
		this.version++;
		this.renderCache = null;
		this.ensureTicker();
		this.ui.requestRender();
	}

	private ensureTicker(): void {
		if (this.ticker) return;
		if (this.allSettled()) return;
		this.ticker = createSpinnerTicker(
			this.ui,
			() => !this.allSettled() && this.agents.size > 0,
			(g) => {
				this.spinnerGlyph = g;
				this.renderCache = null;
				if (g === null) {
					this.ticker?.stop();
					this.ticker = null;
				}
			},
		);
	}

	/** Rows to draw plus the count folded into `+N more`. Live agents win every
	 * slot (insertion order); leftovers go to the most recently settled. */
	private visibleRows(): { rows: AgentEntry[]; hidden: number } {
		const all = [...this.agents.values()];
		if (all.length <= MAX_AGENT_ROWS) return { rows: all, hidden: 0 };
		const live = all.filter((e) => e.status === "running").slice(0, MAX_AGENT_ROWS);
		const budget = MAX_AGENT_ROWS - live.length;
		const settled = all
			.filter((e) => e.status !== "running")
			.sort((a, b) => b.settledAt - a.settledAt || b.order - a.order)
			.slice(0, budget);
		const keep = new Set([...live, ...settled]);
		const rows = all.filter((e) => keep.has(e));
		return { rows, hidden: all.length - rows.length };
	}

	private header(glyph: string): string {
		let settled = 0;
		let failed = 0;
		let cancelled = 0;
		let running = 0;
		for (const entry of this.agents.values()) {
			if (entry.status === "running") {
				running++;
				continue;
			}
			settled++;
			if (entry.status === "error") failed++;
			else if (entry.status === "cancelled") cancelled++;
		}
		// Lead glyph policy:
		// - all settled → outcome ✓/✗ (optionally via headerEase two-phase)
		// - mixed (some done, some live) → quiet dim mark; spinner stays on live
		//   rows only so the header doesn't "keep spinning" past majority done
		// - all running → shared spinner frame (phase-locked with rows)
		let lead: string;
		if (running === 0) {
			const steady: ThemeColor = failed > 0 ? "warning" : cancelled > 0 ? "muted" : "success";
			const outcome = this.headerOutcome ?? (failed > 0 ? "✗" : cancelled > 0 ? "-" : "✓");
			const ease = this.headerEase;
			if (ease?.active && ease.progress < 0.5) {
				lead = ease.colorize(steady, this.headerSettleGlyph ?? outcome);
			} else if (ease) {
				lead = ease.colorize(steady, outcome);
			} else {
				lead = theme.fg(steady, outcome);
			}
		} else if (settled > 0) {
			lead = dim("·");
		} else {
			lead = theme.fg("muted", glyph);
		}
		return `${lead} ${theme.bold(theme.fg("muted", "Agents"))}${dim("·")}${dim(`${settled}/${this.agents.size}`)}`;
	}

	/** Start the header lead's spinner→outcome ease (multi-agent all-settled only). */
	private beginHeaderSettle(): void {
		let failed = 0;
		let cancelled = 0;
		for (const entry of this.agents.values()) {
			if (entry.status === "error") failed++;
			else if (entry.status === "cancelled") cancelled++;
		}
		this.headerSettleGlyph = this.spinnerGlyph ?? resolveSpinnerFrames()[0]!;
		this.headerOutcome = failed > 0 ? "✗" : cancelled > 0 ? "-" : "✓";
		this.headerEase ??= new ColorEase(this.ui, () => {
			this.renderCache = null;
			this.ui.requestRender();
		});
		// From muted (mixed "·" / spinner) into the strip outcome color.
		this.headerEase.begin("muted", failed > 0 ? "warning" : cancelled > 0 ? "muted" : "success");
	}

	private clearHeaderSettle(): void {
		this.headerEase?.stop();
		this.headerEase = undefined;
		this.headerSettleGlyph = undefined;
		this.headerOutcome = undefined;
	}

	private glyphFor(entry: AgentEntry, glyph: string): string {
		// Live spinner rides the task-family color (gutterCustom) — the same tint
		// the activity stack gives a pending `task` line — so the strip reads as
		// delegation at a glance instead of generic muted chrome.
		if (entry.status === "running") return theme.fg("gutterCustom", glyph);
		if (entry.status === "cancelled") return theme.fg("muted", "-");
		const steady: ThemeColor = entry.status === "done" ? "success" : "warning";
		const outcome = entry.status === "done" ? "✓" : "✗";
		const ease = entry.settleEase;
		// Two-phase settle (mirrors the activity line's gutter): hold the frozen
		// spinner frame through the first half of the color ease, swap to the
		// outcome glyph on the second — the spinner eases INTO the ✓/✗ instead of
		// snapping. ColorEase already snaps under reduced motion / no truecolor.
		if (ease?.active && ease.progress < 0.5) {
			return ease.colorize(steady, entry.settleGlyph ?? outcome);
		}
		return ease ? ease.colorize(steady, outcome) : theme.fg(steady, outcome);
	}

	/** The row after its glyph. Only the handle is bright; every mechanical part
	 * (turn, tool, tokens, clock) stays dim — except the `quiet Ns` escalation,
	 * which renders in warning. `single` spells the handle out as `Agent “x”` —
	 * the strip carries no header in that shape. Parts arrive pre-colored so the
	 * joiner stays a plain dim `·`. */
	private rowBody(entry: AgentEntry, single: boolean, now: number, availableWidth: number): string {
		const name = single
			? `${theme.fg("muted", "Agent")} ${theme.fg("text", `“${entry.handle}”`)}`
			: theme.fg("text", entry.handle);
		const parts: string[] = [];
		if (entry.status === "running") {
			parts.push(dim(`turn ${entry.turn}`));
			if (entry.lastTool) parts.push(dim(entry.lastTool));
			// Live cumulative spend, fed by subagent_progress once per turn.
			if (entry.totalTokens) parts.push(dim(`↑${formatTokens(entry.totalTokens)}`));
			// One status clock per row (mutually exclusive rungs):
			//   quiet > soft-waiting > total elapsed
			// Once the agent goes silent, time-since-last-event matters more than
			// total wall clock — total elapsed says nothing about stuckness.
			const quietMs = now - entry.lastEventAt;
			if (quietMs > ROW_QUIET_WARN_MS) {
				parts.push(theme.fg("warning", `quiet ${formatElapsed(quietMs)}`));
			} else if (quietMs > ROW_SOFT_WAITING_MS) {
				parts.push(dim("waiting…"));
			} else if (now - entry.startedAt > ROW_CLOCK_AFTER_MS) {
				parts.push(dim(formatElapsed(now - entry.startedAt)));
			}
		} else {
			if (entry.status === "error") parts.push(theme.fg("warning", "failed"));
			else if (entry.status === "cancelled") parts.push(dim("cancelled"));
			const turns = entry.turns;
			if (turns !== undefined) parts.push(dim(`${turns} ${turns === 1 ? "turn" : "turns"}`));
			if (entry.totalTokens !== undefined) parts.push(dim(`${formatTokens(entry.totalTokens)} tok`));
		}
		const suffix = parts.map((part) => `${dim("·")}${part}`).join("");
		const nameBudget = Math.max(4, availableWidth - visibleWidth(suffix));
		const displayName = truncateToWidth(name, nameBudget, theme.ellipsis("dim"));
		return `${displayName}${suffix}`;
	}
}
