/**
 * Unified session token budget ledger (K7 / G1).
 *
 * Aggregates main-agent turns and subagent usage into one spend counter that
 * drives goal budget_limited. Subagent spawn is gated when the budget is exhausted.
 */

import type { SubagentUsage } from "./coordinator/types.ts";
import type { GoalManager, TokenSpendSplit } from "./goal/goal-manager.ts";

export interface TokenBudgetSnapshot {
	mainTokens: number;
	subagentTokens: number;
	fusionTokens: number;
	/** USD cost reported for the tracked token channels. */
	costUsd: number;
	/** Portion of {@link costUsd} reported by subagents. */
	subagentCostUsd: number;
	/** Tokens conservatively held by in-flight subagent orchestration. */
	reservedSubagentTokens: number;
	/**
	 * Tokens the main agent spent while the model gearbox (P8b) held the session
	 * on the `smol` role — a SUBSET view of {@link mainTokens}, so it is
	 * deliberately NOT added into {@link totalSpent} (that would double-count).
	 * Session-live and observational: not persisted in the goal spend split.
	 */
	gearboxTokens: number;
	totalSpent: number;
	budgetLimit?: number;
	remaining?: number;
}

export interface SpawnBudgetDecision {
	allowed: boolean;
	reason?: string;
}

/** A conservative hold released when its subagent orchestration settles. */
export interface SubagentTokenReservation extends SpawnBudgetDecision {
	/** Record actual usage against this reservation, even when runs settle out of order. */
	record(usage: SubagentUsage | undefined): void;
	release(): void;
}

/** Default conservative hold per live child; bounded fan-out still permits concurrency. */
const DEFAULT_SUBAGENT_RESERVATION_TOKENS = 4096;

export class TokenBudgetGovernor {
	private mainTokens = 0;
	private subagentTokens = 0;
	private fusionTokens = 0;
	private mainCostUsd = 0;
	private subagentCostUsd = 0;
	private fusionCostUsd = 0;
	private reservedSubagentTokens = 0;
	private readonly reservations = new Map<number, number>();
	private nextReservationId = 1;
	/** Subset of mainTokens spent while gearbox-downshifted (see snapshot doc). */
	private gearboxTokens = 0;
	private budgetLimit: number | undefined;
	private goalManager: GoalManager | undefined;

	bindGoal(manager: GoalManager | undefined): void {
		this.goalManager = manager;
	}

	reset(): void {
		this.mainTokens = 0;
		this.subagentTokens = 0;
		this.fusionTokens = 0;
		this.mainCostUsd = 0;
		this.subagentCostUsd = 0;
		this.fusionCostUsd = 0;
		this.reservedSubagentTokens = 0;
		this.reservations.clear();
		this.gearboxTokens = 0;
		this.budgetLimit = undefined;
	}

	setBudget(limit: number | undefined): void {
		this.budgetLimit = limit;
		this.flushToGoal();
	}

	/** Rehydrate spend after session reload; uses persisted split when present. */
	restoreSpend(totalFromGoal: number, budget?: number, split?: TokenSpendSplit): void {
		if (split) {
			this.mainTokens = Math.max(0, Math.round(split.main));
			this.subagentTokens = Math.max(0, Math.round(split.subagent));
			this.fusionTokens = Math.max(0, Math.round(split.fusion));
		} else {
			this.mainTokens = Math.max(0, Math.round(totalFromGoal));
			this.subagentTokens = 0;
			this.fusionTokens = 0;
		}
		// gearboxTokens is a session-live subset counter — not persisted, so a reload
		// starts it fresh rather than reconstructing it from the goal split.
		this.gearboxTokens = 0;
		this.mainCostUsd = 0;
		this.subagentCostUsd = 0;
		this.fusionCostUsd = 0;
		this.reservedSubagentTokens = 0;
		this.reservations.clear();
		this.budgetLimit = budget;
	}

	recordMain(delta: number, costUsd = 0): void {
		const tokens = positiveRounded(delta);
		const cost = nonnegativeFinite(costUsd);
		if (tokens === 0 && cost === 0) return;
		this.mainTokens += tokens;
		this.mainCostUsd += cost;
		this.flushToGoal();
	}

	recordSubagent(usage: SubagentUsage | undefined): void {
		this.recordSubagentUsage(usage);
	}

	private recordSubagentUsage(usage: SubagentUsage | undefined, reservationId?: number): void {
		if (!usage) return;
		const tokens = positiveRounded(usage.totalTokens);
		const cost = nonnegativeFinite(usage.costUsd);
		if (tokens === 0 && cost === 0) return;
		this.subagentTokens += tokens;
		this.subagentCostUsd += cost;
		if (reservationId !== undefined) this.consumeReservation(reservationId, tokens);
		this.flushToGoal();
	}

	recordFusion(delta: number, costUsd = 0): void {
		const tokens = positiveRounded(delta);
		const cost = nonnegativeFinite(costUsd);
		if (tokens === 0 && cost === 0) return;
		this.fusionTokens += tokens;
		this.fusionCostUsd += cost;
		this.flushToGoal();
	}

