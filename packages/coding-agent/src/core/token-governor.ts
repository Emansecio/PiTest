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

export class TokenBudgetGovernor {
	private mainTokens = 0;
	private subagentTokens = 0;
	private fusionTokens = 0;
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
		this.budgetLimit = budget;
	}

	recordMain(delta: number): void {
		if (delta <= 0) return;
		this.mainTokens += Math.round(delta);
		this.flushToGoal();
	}

	recordSubagent(usage: SubagentUsage | undefined): void {
		if (!usage || usage.totalTokens <= 0) return;
		this.subagentTokens += Math.round(usage.totalTokens);
		this.flushToGoal();
	}

	recordFusion(delta: number): void {
		if (delta <= 0) return;
		this.fusionTokens += Math.round(delta);
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

	snapshot(): TokenBudgetSnapshot {
		const totalSpent = this.totalSpent();
		const remaining = this.budgetLimit !== undefined ? Math.max(0, this.budgetLimit - totalSpent) : undefined;
		return {
			mainTokens: this.mainTokens,
			subagentTokens: this.subagentTokens,
			fusionTokens: this.fusionTokens,
			gearboxTokens: this.gearboxTokens,
			totalSpent,
			budgetLimit: this.budgetLimit,
			remaining,
		};
	}

	evaluateSpawn(): SpawnBudgetDecision {
		if (this.budgetLimit === undefined) return { allowed: true };
		const spent = this.totalSpent();
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
