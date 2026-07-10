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
import { type Component, truncateToWidth, visibleWidth } from "@pit/tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { formatElapsed, formatTokens, type GoalSnapshot } from "../../../core/goal/goal-manager.ts";
import { theme } from "../theme/theme.ts";
import { spinnerGlyphAt } from "./spinner-ticker.ts";

/** A completed goal lingers this long before the overlay auto-hides. */
export const GOAL_COMPLETE_LINGER_MS = 4000;
/** Final segment of the linger window: hint swaps to a static ✓ prefix. */
export const GOAL_COMPLETE_SOFT_EXIT_MS = 400;

// "├─ " or "└─ " = 3 visible chars, same geometry as the todo overlay.
const CONNECTOR_WIDTH = 3;

function fitWidth(text: string, width: number): string {
	return visibleWidth(text) > width ? truncateToWidth(text, width, "…") : text;
}

function rowBudget(width: number): number {
	return Math.max(4, width - CONNECTOR_WIDTH);
}

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

function hintForStatus(
	status: GoalSnapshot["status"],
	continuing: boolean,
	spinner: string,
	summary: string | undefined,
	completeAgeMs?: number,
): { text: string; colorize: (s: string) => string } {
	switch (status) {
		case "active":
			if (continuing) return { text: `${spinner} working…`, colorize: (s) => theme.fg("accent", s) };
			return { text: "idle — Esc or /goal pause", colorize: (s) => theme.fg("muted", s) };
		case "paused":
			return { text: "resume with /goal resume", colorize: (s) => theme.fg("warning", s) };
		case "budget_limited":
			return { text: "raise with /goal --tokens <n>", colorize: (s) => theme.fg("error", s) };
		case "complete": {
			const base = summary && summary.length > 0 ? summary : "done";
			const softExit =
				completeAgeMs !== undefined && completeAgeMs > GOAL_COMPLETE_LINGER_MS - GOAL_COMPLETE_SOFT_EXIT_MS;
			const text = softExit ? `✓ ${base}` : base;
			return { text, colorize: (s) => theme.fg("success", s) };
		}
	}
}

function goalStructuralKey(snapshot: GoalSnapshot): string {
	const split = snapshot.tokenSpendSplit
		? `${snapshot.tokenSpendSplit.main}/${snapshot.tokenSpendSplit.subagent}/${snapshot.tokenSpendSplit.fusion}`
		: "";
	return `${snapshot.status}|${snapshot.iterations}|${snapshot.tokensUsed}|${snapshot.tokenBudget ?? ""}|${split}|${snapshot.objective}|${snapshot.summary ?? ""}`;
}

function buildGoalHeaderLine(snapshot: GoalSnapshot, width: number): string {
	const word = statusColorize(snapshot.status)(statusWord(snapshot.status));
	const header = `${theme.fg("accent", "●")} ${theme.bold("Goal")} ${theme.fg("dim", "—")} ${word}`;
	return fitWidth(header, width);
}

function buildGoalObjectiveLine(snapshot: GoalSnapshot, width: number): string {
	const budget = rowBudget(width);
	const obj = fitWidth(snapshot.objective, budget);
	return `${theme.fg("dim", "├─ ")}${obj}`;
}

function buildGoalMetricsLine(snapshot: GoalSnapshot, width: number): string {
	const budget = rowBudget(width);
	const budgetPart = snapshot.tokenBudget !== undefined ? `/${formatTokens(snapshot.tokenBudget)}` : "";
	const split = snapshot.tokenSpendSplit;
	const splitPart = split
		? ` · ${formatTokens(split.main)}/${formatTokens(split.subagent)}/${formatTokens(split.fusion)}`
		: "";
	const nearBudget =
		snapshot.tokenBudget !== undefined &&
		snapshot.tokenBudget > 0 &&
		(snapshot.status === "active" || snapshot.status === "paused") &&
		snapshot.tokensUsed / snapshot.tokenBudget >= 0.8
			? " · ~80% budget"
			: "";
	const metricsText = `iter ${snapshot.iterations} · tokens ${formatTokens(snapshot.tokensUsed)}${budgetPart}${splitPart}${nearBudget} · ${formatElapsed(snapshot.elapsedMs)}`;
	const metricsBody = fitWidth(metricsText, budget);
	return `${theme.fg("dim", "├─ ")}${theme.fg("muted", metricsBody)}`;
}

