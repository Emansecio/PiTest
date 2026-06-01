import { afterEach, describe, expect, it } from "vitest";
import { GoalManager, setCurrentGoalManager } from "../src/core/goal/goal-manager.js";
import { createGoalCompleteToolDefinition, type GoalCompleteToolDetails } from "../src/core/tools/goal-complete.js";

afterEach(() => setCurrentGoalManager(undefined));

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => c.text ?? "").join("");
}

// ToolDefinition.execute takes (toolCallId, params, signal, onUpdate, ctx).
function runExec(def: { execute: (...args: any[]) => any }, input: unknown) {
	return def.execute("call", input, undefined, undefined, undefined);
}

describe("goal_complete tool", () => {
	it("is a no-op when no goal is active", async () => {
		setCurrentGoalManager(undefined);
		const def = createGoalCompleteToolDefinition("/tmp");
		const res = await runExec(def, {});
		expect((res.details as GoalCompleteToolDetails).completed).toBe(false);
		expect(text(res)).toBe("No active goal to complete.");
	});

	it("marks the active goal complete and stops auto-continuation", async () => {
		const mgr = new GoalManager();
		mgr.start("Ship the feature", {});
		setCurrentGoalManager(mgr);
		expect(mgr.shouldAutoContinue()).toBe(true);

		const def = createGoalCompleteToolDefinition("/tmp");
		const res = await runExec(def, { summary: "all tests pass" });
		const details = res.details as GoalCompleteToolDetails;
		expect(details.completed).toBe(true);
		expect(details.objective).toBe("Ship the feature");
		expect(text(res)).toContain("Goal complete: Ship the feature");
		expect(text(res)).toContain("all tests pass");
		expect(mgr.get()?.status).toBe("complete");
		expect(mgr.shouldAutoContinue()).toBe(false);
	});

	it("does not re-complete an already complete goal", async () => {
		const mgr = new GoalManager();
		mgr.start("x", {});
		mgr.complete("first");
		setCurrentGoalManager(mgr);
		const def = createGoalCompleteToolDefinition("/tmp");
		const res = await runExec(def, {});
		expect((res.details as GoalCompleteToolDetails).completed).toBe(false);
	});
});
