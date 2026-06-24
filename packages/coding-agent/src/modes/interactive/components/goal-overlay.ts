/**
 * GoalOverlayComponent — the live "above editor" goal panel. Sits above the
 * todo overlay (goal commands, todos obey) and auto-hides when no goal is
 * active. A completed goal lingers `GOAL_COMPLETE_LINGER_MS` showing the
 * summary, then vanishes — the footer statusline keeps the terse glance.
 *
 * Mirrors the TodoOverlayComponent pattern: pure renderer (testable), fresh
 * state read every render, clock injected for phase-locked spinners (P7).
 */

import { performance } from "node:perf_hooks";
import { type Component, SPINNER_FRAME_MS, SPINNER_FRAMES, truncateToWidth, visibleWidth } from "@pit/tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { formatElapsed, formatTokens, type GoalSnapshot } from "../../../core/goal/goal-manager.ts";
import { theme } from "../theme/theme.ts";

/** A completed goal lingers this long before the overlay auto-hides. */
export const GOAL_COMPLETE_LINGER_MS = 4000;

// "├─ " or "└─ " = 3 visible chars, same geometry as the todo overlay.
const CONNECTOR_WIDTH = 3;

function statusWord(status: GoalSnapshot["status"]): string {
	switch (status) {
		case "active":
			return "active";
		case "paused":
			return "paused";
		case "budget_limited":
			return "budget";
		case "complete":
			return "complete";
	}
}

function statusColorize(status: GoalSnapshot["status"]): (text: string) => string {
	switch (status) {
		case "active":
			return (s) => theme.fg("accent", s);
		case "paused":
			return (s) => theme.fg("warning", s);
		case "budget_limited":
			return (s) => theme.fg("error", s);
		case "complete":
			return (s) => theme.fg("success", s);
	}
}

/**
 * Tail line content (uncolored) + colorizer for the last row. The spinner
 * glyph is passed in so the renderer stays pure — the component owns the clock.
 */
function hintForStatus(
	status: GoalSnapshot["status"],
	continuing: boolean,
	spinner: string,
	summary: string | undefined,
): { text: string; colorize: (s: string) => string } {
	switch (status) {
		case "active":
			if (continuing) return { text: `${spinner} working…`, colorize: (s) => theme.fg("accent", s) };
			return { text: "idle — Esc to pause", colorize: (s) => theme.fg("muted", s) };
		case "paused":
			return { text: "resume with /goal resume", colorize: (s) => theme.fg("warning", s) };
		case "budget_limited":
			return { text: "raise with /goal --tokens <n>", colorize: (s) => theme.fg("error", s) };
		case "complete": {
			const s = summary && summary.length > 0 ? summary : "done";
			return { text: s, colorize: (str) => theme.fg("success", str) };
		}
	}
}

/**
 * Pure renderer. Returns [] when there is no goal, or when a completed goal
 * has lingered past `GOAL_COMPLETE_LINGER_MS` (signalled by `completeAgeMs`).
 *
 * Layout (4 lines):
 *   ● Goal — <status>
 *   ├─ <objective>
 *   ├─ iter N · tokens NN[ /NN] · <elapsed>
 *   └─ <hint>
 */
export function renderGoalOverlay(
	snapshot: GoalSnapshot | undefined,
	width: number,
	continuing: boolean,
	spinner: string,
	completeAgeMs?: number,
): string[] {
	if (!snapshot) return [];
	if (snapshot.status === "complete" && completeAgeMs !== undefined && completeAgeMs > GOAL_COMPLETE_LINGER_MS) {
		return [];
	}

	const rowBudget = Math.max(4, width - CONNECTOR_WIDTH);

	// Header: accent dot, bold "Goal", dim em-dash, status word in status color.
	const word = statusColorize(snapshot.status)(statusWord(snapshot.status));
	const header = `${theme.fg("accent", "●")} ${theme.bold("Goal")} ${theme.fg("dim", "—")} ${word}`;
	const headerLine = visibleWidth(header) > width ? truncateToWidth(header, width, "…") : header;

	// Objective (middle row).
	const obj =
		visibleWidth(snapshot.objective) > rowBudget
			? truncateToWidth(snapshot.objective, rowBudget, "…")
			: snapshot.objective;
	const objLine = `${theme.fg("dim", "├─ ")}${obj}`;

	// Metrics (middle row).
	const budgetPart = snapshot.tokenBudget !== undefined ? `/${formatTokens(snapshot.tokenBudget)}` : "";
	const metricsText = `iter ${snapshot.iterations} · tokens ${formatTokens(snapshot.tokensUsed)}${budgetPart} · ${formatElapsed(snapshot.elapsedMs)}`;
	const metricsBody =
		visibleWidth(metricsText) > rowBudget ? truncateToWidth(metricsText, rowBudget, "…") : metricsText;
	const metricsLine = `${theme.fg("dim", "├─ ")}${theme.fg("muted", metricsBody)}`;

	// Hint (last row, └─).
	const hint = hintForStatus(snapshot.status, continuing, spinner, snapshot.summary);
	const hintBudget = Math.max(4, rowBudget);
	const hintText = visibleWidth(hint.text) > hintBudget ? truncateToWidth(hint.text, hintBudget, "…") : hint.text;
	const hintLine = `${theme.fg("dim", "└─ ")}${hint.colorize(hintText)}`;

	return [headerLine, objLine, metricsLine, hintLine];
}

class GoalOverlayComponent implements Component {
	private session: AgentSession;
	private readonly clock: () => number;
	/** Epoch ms when the goal first read `complete`; reset on status change / session swap. */
	private completeSeenAt: number | undefined;

	// Same monotonic source as every other spinner so the overlay's glyph is
	// phase-locked with the loader/tool/todo/footer spinners (P7).
	constructor(session: AgentSession, clock: () => number = () => performance.now()) {
		this.session = session;
		this.clock = clock;
	}

	setSession(session: AgentSession): void {
		this.session = session;
		this.completeSeenAt = undefined;
	}

	invalidate(): void {
		this.completeSeenAt = undefined;
	}

	render(width: number): string[] {
		const snapshot = this.session.goalSnapshot();
		if (!snapshot) {
			this.completeSeenAt = undefined;
			return [];
		}
		// Track the moment we first saw `complete` so the renderer can age it.
		if (snapshot.status === "complete") {
			if (this.completeSeenAt === undefined) this.completeSeenAt = this.clock();
		} else {
			this.completeSeenAt = undefined;
		}
		const completeAgeMs =
			snapshot.status === "complete" && this.completeSeenAt !== undefined
				? this.clock() - this.completeSeenAt
				: undefined;
		const continuing = this.session.goalIsDriving();
		const frame = SPINNER_FRAMES[Math.floor(this.clock() / SPINNER_FRAME_MS) % SPINNER_FRAMES.length];
		const lines = renderGoalOverlay(snapshot, width, continuing, frame ?? SPINNER_FRAMES[0], completeAgeMs);
		// Leading blank line separates the overlay from the chat above it (same
		// convention as the todo overlay).
		return lines.length > 0 ? ["", ...lines] : [];
	}
}

export type GoalOverlay = Component & { setSession(session: AgentSession): void };

export function createGoalOverlay(session: AgentSession, clock?: () => number): GoalOverlay {
	return new GoalOverlayComponent(session, clock);
}