function buildGoalHintLine(
	snapshot: GoalSnapshot,
	width: number,
	continuing: boolean,
	spinner: string,
	completeAgeMs?: number,
): string {
	const hint = hintForStatus(snapshot.status, continuing, spinner, snapshot.summary, completeAgeMs);
	const hintText = fitWidth(hint.text, rowBudget(width));
	return `${theme.fg("dim", "└─ ")}${hint.colorize(hintText)}`;
}

interface GoalOverlayRenderCache {
	structuralKey: string;
	width: number;
	continuing: boolean;
	elapsedBucket: number;
	headerLine: string;
	objLine: string;
	metricsLine: string;
}

function seedGoalOverlayCache(snapshot: GoalSnapshot, width: number, continuing: boolean): GoalOverlayRenderCache {
	return {
		structuralKey: goalStructuralKey(snapshot),
		width,
		continuing,
		elapsedBucket: Math.floor(snapshot.elapsedMs / 1000),
		headerLine: buildGoalHeaderLine(snapshot, width),
		objLine: buildGoalObjectiveLine(snapshot, width),
		metricsLine: buildGoalMetricsLine(snapshot, width),
	};
}

function materializeGoalOverlayCache(
	cache: GoalOverlayRenderCache,
	snapshot: GoalSnapshot,
	width: number,
	continuing: boolean,
	spinner: string,
	completeAgeMs?: number,
): string[] {
	const elapsedBucket = Math.floor(snapshot.elapsedMs / 1000);
	if (cache.elapsedBucket !== elapsedBucket) {
		cache.elapsedBucket = elapsedBucket;
		cache.metricsLine = buildGoalMetricsLine(snapshot, width);
	}
	return [
		"",
		cache.headerLine,
		cache.objLine,
		cache.metricsLine,
		buildGoalHintLine(snapshot, width, continuing, spinner, completeAgeMs),
	];
}

/**
 * Pure renderer. Returns [] when there is no goal, or when a completed goal
 * has lingered past `GOAL_COMPLETE_LINGER_MS` (signalled by `completeAgeMs`).
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
	const cache = seedGoalOverlayCache(snapshot, width, continuing);
	return [
		cache.headerLine,
		cache.objLine,
		cache.metricsLine,
		buildGoalHintLine(snapshot, width, continuing, spinner, completeAgeMs),
	];
}

class GoalOverlayComponent implements Component {
	private session: AgentSession;
	private readonly clock: () => number;
	private completeSeenAt: number | undefined;
	private renderCache: GoalOverlayRenderCache | undefined;

	constructor(session: AgentSession, clock: () => number = () => performance.now()) {
		this.session = session;
		this.clock = clock;
	}

	private clearOverlayState(): void {
		this.completeSeenAt = undefined;
		this.renderCache = undefined;
	}

	setSession(session: AgentSession): void {
		this.session = session;
		this.clearOverlayState();
	}

	invalidate(): void {
		this.clearOverlayState();
	}

	render(width: number): string[] {
		const snapshot = this.session.goalSnapshot();
		if (!snapshot) {
			this.clearOverlayState();
			return [];
		}
		if (snapshot.status === "complete") {
			if (this.completeSeenAt === undefined) this.completeSeenAt = this.clock();
		} else {
			this.completeSeenAt = undefined;
		}
		const completeAgeMs =
			snapshot.status === "complete" && this.completeSeenAt !== undefined
				? this.clock() - this.completeSeenAt
				: undefined;
		if (snapshot.status === "complete" && completeAgeMs !== undefined && completeAgeMs > GOAL_COMPLETE_LINGER_MS) {
			this.renderCache = undefined;
			return [];
		}
		const continuing = this.session.goalIsDriving();
		const spinner = spinnerGlyphAt(this.clock());
		const structuralKey = goalStructuralKey(snapshot);
		const cache = this.renderCache;
		if (cache && cache.structuralKey === structuralKey && cache.width === width && cache.continuing === continuing) {
			return materializeGoalOverlayCache(cache, snapshot, width, continuing, spinner, completeAgeMs);
		}
		this.renderCache = seedGoalOverlayCache(snapshot, width, continuing);
		return materializeGoalOverlayCache(this.renderCache, snapshot, width, continuing, spinner, completeAgeMs);
	}
}

export type GoalOverlay = Component & { setSession(session: AgentSession): void };

export function createGoalOverlay(session: AgentSession, clock?: () => number): GoalOverlay {
	return new GoalOverlayComponent(session, clock);
}
