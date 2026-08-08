/**
 * GoalManager — session-scoped autonomous goal state, modelled after the
 * `@narumitw/pi-goal` extension and Codex's thread-owned goals.
 *
 * Pure state machine: it tracks the objective, status, token usage, iterations
 * and elapsed time, and decides whether the agent should auto-continue. It has
 * NO side effects — the AgentSession owns persistence and turn dispatch, and
 * the interactive mode owns continuation. Clocks/ids are injected for testing.
 */

import {
	formatElapsed as formatElapsedCanonical,
	formatTokens as formatTokensCanonical,
} from "../../utils/format-display.ts";
import { sliceSafe } from "../../utils/surrogate.ts";
import { deriveGoalContract, type GoalContract, renderGoalContract } from "./goal-contract.ts";
import {
	type GoalCompletionReceipt,
	type GoalCompletionReceiptDraft,
	MAX_GOAL_RECEIPT_BYTES,
	receiptPayloadSize,
} from "./goal-receipt.ts";

export type GoalStatus = "active" | "paused" | "budget_limited" | "iteration_limited" | "time_limited" | "complete";
export type GoalLimitType = "tokens" | "iterations" | "time";
export type GoalPauseReason = "manual" | "auto_iteration_cap" | "interrupted" | "gate_retry_limit" | "gate_cancelled";

export interface GoalLimitReason {
	type: GoalLimitType;
	used: number;
	limit: number;
}

export interface GoalGateProgress {
	revision: number;
	passedGateIds: string[];
	/** Definition fingerprints for cache-safe reuse; absent on legacy snapshots, which intentionally miss cache. */
	passedGateFingerprints?: Record<string, string>;
}

export interface GoalGateFailure {
	revision: number;
	gateId: string;
	fingerprint: string;
	attempts: number;
}

/** Per-channel token spend persisted with the goal (K9b / G1). */
export interface TokenSpendSplit {
	main: number;
	subagent: number;
	fusion: number;
}

export interface GoalState {
	id: string;
	objective: string;
	status: GoalStatus;
	/** Optional token budget; when exceeded the goal becomes budget_limited. */
	tokenBudget?: number;
	tokensUsed: number;
	/** Optional ledger split when {@link TokenBudgetGovernor} is active. */
	tokenSpendSplit?: TokenSpendSplit;
	iterations: number;
	/** Total iteration ceiling for the complete Goal lifecycle. */
	maxIterations?: number;
	/** Active-time ceiling for the complete Goal lifecycle. */
	maxActiveMs?: number;
	/** Accumulated time while the Goal was active, excluding pauses. */
	activeElapsedMs?: number;
	/** Start of the current active interval, if active. */
	activeSince?: number;
	limitReason?: GoalLimitReason;
	pauseReason?: GoalPauseReason;
	/** Monotonic workspace-mutation revision for the complete Goal lifecycle. */
	mutationRevision?: number;
	/** Normalized paths changed in the current/most recent Goal lifecycle, capped at 50. */
	mutatedPaths?: string[];
	/** Green gates cached for the current mutation revision. */
	gateProgress?: GoalGateProgress;
	/** Last repeatable gate failure for the current mutation revision. */
	gateFailure?: GoalGateFailure;
	/** Epoch ms when the goal started. */
	startedAt: number;
	/** Epoch ms when the goal completed, if it did. */
	completedAt?: number;
	/**
	 * iterations value captured at the moment goal_complete fired. Lets the
	 * completing turn's recordTurn still count once, while freezing the counters
	 * for every turn AFTER completion.
	 */
	completedAtIteration?: number;
	/** Short summary recorded when goal_complete is called. */
	summary?: string;
	contract?: GoalContract;
	receipt?: GoalCompletionReceipt;
}

export interface GoalSnapshot extends GoalState {
	elapsedMs: number;
}

export interface GoalManagerOptions {
	now?: () => number;
	genId?: () => string;
}

export interface GoalCompleteResult {
	completed: boolean;
	receipt?: GoalCompletionReceipt;
	receiptBytes?: number;
}

