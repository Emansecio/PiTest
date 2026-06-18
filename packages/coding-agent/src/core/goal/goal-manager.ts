/**
 * GoalManager — session-scoped autonomous goal state, modelled after the
 * `@narumitw/pi-goal` extension and Codex's thread-owned goals.
 *
 * Pure state machine: it tracks the objective, status, token usage, iterations
 * and elapsed time, and decides whether the agent should auto-continue. It has
 * NO side effects — the AgentSession owns persistence and turn dispatch, and
 * the interactive mode owns continuation. Clocks/ids are injected for testing.
 */

import { sliceSafe } from "../../utils/surrogate.ts";

export type GoalStatus = "active" | "paused" | "budget_limited" | "complete";

export interface GoalState {
	id: string;
	objective: string;
	status: GoalStatus;
	/** Optional token budget; when exceeded the goal becomes budget_limited. */
	tokenBudget?: number;
	tokensUsed: number;
	iterations: number;
	/** Epoch ms when the goal started. */
	startedAt: number;
	/** Epoch ms when the goal completed, if it did. */
	completedAt?: number;
	/** Short summary recorded when goal_complete is called. */
	summary?: string;
}

export interface GoalSnapshot extends GoalState {
	elapsedMs: number;
}

export interface GoalManagerOptions {
	now?: () => number;
	genId?: () => string;
}

export const MAX_OBJECTIVE_CHARS = 4000;

/** Braille spinner frames cycled in the statusline while a goal is being driven. */
export const GOAL_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;

/** Time-based spinner frame so the indicator animates across footer renders. */
function spinnerFrame(nowMs: number): string {
	const idx = Math.floor(nowMs / SPINNER_INTERVAL_MS) % GOAL_SPINNER_FRAMES.length;
	return GOAL_SPINNER_FRAMES[idx] ?? GOAL_SPINNER_FRAMES[0];
}