	/**
	 * Attribute main-agent spend that happened while the model gearbox held the
	 * `smol` role. Mirrors recordMain/Subagent/Fusion, but this is a SUBSET of the
	 * main spend already counted by recordMain (the caller records the same delta
	 * here in addition), so it never enters totalSpent and does not change the goal
	 * budget — flushToGoal is called only to keep the mirror faithful/idempotent.
	 */
	recordGearbox(delta: number): void {
		if (delta <= 0) return;
		this.gearboxTokens += Math.round(delta);
		this.flushToGoal();
	}

	totalSpent(): number {
		return this.mainTokens + this.subagentTokens + this.fusionTokens;
	}

	/** Total actual spend plus conservative in-flight subagent reservations. */
	committedTokens(): number {
		return this.totalSpent() + this.reservedSubagentTokens;
	}

	/** Aggregate USD cost known to the governor. */
	totalCostUsd(): number {
		return this.mainCostUsd + this.subagentCostUsd + this.fusionCostUsd;
	}

	snapshot(): TokenBudgetSnapshot {
		const totalSpent = this.totalSpent();
		const remaining =
			this.budgetLimit !== undefined ? Math.max(0, this.budgetLimit - this.committedTokens()) : undefined;
		return {
			mainTokens: this.mainTokens,
			subagentTokens: this.subagentTokens,
			fusionTokens: this.fusionTokens,
			costUsd: this.totalCostUsd(),
			subagentCostUsd: this.subagentCostUsd,
			reservedSubagentTokens: this.reservedSubagentTokens,
			gearboxTokens: this.gearboxTokens,
			totalSpent,
			budgetLimit: this.budgetLimit,
			remaining,
		};
	}

	evaluateSpawn(): SpawnBudgetDecision {
		if (this.budgetLimit === undefined) return { allowed: true };
		const spent = this.committedTokens();
		if (spent >= this.budgetLimit) {
			return {
				allowed: false,
				reason:
					`Goal token budget exhausted (${formatTok(spent)}/${formatTok(this.budgetLimit)}). ` +
					"Raise with /goal --tokens <n> before spawning subagents.",
			};
		}
		return { allowed: true };
	}

	/**
	 * Atomically hold a conservative estimate for one coordinator operation. This
	 * closes the concurrent-spawn race without serializing every child against the
	 * entire remaining goal budget. Reported usage consumes the hold as it arrives
	 * and `release()` refunds only the unused portion.
	 */
	reserveSubagent(estimatedTokens = DEFAULT_SUBAGENT_RESERVATION_TOKENS): SubagentTokenReservation {
		const gate = this.evaluateSpawn();
		if (!gate.allowed || this.budgetLimit === undefined) {
			return {
				...gate,
				record: (usage) => {
					if (gate.allowed) this.recordSubagent(usage);
				},
				release: () => {},
			};
		}
		const remaining = Math.max(0, this.budgetLimit - this.committedTokens());
		const tokens = Math.min(Math.max(0, Math.round(estimatedTokens)), remaining);
		if (tokens <= 0 || this.committedTokens() + tokens > this.budgetLimit) {
			return {
				allowed: false,
				reason:
					`Goal token budget exhausted (${formatTok(this.committedTokens())}/${formatTok(this.budgetLimit)}). ` +
					"Raise with /goal --tokens <n> before spawning subagents.",
				record: () => {},
				release: () => {},
			};
		}
		const id = this.nextReservationId++;
		this.reservations.set(id, tokens);
		this.reservedSubagentTokens += tokens;
		let released = false;
		return {
			allowed: true,
			record: (usage) => this.recordSubagentUsage(usage, id),
			release: () => {
				if (released) return;
				released = true;
				this.releaseReservation(id);
			},
		};
	}

	private consumeReservation(id: number, tokens: number): void {
		const held = this.reservations.get(id);
		if (held === undefined) return;
		const consumed = Math.min(held, tokens);
		const next = held - consumed;
		this.reservedSubagentTokens -= consumed;
		if (next === 0) this.reservations.delete(id);
		else this.reservations.set(id, next);
	}

	private releaseReservation(id: number): void {
		const held = this.reservations.get(id);
		if (held === undefined) return;
		this.reservations.delete(id);
		this.reservedSubagentTokens -= held;
	}

	private flushToGoal(): void {
		if (!this.goalManager) return;
		const snap = this.snapshot();
		this.goalManager.syncTokensUsed(snap.totalSpent, {
			main: snap.mainTokens,
			subagent: snap.subagentTokens,
			fusion: snap.fusionTokens,
		});
	}
}

function nonnegativeFinite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function positiveRounded(value: unknown): number {
	return Math.round(nonnegativeFinite(value));
}

function formatTok(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}m`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

let currentGovernor: TokenBudgetGovernor | undefined;

export function setCurrentTokenGovernor(governor: TokenBudgetGovernor | undefined): void {
	currentGovernor = governor;
}

export function getCurrentTokenGovernor(): TokenBudgetGovernor | undefined {
	return currentGovernor;
}