export const MAX_OBJECTIVE_CHARS = 4000;
export const DEFAULT_GOAL_TOKEN_BUDGET = 80_000;
export const DEFAULT_GOAL_MAX_ITERATIONS = 12;
export const DEFAULT_GOAL_MAX_ACTIVE_MS = 30 * 60 * 1000;
const MAX_MUTATED_PATHS = 50;

function normalizeMutationPath(path: string): string {
	return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
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

/** Parse an active-time limit such as 30m, 2h, 45s or a positive millisecond count. */
export function parseGoalDuration(raw: string): number | undefined {
	const value = raw.trim().toLowerCase();
	if (/^0$/.test(value)) return undefined;
	if (/^\d+$/.test(value)) {
		const ms = Number(value);
		return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
	}
	const match = /^(\d+)(ms|s|m|h)$/.exec(value);
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
	const unit = match[2];
	let multiplier: number;
	if (unit === "ms") multiplier = 1;
	else if (unit === "s") multiplier = 1_000;
	else if (unit === "m") multiplier = 60_000;
	else multiplier = 60 * 60_000;
	const result = amount * multiplier;
	return Number.isSafeInteger(result) ? result : undefined;
}

/**
 * Thin shim over the canonical formatter in utils/format-display.ts, kept so
 * existing call sites (goal-overlay, activity-line, turn-view) don't churn.
 * The old local dialect (lowercase `m`, no decimal below 10k) is gone on
 * purpose — every UI surface now shares one output.
 */
export function formatTokens(n: number): string {
	return formatTokensCanonical(n);
}

/** Thin shim over utils/format-display.ts (see formatTokens above). The old
 * dialect dropped seconds (`9m`); the canonical one keeps them (`9m14s`). */
export function formatElapsed(ms: number): string {
	return formatElapsedCanonical(ms);
}

export class GoalManager {
	private state: GoalState | undefined;
	private readonly now: () => number;
	private readonly genId: () => string;
	private readonly mutationEventKeys = new Set<string>();

	constructor(options: GoalManagerOptions = {}) {
		this.now = options.now ?? (() => Date.now());
		this.genId = options.genId ?? (() => Math.random().toString(36).slice(2, 10));
	}

	private cloneState(): GoalState | undefined {
		if (!this.state) return undefined;
		return {
			...this.state,
			tokenSpendSplit: this.state.tokenSpendSplit ? { ...this.state.tokenSpendSplit } : undefined,
			limitReason: this.state.limitReason ? { ...this.state.limitReason } : undefined,
			mutatedPaths: this.state.mutatedPaths ? [...this.state.mutatedPaths] : undefined,
			gateProgress: this.state.gateProgress
				? {
						...this.state.gateProgress,
						passedGateIds: [...this.state.gateProgress.passedGateIds],
						passedGateFingerprints: this.state.gateProgress.passedGateFingerprints
							? { ...this.state.gateProgress.passedGateFingerprints }
							: undefined,
					}
				: undefined,
			gateFailure: this.state.gateFailure ? { ...this.state.gateFailure } : undefined,
			contract: this.state.contract
				? { ...this.state.contract, criteria: this.state.contract.criteria.map((criterion) => ({ ...criterion })) }
				: undefined,
			receipt: this.state.receipt ? structuredClone(this.state.receipt) : undefined,
		};
	}

	private accrueActiveTime(now: number): void {
		if (!this.state || this.state.status !== "active" || this.state.activeSince === undefined) return;
		const delta = Math.max(0, now - this.state.activeSince);
		this.state.activeElapsedMs = Math.max(0, (this.state.activeElapsedMs ?? 0) + delta);
		this.state.activeSince = now;
	}

	private evaluateLimits(now: number): void {
		if (!this.state || this.state.status !== "active") return;
		this.accrueActiveTime(now);
		const maxIterations = this.state.maxIterations ?? DEFAULT_GOAL_MAX_ITERATIONS;
		const maxActiveMs = this.state.maxActiveMs ?? DEFAULT_GOAL_MAX_ACTIVE_MS;
		if (this.state.tokenBudget !== undefined && this.state.tokensUsed >= this.state.tokenBudget) {
			this.state.status = "budget_limited";
			this.state.limitReason = { type: "tokens", used: this.state.tokensUsed, limit: this.state.tokenBudget };
			this.state.activeSince = undefined;
		} else if (this.state.iterations >= maxIterations) {
			this.state.status = "iteration_limited";
			this.state.limitReason = { type: "iterations", used: this.state.iterations, limit: maxIterations };
			this.state.activeSince = undefined;
		} else if ((this.state.activeElapsedMs ?? 0) >= maxActiveMs) {
			this.state.status = "time_limited";
			this.state.limitReason = { type: "time", used: this.state.activeElapsedMs ?? 0, limit: maxActiveMs };
			this.state.activeSince = undefined;
		}
	}

	get(): GoalState | undefined {
		return this.cloneState();
	}

	snapshot(): GoalSnapshot | undefined {
		if (!this.state) return undefined;
		this.accrueActiveTime(this.now());
		return { ...this.cloneState()!, elapsedMs: this.now() - this.state.startedAt };
	}

	isActive(): boolean {
		return this.state?.status === "active";
	}

	/** True only when the agent should keep going without user input. */
	shouldAutoContinue(): boolean {
		if (!this.state) return false;
		this.evaluateLimits(this.now());
		return this.state.status === "active";
	}

	start(
		objective: string,
		opts: { tokenBudget?: number; maxIterations?: number; maxActiveMs?: number } = {},
	): GoalSnapshot {
		const now = this.now();
		this.mutationEventKeys.clear();
		const trimmed = sliceSafe(objective.trim(), 0, MAX_OBJECTIVE_CHARS);
		this.state = {
			id: this.genId(),
			objective: trimmed,
			status: "active",
			tokenBudget: opts.tokenBudget ?? DEFAULT_GOAL_TOKEN_BUDGET,
			tokensUsed: 0,
			iterations: 0,
			maxIterations: opts.maxIterations ?? DEFAULT_GOAL_MAX_ITERATIONS,
			maxActiveMs: opts.maxActiveMs ?? DEFAULT_GOAL_MAX_ACTIVE_MS,
			activeElapsedMs: 0,
			activeSince: now,
			startedAt: now,
			contract: deriveGoalContract(trimmed, 1),
		};
		return this.snapshot() as GoalSnapshot;
	}

	edit(objective: string): void {
		if (!this.state) return;
		this.state.objective = sliceSafe(objective.trim(), 0, MAX_OBJECTIVE_CHARS);
		this.state.contract = deriveGoalContract(this.state.objective, (this.state.contract?.revision ?? 0) + 1);
	}

	recordMutation(path?: string, eventKey?: string): void {
		if (!this.state || this.state.status === "complete") return;
		const normalized = path ? normalizeMutationPath(path) : "";
		const key = eventKey?.trim();
		if (key && this.mutationEventKeys.has(key)) return;
		if (key) this.mutationEventKeys.add(key);
		this.state.mutationRevision = (this.state.mutationRevision ?? 0) + 1;
		this.state.gateProgress = undefined;
		this.state.gateFailure = undefined;
		if (normalized) {
			const paths = this.state.mutatedPaths ?? [];
			if (!paths.includes(normalized)) paths.push(normalized);
			this.state.mutatedPaths = paths.slice(-MAX_MUTATED_PATHS);
		}
	}

	pause(reason: GoalPauseReason = "manual"): void {
		if (!this.state || this.state.status === "complete") return;
		this.accrueActiveTime(this.now());
		this.state.status = "paused";
		this.state.activeSince = undefined;
		this.state.pauseReason = reason;
	}

	resume(): void {
		if (!this.state) return;
		const canResume =
			this.state.status === "paused" ||
			(this.state.status === "budget_limited" &&
				this.state.tokenBudget !== undefined &&
				this.state.tokensUsed < this.state.tokenBudget);
		if (!canResume) return;
		this.state.status = "active";
		this.state.pauseReason = undefined;
		this.state.limitReason = undefined;
		this.state.activeSince = this.now();
		this.evaluateLimits(this.now());
	}

	/**
	 * Raise (or set) the active goal's token budget. Re-activates a budget_limited
	 * goal when the new ceiling clears the tokens already spent — the only path to
	 * unwedge a goal that hit its budget (resume() alone can't, by design above).
	 */
	gateProgressFor(revision: number, gateFingerprints: Readonly<Record<string, string>> = {}): string[] {
		if (!this.state || this.state.gateProgress?.revision !== revision) return [];
		const progress = this.state.gateProgress;
		return progress.passedGateIds.filter(
			(id) =>
				progress.passedGateFingerprints?.[id] !== undefined &&
				progress.passedGateFingerprints[id] === gateFingerprints[id],
		);
	}

	setGateProgress(
		revision: number,
		passedGateIds: readonly string[],
		gateFingerprints: Readonly<Record<string, string>> = {},
	): void {
		if (!this.state || this.state.status === "complete") return;
		const uniqueIds = [...new Set(passedGateIds)];
		const passedGateFingerprints = Object.fromEntries(
			uniqueIds.flatMap((id) => (gateFingerprints[id] ? [[id, gateFingerprints[id]]] : [])),
		);
		this.state.gateProgress = {
			revision,
			passedGateIds: uniqueIds,
			...(Object.keys(passedGateFingerprints).length > 0 ? { passedGateFingerprints } : {}),
		};
	}

	recordGateFailure(revision: number, gateId: string, fingerprint: string): GoalGateFailure {
		const previous = this.state?.gateFailure;
		const attempts =
			previous &&
			previous.revision === revision &&
			previous.gateId === gateId &&
			previous.fingerprint === fingerprint
				? previous.attempts + 1
				: 1;
		const failure = { revision, gateId, fingerprint, attempts };
		if (this.state && this.state.status !== "complete") this.state.gateFailure = failure;
		return failure;
	}

	clearGateFailure(): void {
		if (this.state) this.state.gateFailure = undefined;
	}

	setTokenBudget(tokenBudget: number): void {
		if (!this.state || this.state.status === "complete") return;
		this.state.tokenBudget = tokenBudget;
		if (this.state.status === "budget_limited" && this.state.tokensUsed < tokenBudget) {
			this.state.status = "active";
			this.state.limitReason = undefined;
			this.state.activeSince = this.now();
			this.evaluateLimits(this.now());
		}
	}

	setMaxIterations(maxIterations: number): void {
		if (!this.state || this.state.status === "complete" || !Number.isInteger(maxIterations) || maxIterations <= 0)
			return;
		this.state.maxIterations = maxIterations;
		if (this.state.status === "iteration_limited" && this.state.iterations < maxIterations) {
			this.state.status = "active";
			this.state.limitReason = undefined;
			this.state.activeSince = this.now();
			this.evaluateLimits(this.now());
		}
	}

	setMaxActiveMs(maxActiveMs: number): void {
		if (!this.state || this.state.status === "complete" || !Number.isInteger(maxActiveMs) || maxActiveMs <= 0) return;
		this.state.maxActiveMs = maxActiveMs;
		if (this.state.status === "time_limited" && (this.state.activeElapsedMs ?? 0) < maxActiveMs) {
			this.state.status = "active";
			this.state.limitReason = undefined;
			this.state.activeSince = this.now();
			this.evaluateLimits(this.now());
		}
	}

	clear(): void {
		this.mutationEventKeys.clear();
		this.state = undefined;
	}

	complete(summary?: string, receipt?: GoalCompletionReceiptDraft): GoalCompleteResult {
		if (!this.state) return { completed: false };
		const completedAt = this.now();
		this.accrueActiveTime(completedAt);
		const finalizedReceipt: GoalCompletionReceipt | undefined = receipt
			? {
					...receipt,
					usage: {
						tokens: this.state.tokensUsed,
						iterations: this.state.iterations,
						activeMs: this.state.activeElapsedMs ?? 0,
					},
					completedAt,
				}
			: undefined;
		const receiptBytes = finalizedReceipt ? receiptPayloadSize(finalizedReceipt) : undefined;
		if (receiptBytes !== undefined && receiptBytes > MAX_GOAL_RECEIPT_BYTES) {
			return { completed: false, receiptBytes };
		}
		this.state.activeSince = undefined;
		this.state.status = "complete";
		this.state.completedAt = completedAt;
		this.state.completedAtIteration = this.state.iterations;
		if (summary) this.state.summary = sliceSafe(summary.trim(), 0, 1200);
		if (finalizedReceipt) this.state.receipt = finalizedReceipt;
		return { completed: true, receipt: finalizedReceipt };
	}

	reconcileCompletedReceiptUsage(): void {
		if (!this.state?.receipt || this.state.status !== "complete") return;
		this.state.receipt = {
			...this.state.receipt,
			usage: {
				tokens: this.state.tokensUsed,
				iterations: this.state.iterations,
				activeMs: this.state.activeElapsedMs ?? 0,
			},
		};
	}

	/** Bump iteration count without changing token spend (unified governor sets tokens). */
	recordIteration(): void {
		if (!this.state) return;
		if (this.state.status === "complete" && this.state.iterations > (this.state.completedAtIteration ?? -1)) {
			return;
		}
		this.state.iterations += 1;
		this.evaluateLimits(this.now());
	}

	/**
	 * Set cumulative token spend from the unified {@link TokenBudgetGovernor}
	 * (main + subagents + fusion). Re-evaluates budget_limited.
	 */
	syncTokensUsed(total: number, split?: TokenSpendSplit): void {
		if (!this.state) return;
		if (this.state.status === "complete" && this.state.iterations > (this.state.completedAtIteration ?? -1)) {
			return;
		}
		this.state.tokensUsed = Math.max(0, Math.round(total));
		if (split) {
			this.state.tokenSpendSplit = {
				main: Math.max(0, Math.round(split.main)),
				subagent: Math.max(0, Math.round(split.subagent)),
				fusion: Math.max(0, Math.round(split.fusion)),
			};
		}
		this.evaluateLimits(this.now());
	}

	/** Record a finished turn: bumps iterations + token usage, may exhaust budget. */
	recordTurn(tokensDelta: number): void {
		if (!this.state) return;
		if (this.state.status === "complete" && this.state.iterations > (this.state.completedAtIteration ?? -1)) {
			return;
		}
		this.state.iterations += 1;
		this.state.tokensUsed += Math.max(0, Math.round(tokensDelta));
		this.evaluateLimits(this.now());
	}

	/** A turn ended abnormally: pause auto-continuation until the user resumes. */
	onInterrupted(stopReason: string): void {
		if (!this.state || this.state.status !== "active") return;
		if (stopReason === "aborted" || stopReason === "error") {
			this.pause("interrupted");
		}
	}

	/**
	 * Compact statusline string, e.g. "🎯 active 18k/100k" or "🎯 paused".
	 * Static on purpose: the footer appends the driving spinner outside its
	 * render cache so the whole metrics strip is not rebuilt ~12fps.
	 * `continuing` is retained for call-site compatibility and ignored.
	 */
	statusLine(_continuing = false): string {
		const g = this.state;
		if (!g) return "";
		const budgetPart =
			g.tokenBudget !== undefined ? `${formatTokens(g.tokensUsed)}/${formatTokens(g.tokenBudget)}` : undefined;
		switch (g.status) {
			case "active": {
				const body = budgetPart ?? formatElapsed(this.now() - g.startedAt);
				return `🎯 active ${body}`;
			}
			case "paused":
				return "🎯 paused";
			case "budget_limited":
				return `🎯 budget ${budgetPart ?? formatTokens(g.tokensUsed)}`;
			case "iteration_limited":
				return `🎯 iterations ${g.iterations}/${g.maxIterations ?? DEFAULT_GOAL_MAX_ITERATIONS}`;
			case "time_limited":
				return `🎯 time ${formatElapsed(g.activeElapsedMs ?? 0)}/${formatElapsed(g.maxActiveMs ?? DEFAULT_GOAL_MAX_ACTIVE_MS)}`;
			case "complete":
				return "🎯 complete";
		}
	}

	/** Compact, read-only rendering of the persisted completion receipt. */
	receiptText(): string {
		const receipt = this.state?.receipt;
		if (!receipt) return "Receipt unavailable for legacy goal.";
		return [
			`Receipt: ${receipt.criteria.length}/${receipt.criteria.length} criteria · verification ${receipt.verification.status}`,
			...receipt.criteria.map((criterion) => `  [${criterion.id}] ${criterion.outcome} · ${criterion.grounding}`),
		].join("\n");
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
		if (g.status === "paused") lines.push(`   paused (${g.pauseReason ?? "manual"}) — resume with /goal resume`);
		if (g.status === "budget_limited")
			lines.push("   token budget reached — raise it with /goal --tokens <n> (resume alone won't progress)");
		if (g.status === "iteration_limited")
			lines.push(`   iteration limit reached — raise it with /goal --iterations <n> (resume alone won't progress)`);
		if (g.status === "time_limited")
			lines.push(
				`   active-time limit reached — raise it with /goal --time <duration> (resume alone won't progress)`,
			);
		return lines.join("\n");
	}

	/**
	 * True while a goal exists and has not completed — the presence condition of
	 * {@link systemPromptPrefixSection}. Deliberately blind to active vs paused vs
	 * budget_limited: those transitions are frequent (every interrupt pauses), and
	 * flipping the cacheable prefix on each one would cost far more than the block
	 * itself. Only creating the first goal, clearing it, and completing it move
	 * this bit.
	 */
	hasPromptRules(): boolean {
		return this.state !== undefined && this.state.status !== "complete";
	}

	/**
	 * The Codex-like persistence rules — CACHEABLE PREFIX (see
	 * `BuildSystemPromptOptions.goalRulesSection`). Immutable text: the objective
	 * and the live status are emitted separately by
	 * {@link systemPromptSection} in the dynamic suffix. Because this block is
	 * paid once instead of per turn, it can afford to spell out the paused case
	 * rather than being dropped while paused — the status in the `<goal>` line
	 * below is what switches the behavior on and off.
	 */
	systemPromptPrefixSection(): string {
		if (!this.hasPromptRules()) return "";
		return [
			"<goal_rules>",
			"A `<goal>` line further down states this session's overarching objective and its status.",
			"While that status is `active` you are operating in autonomous goal mode:",
			"- Keep working until the goal is fully resolved end-to-end before yielding. Do not stop at a partial result or hand back a plan when you can execute it.",
			"- Treat the current files, command output, and test results as the source of truth — verify, don't assume.",
			"- Do not redefine or narrow the goal into a smaller task. Solve the whole thing.",
			"- Only when every requirement is satisfied and verified requirement-by-requirement, call the `goal_complete` tool with a short summary. Never call it before the work is actually done and checked.",
			"- If you are genuinely blocked and cannot proceed without the user, state exactly what you need and stop.",
			"While it is `paused`, `budget_limited`, `iteration_limited`, or `time_limited` the goal is NOT driving the session: answer the user's current request and do not auto-continue toward the objective.",
			"</goal_rules>",
		].join("\n");
	}

	/**
	 * Dynamic-suffix section: objective + live status, one line.
	 *
	 * The persistence rules moved to {@link systemPromptPrefixSection} (cacheable
	 * prefix) — they never changed, yet were billed at full price on every request
	 * of every turn. What is left here is exactly what mutates.
	 */
	systemPromptSection(): string {
		const g = this.state;
		if (!g || g.status === "complete") return "";
		return renderGoalContract(g.contract ?? deriveGoalContract(g.objective, 1), g.status, g.objective);
	}

	/** Prompt enqueued to drive the next autonomous turn. */
	continuationPrompt(): string {
		return "Continue working toward the goal. If every requirement is complete and verified, call `goal_complete`. Otherwise proceed with the next concrete step — do not stop to ask for confirmation on safe actions.";
	}

	serialize(): GoalState | undefined {
		return this.get();
	}

	restore(data: GoalState | undefined): void {
		if (!data) {
			this.state = undefined;
			return;
		}
		const now = this.now();
		this.mutationEventKeys.clear();
		this.state = {
			...data,
			contract: data.contract ?? deriveGoalContract(data.objective, 1, "legacy-restore"),
			tokenBudget: data.tokenBudget ?? DEFAULT_GOAL_TOKEN_BUDGET,
			maxIterations: data.maxIterations ?? DEFAULT_GOAL_MAX_ITERATIONS,
			maxActiveMs: data.maxActiveMs ?? DEFAULT_GOAL_MAX_ACTIVE_MS,
			activeElapsedMs: data.activeElapsedMs ?? 0,
			activeSince: data.status === "active" ? now : undefined,
		};
		if (this.state.status === "active") this.evaluateLimits(now);
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
