import { Container, SPINNER_FRAMES, type TUI, truncateToWidth } from "@pit/tui";
import { formatElapsed, formatTokens } from "../../../utils/format-display.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { ColorEase } from "./color-ease.ts";
import { createSpinnerTicker, type SpinnerTicker } from "./spinner-ticker.ts";

/** Cap on agent rows; the overflow collapses into a trailing `+N more`. */
const MAX_AGENT_ROWS = 10;

/** Quiet window before a live row grows its dim elapsed clock — mirrors the
 * activity line's PENDING_ELAPSED_SUFFIX_AFTER_MS intent: fast agents stay
 * clock-free, slow ones get a visible counter while the user still cares. */
const ROW_CLOCK_AFTER_MS = 5000;

/** No event from a live agent for this long → the clock escalates to a warning
 * `quiet Ns` (time since the LAST event, not total elapsed): "slow but alive"
 * becomes tellable from "stuck" per agent, same reading as the bash stall.
 * Generous on purpose: progress fires once per TURN, and a single legitimate
 * tool call (a 2-minute test suite) emits nothing in between — a tighter
 * window would cry wolf on every build-heavy agent. */
const ROW_QUIET_WARN_MS = 120_000;

type AgentStatus = "running" | "done" | "error";

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
			existing.status = "running";
			existing.settledAt = 0;
			existing.startedAt = now;
			existing.lastEventAt = now;
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
		entry.turn = turn;
		entry.lastEventAt = Date.now();
		if (lastTool) entry.lastTool = lastTool;
		if (totalTokens !== undefined) entry.totalTokens = totalTokens;
		this.touch();
	}

	complete(handle: string, status: "done" | "error", turns?: number, totalTokens?: number): void {
		const entry = this.ensureEntry(handle);
		entry.status = status;
		entry.settledAt = Date.now();
		entry.lastEventAt = entry.settledAt;
		if (turns !== undefined) entry.turns = turns;
		if (totalTokens !== undefined) entry.totalTokens = totalTokens;
		// Spinner→outcome crossfade: freeze the shared frame the row was showing
		// and ease its color into the outcome; reduced-motion / non-truecolor
		// snaps inside ColorEase, so the row always ends on the steady ✓/✗.
		entry.settleGlyph = this.spinnerGlyph ?? SPINNER_FRAMES[0]!;
		entry.settleEase ??= new ColorEase(this.ui, () => {
			this.renderCache = null;
			this.ui.requestRender();
		});
		entry.settleEase.begin("gutterCustom", status === "done" ? "success" : "warning");
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
		let tokens = 0;
		let anyTokens = false;
		for (const entry of entries) {
			if (entry.status === "error") failed++;
			else if (entry.status === "done") done++;
			if (entry.totalTokens !== undefined) {
				tokens += entry.totalTokens;
				anyTokens = true;
			}
		}
		const leader = failed > 0 ? theme.fg("warning", "✗") : theme.fg("success", "✓");
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
		const elapsed = formatElapsed(Date.now() - this.firstStartedAt);
		let line = `${leader} ${dim(`${entries.length} agents`)}${dim("·")}${counts}${dim("·")}${dim(elapsed)}`;
		if (anyTokens) line += `${dim("·")}${dim(`${formatTokens(tokens)} tok`)}`;
		return line;
	}

	override render(width: number): string[] {
		if (this.agents.size === 0) return [];
		const now = Date.now();
		const glyph = this.spinnerGlyph ?? SPINNER_FRAMES[0]!;
		// The row clocks advance at 1s granularity, so the memo keys on the second
		// bucket; a settle crossfade blends a new color every frame, so while any
		// ease is in flight the cache is bypassed entirely.
		const second = Math.floor(now / 1000);
		const easing = [...this.agents.values()].some((entry) => entry.settleEase?.active);
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
		const lines: string[] = [];
		if (this.agents.size === 1) {
			lines.push(`${this.glyphFor(rows[0]!, glyph)} ${this.rowBody(rows[0]!, true, now)}`);
		} else {
			lines.push(this.header(glyph));
			rows.forEach((entry, idx) => {
				const isLast = hidden === 0 && idx === rows.length - 1;
				lines.push(`${dim(isLast ? "└" : "├")} ${this.glyphFor(entry, glyph)} ${this.rowBody(entry, false, now)}`);
			});
			if (hidden > 0) lines.push(dim(`└ +${hidden} more`));
		}

		// Every emitted line MUST fit the viewport: the TUI render guard rejects any
		// component line wider than `width`, and a handle can be arbitrarily long.
		const rendered = lines.map((line) => truncateToWidth(line, width, dim("…")));
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
		for (const entry of this.agents.values()) {
			if (entry.status === "running") continue;
			settled++;
			if (entry.status === "error") failed++;
		}
		// A fully settled strip has no spinner left to show, so the header takes the
		// outcome glyph instead of freezing mid-animation.
		let lead = theme.fg("muted", glyph);
		if (settled === this.agents.size) {
			lead = failed > 0 ? theme.fg("warning", "✗") : theme.fg("success", "✓");
		}
		return `${lead} ${theme.bold(theme.fg("muted", "Agents"))}${dim("·")}${dim(`${settled}/${this.agents.size}`)}`;
	}

	private glyphFor(entry: AgentEntry, glyph: string): string {
		// Live spinner rides the task-family color (gutterCustom) — the same tint
		// the activity stack gives a pending `task` line — so the strip reads as
		// delegation at a glance instead of generic muted chrome.
		if (entry.status === "running") return theme.fg("gutterCustom", glyph);
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
	private rowBody(entry: AgentEntry, single: boolean, now: number): string {
		const name = single
			? `${theme.fg("muted", "Agent")} ${theme.fg("text", `“${entry.handle}”`)}`
			: theme.fg("text", entry.handle);
		const parts: string[] = [];
		if (entry.status === "running") {
			parts.push(dim(`turn ${entry.turn}`));
			if (entry.lastTool) parts.push(dim(entry.lastTool));
			// Live cumulative spend, fed by subagent_progress once per turn.
			if (entry.totalTokens) parts.push(dim(`↑${formatTokens(entry.totalTokens)}`));
			// One clock per row: the quiet warning REPLACES the dim elapsed (time
			// since the last event is the datum that matters once an agent goes
			// silent; total elapsed says nothing about stuckness).
			const quietMs = now - entry.lastEventAt;
			if (quietMs > ROW_QUIET_WARN_MS) {
				parts.push(theme.fg("warning", `quiet ${formatElapsed(quietMs)}`));
			} else if (now - entry.startedAt > ROW_CLOCK_AFTER_MS) {
				parts.push(dim(formatElapsed(now - entry.startedAt)));
			}
		} else {
			if (entry.status === "error") parts.push(dim("failed"));
			const turns = entry.turns;
			if (turns !== undefined) parts.push(dim(`${turns} ${turns === 1 ? "turn" : "turns"}`));
			if (entry.totalTokens !== undefined) parts.push(dim(`${formatTokens(entry.totalTokens)} tok`));
		}
		let body = name;
		for (const part of parts) body += `${dim("·")}${part}`;
		return body;
	}
}
