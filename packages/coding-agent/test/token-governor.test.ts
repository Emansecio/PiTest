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

	it("reserves the remaining budget atomically until the subagent settles", () => {
		const governor = new TokenBudgetGovernor();
		governor.setBudget(1_000);
		governor.recordMain(400);

		const first = governor.reserveSubagent(600);
		expect(first.allowed).toBe(true);
		expect(governor.snapshot()).toMatchObject({ reservedSubagentTokens: 600, remaining: 0 });
		expect(governor.reserveSubagent().allowed).toBe(false);

		first.record({ inputTokens: 100, outputTokens: 100, totalTokens: 200, costUsd: 0.12 });
		expect(governor.snapshot()).toMatchObject({
			subagentTokens: 200,
			reservedSubagentTokens: 400,
			costUsd: 0.12,
			subagentCostUsd: 0.12,
			remaining: 0,
		});

		first.release();
		first.release();
		expect(governor.snapshot()).toMatchObject({ reservedSubagentTokens: 0, remaining: 400 });
	});

	it("attributes out-of-order usage to the reservation that reported it", () => {
		const governor = new TokenBudgetGovernor();
		governor.setBudget(8_192);

		const first = governor.reserveSubagent(4_096);
		const second = governor.reserveSubagent(4_096);
		expect(first.allowed).toBe(true);
		expect(second.allowed).toBe(true);

		second.record({ inputTokens: 2_048, outputTokens: 2_048, totalTokens: 4_096, costUsd: 0 });
		second.release();

		expect(governor.snapshot()).toMatchObject({
			subagentTokens: 4_096,
			reservedSubagentTokens: 4_096,
			remaining: 0,
		});
		expect(governor.reserveSubagent(4_096).allowed).toBe(false);

		first.release();
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

	it("aggregates reported costs once across token channels", () => {
		const governor = new TokenBudgetGovernor();
		governor.recordMain(100, 0.1);
		governor.recordSubagent({ inputTokens: 20, outputTokens: 30, totalTokens: 50, costUsd: 0.2 });
		governor.recordFusion(40, 0.3);

		const snap = governor.snapshot();
		expect(snap.costUsd).toBeCloseTo(0.6);
		expect(snap.subagentCostUsd).toBeCloseTo(0.2);
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
