/**
 * Unified session token budget ledger (K7 / G1).
 *
 * Aggregates main-agent turns and subagent usage into one spend counter that
 * drives goal budget_limited. Subagent spawn is gated when the budget is exhausted.
 */

import type { SubagentUsage } from "./coordinator/types.ts";
import type { GoalManager } from "./goal/goal-manager.ts";

export interface TokenBudgetSnapshot {
	mainTokens: number;
	subagentTokens: number;
	fusionTokens: number;
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
	private budgetLimit: number | undefined;
	private goalManager: GoalManager | undefined;

	bindGoal(manager: GoalManager | undefined): void {
		this.goalManager = manager;
	}

	reset(): void {
		this.mainTokens = 0;
		this.subagentTokens = 0;
		this.fusionTokens = 0;
		this.budgetLimit = undefined;
	}

	setBudget(limit: number | undefined): void {
		this.budgetLimit = limit;
		this.flushToGoal();
	}

	/** Rehydrate spend after session reload (subagent split is not persisted). */
	restoreSpend(totalFromGoal: number, budget?: number): void {
		this.mainTokens = Math.max(0, Math.round(totalFromGoal));
		this.subagentTokens = 0;
		this.fusionTokens = 0;
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
		this.goalManager.syncTokensUsed(this.totalSpent());
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