/** Parse a token budget string like "100000", "100k" or "1.5m". */
export function parseTokenBudget(raw: string): number | undefined {
	const s = raw.trim().toLowerCase();
	const m = /^(\d+(?:\.\d+)?)([km])?$/.exec(s);
	if (!m) return undefined;
	const n = Number.parseFloat(m[1] ?? "");
	if (!Number.isFinite(n) || n <= 0) return undefined;
	const mult = m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1;
	return Math.round(n * mult);
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}m`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const totalMin = Math.floor(totalSec / 60);
	if (totalMin < 60) return `${totalMin}m`;
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return m > 0 ? `${h}h${m}m` : `${h}h`;
}

export class GoalManager {
	private state: GoalState | undefined;
	private readonly now: () => number;
	private readonly genId: () => string;

	constructor(options: GoalManagerOptions = {}) {
		this.now = options.now ?? (() => Date.now());
		this.genId = options.genId ?? (() => Math.random().toString(36).slice(2, 10));
	}

	get(): GoalState | undefined {
		return this.state ? { ...this.state } : undefined;
	}

	snapshot(): GoalSnapshot | undefined {
		if (!this.state) return undefined;
		return { ...this.state, elapsedMs: this.now() - this.state.startedAt };
	}

	isActive(): boolean {
		return this.state?.status === "active";
	}

	/** True only when the agent should keep going without user input. */
	shouldAutoContinue(): boolean {
		return this.state?.status === "active";
	}

	start(objective: string, opts: { tokenBudget?: number }): GoalSnapshot {
		const trimmed = sliceSafe(objective.trim(), 0, MAX_OBJECTIVE_CHARS);
		this.state = {
			id: this.genId(),
			objective: trimmed,
			status: "active",
			tokenBudget: opts.tokenBudget,
			tokensUsed: 0,
			iterations: 0,
			startedAt: this.now(),
		};
		return this.snapshot() as GoalSnapshot;
	}

	edit(objective: string): void {
		if (!this.state) return;
		this.state.objective = sliceSafe(objective.trim(), 0, MAX_OBJECTIVE_CHARS);
	}

	pause(): void {
		if (this.state && this.state.status !== "complete") this.state.status = "paused";
	}

	resume(): void {
		if (!this.state) return;
		if (this.state.status === "paused") {
			this.state.status = "active";
			return;
		}
		// budget_limited: only re-activate when there's headroom. Resuming a goal
		// whose tokensUsed already meets the budget would re-trip budget_limited on
		// the very next recordTurn (it yields ~1 turn then wedges). The user must
		// raise the cap via setTokenBudget (/goal --tokens <n>) to make progress.
		if (this.state.status === "budget_limited") {
			if (this.state.tokenBudget === undefined || this.state.tokensUsed < this.state.tokenBudget) {
				this.state.status = "active";
			}
		}
	}

	/**
	 * Raise (or set) the active goal's token budget. Re-activates a budget_limited
	 * goal when the new ceiling clears the tokens already spent — the only path to
	 * unwedge a goal that hit its budget (resume() alone can't, by design above).
	 */
	setTokenBudget(tokenBudget: number): void {
		if (!this.state || this.state.status === "complete") return;
		this.state.tokenBudget = tokenBudget;
		if (this.state.status === "budget_limited" && this.state.tokensUsed < tokenBudget) {
			this.state.status = "active";
		}
	}

	clear(): void {
		this.state = undefined;
	}

	complete(summary?: string): void {
		if (!this.state) return;
		this.state.status = "complete";
		this.state.completedAt = this.now();
		if (summary) this.state.summary = summary.trim();
	}

	/** Record a finished turn: bumps iterations + token usage, may exhaust budget. */
	recordTurn(tokensDelta: number): void {
		if (!this.state) return;
		this.state.iterations += 1;
		this.state.tokensUsed += Math.max(0, Math.round(tokensDelta));
		if (
			this.state.status === "active" &&
			this.state.tokenBudget !== undefined &&
			this.state.tokensUsed >= this.state.tokenBudget
		) {
			this.state.status = "budget_limited";
		}
	}

	/** A turn ended abnormally: pause auto-continuation until the user resumes. */
	onInterrupted(stopReason: string): void {
		if (!this.state || this.state.status !== "active") return;
		if (stopReason === "aborted" || stopReason === "error") {
			this.state.status = "paused";
		}
	}

	/**
	 * Compact statusline string, e.g. "🎯 active 18k/100k ⠹" or "🎯 paused".
	 * `continuing` appends an animated spinner when the agent is actively driving
	 * the goal (streaming or auto-continuing) vs. an active goal that is idle.
	 */
	statusLine(continuing = false): string {
		const g = this.state;
		if (!g) return "";
		const budgetPart =
			g.tokenBudget !== undefined ? `${formatTokens(g.tokensUsed)}/${formatTokens(g.tokenBudget)}` : undefined;
		switch (g.status) {
			case "active": {
				const body = budgetPart ?? formatElapsed(this.now() - g.startedAt);
				return `🎯 active ${body}${continuing ? ` ${spinnerFrame(this.now())}` : ""}`;
			}
			case "paused":
				return "🎯 paused";
			case "budget_limited":
				return `🎯 budget ${budgetPart ?? formatTokens(g.tokensUsed)}`;
			case "complete":
				return "🎯 complete";
		}
	}

	/** Human-readable multi-line summary for `/goal` status. */
	summaryText(): string {
		const g = this.snapshot();
		if (!g) return "No active goal. Start one with /goal <objective>.";
		const lines = [
			`🎯 Goal (${g.status}): ${g.objective}`,
			`   iterations: ${g.iterations} · elapsed: ${formatElapsed(g.elapsedMs)} · tokens: ${formatTokens(g.tokensUsed)}${
				g.tokenBudget !== undefined ? `/${formatTokens(g.tokenBudget)}` : ""
			}`,
		];
		if (g.status === "paused") lines.push("   paused — resume with /goal resume");
		if (g.status === "budget_limited")
			lines.push("   token budget reached — raise it with /goal --tokens <n> (resume alone won't progress)");
		return lines.join("\n");
	}

	/** The Codex-like persistence section injected into the system prompt. */
	systemPromptSection(): string {
		const g = this.state;
		if (!g || g.status === "complete") return "";
		// While paused or budget-limited the agent is NOT auto-driving the goal, so
		// the full persistence boilerplate ("Keep working until…", goal_complete
		// instructions) is dead weight billed every turn on the un-cached suffix.
		// statusLine/summaryText already surface the paused goal to the user; keep
		// only a one-line objective reminder here.
		if (g.status !== "active") {
			return `<goal>Goal (${g.status}): ${g.objective}</goal>`;
		}
		return [
			"<goal>",
			"You are operating in autonomous goal mode. Your overarching goal for this session is:",
			"",
			g.objective,
			"",
			"Persistence rules:",
			"- Keep working until the goal is fully resolved end-to-end before yielding. Do not stop at a partial result or hand back a plan when you can execute it.",
			"- Treat the current files, command output, and test results as the source of truth — verify, don't assume.",
			"- Do not redefine or narrow the goal into a smaller task. Solve the whole thing.",
			"- Only when every requirement is satisfied and verified requirement-by-requirement, call the `goal_complete` tool with a short summary. Never call it before the work is actually done and checked.",
			"- If you are genuinely blocked and cannot proceed without the user, state exactly what you need and stop.",
			"</goal>",
		].join("\n");
	}

	/** Prompt enqueued to drive the next autonomous turn. */
	continuationPrompt(): string {
		return "Continue working toward the goal. If every requirement is complete and verified, call `goal_complete`. Otherwise proceed with the next concrete step — do not stop to ask for confirmation on safe actions.";
	}

	serialize(): GoalState | undefined {
		return this.get();
	}

	restore(data: GoalState | undefined): void {
		this.state = data ? { ...data } : undefined;
	}
}

// ---------------------------------------------------------------------------
// Module-level "current session" registry, mirroring user-input-bus /
// preview-queue. The goal_complete tool and the /goal command reach the active
// manager through this without per-call plumbing.
// ---------------------------------------------------------------------------

let currentGoalManager: GoalManager | undefined;

export function setCurrentGoalManager(mgr: GoalManager | undefined): void {
	currentGoalManager = mgr;
}

export function getCurrentGoalManager(): GoalManager | undefined {
	return currentGoalManager;
}
