import { describe, expect, it } from "vitest";
import { GoalManager } from "../src/core/goal/goal-manager.ts";
import { TokenBudgetGovernor } from "../src/core/token-governor.ts";

describe("TokenBudgetGovernor", () => {
	it("aggregates main and subagent spend into goal tokensUsed", () => {
		const goal = new GoalManager();
		const governor = new TokenBudgetGovernor();
		governor.bindGoal(goal);
		goal.start("ship it", { tokenBudget: 10_000 });
		governor.setBudget(10_000);

		governor.recordMain(3000);
		goal.recordIteration();
		expect(goal.get()?.tokensUsed).toBe(3000);

		governor.recordSubagent({ inputTokens: 500, outputTokens: 500, totalTokens: 1000, costUsd: 0 });
		expect(goal.get()?.tokensUsed).toBe(4000);
		expect(governor.snapshot().subagentTokens).toBe(1000);
	});

	it("blocks spawn when budget is exhausted", () => {
		const goal = new GoalManager();
		const governor = new TokenBudgetGovernor();
		governor.bindGoal(goal);
		goal.start("x", { tokenBudget: 1000 });
		governor.setBudget(1000);
		governor.recordMain(1100);
		goal.recordIteration();

		expect(governor.evaluateSpawn().allowed).toBe(false);
		expect(goal.get()?.status).toBe("budget_limited");
	});

	it("allows spawn when no budget is set", () => {
		const governor = new TokenBudgetGovernor();
		governor.recordMain(50_000);
		expect(governor.evaluateSpawn().allowed).toBe(true);
	});

	it("records fusion spend separately and includes it in totalSpent", () => {
		const goal = new GoalManager();
		const governor = new TokenBudgetGovernor();
		governor.bindGoal(goal);
		goal.start("fusion turn", { tokenBudget: 50_000 });
		governor.setBudget(50_000);
		governor.recordMain(1000);
		governor.recordFusion(2500);
		expect(governor.snapshot().fusionTokens).toBe(2500);
		expect(governor.totalSpent()).toBe(3500);
		expect(goal.get()?.tokensUsed).toBe(3500);
	});

	it("records gearbox spend as a subset of main — excluded from totalSpent and the persisted split (P8b)", () => {
		const goal = new GoalManager();
		const governor = new TokenBudgetGovernor();
		governor.bindGoal(goal);
		goal.start("gearbox turn", { tokenBudget: 50_000 });
		governor.setBudget(50_000);
		governor.recordMain(4000);
		governor.recordGearbox(1500); // subset of the 4000 already counted as main

		const snap = governor.snapshot();
		expect(snap.gearboxTokens).toBe(1500);
		expect(snap.mainTokens).toBe(4000);
		// Not double-counted into the budget-driving total…
		expect(snap.totalSpent).toBe(4000);
		expect(goal.get()?.tokensUsed).toBe(4000);
		// …and not persisted into the goal spend split (stays the 3 canonical channels).
		expect(goal.get()?.tokenSpendSplit).toEqual({ main: 4000, subagent: 0, fusion: 0 });

		governor.reset();
		expect(governor.snapshot().gearboxTokens).toBe(0);
	});

	it("persists and restores token spend split on reload", () => {
		const goal = new GoalManager();
		const governor = new TokenBudgetGovernor();
		governor.bindGoal(goal);
		goal.start("reload", { tokenBudget: 20_000 });
		governor.setBudget(20_000);
		governor.recordMain(3000);
		governor.recordSubagent({ inputTokens: 400, outputTokens: 600, totalTokens: 1000, costUsd: 0 });
		governor.recordFusion(500);
		expect(goal.get()?.tokenSpendSplit).toEqual({ main: 3000, subagent: 1000, fusion: 500 });

		const persisted = goal.serialize();
		const goal2 = new GoalManager();
		const governor2 = new TokenBudgetGovernor();
		goal2.restore(persisted);
		governor2.restoreSpend(persisted!.tokensUsed, persisted!.tokenBudget, persisted!.tokenSpendSplit);
		expect(governor2.snapshot()).toMatchObject({
			mainTokens: 3000,
			subagentTokens: 1000,
			fusionTokens: 500,
			totalSpent: 4500,
		});
	});
});
