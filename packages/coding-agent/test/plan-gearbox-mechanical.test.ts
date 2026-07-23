/**
 * P8b — the planner's `mechanical` marking must survive schema → runtime, and
 * PlanManager must expose the ready-step view the gearbox drives off. The swap
 * behaviour itself lives in model-gearbox.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanManager, setCurrentPlanManager } from "../src/core/plan/plan-manager.ts";
import { createPlanToolDefinition, type PlanToolDetails } from "../src/core/tools/plan.ts";

async function runPlan(input: {
	op: "propose" | "revise" | "step_done" | "show";
	steps?: Array<{ id: string; intent: string; depends_on?: string[]; verify?: string; mechanical?: boolean }>;
	step_id?: string;
}) {
	const def = createPlanToolDefinition("/tmp");
	const result = await def.execute("test-call", input, undefined, undefined, undefined as never);
	return result as { details: PlanToolDetails; isError?: boolean; content: Array<{ text: string }> };
}

describe("plan tool — mechanical marking (P8b)", () => {
	beforeEach(() => setCurrentPlanManager(new PlanManager()));
	afterEach(() => setCurrentPlanManager(undefined));

	it("carries `mechanical: true` from the wire schema into the runtime PlanStep", async () => {
		const res = await runPlan({
			op: "propose",
			steps: [
				{ id: "s1", intent: "rote edit", verify: "npm test", mechanical: true },
				{ id: "s2", intent: "design work" }, // unmarked
			],
		});
		expect(res.details.steps.find((s) => s.id === "s1")?.mechanical).toBe(true);
		// Unmarked normalizes to undefined, never `false`.
		expect(res.details.steps.find((s) => s.id === "s2")?.mechanical).toBeUndefined();
	});

	it("renders a dense ⚙ marker for mechanical steps", async () => {
		await runPlan({ op: "propose", steps: [{ id: "s1", intent: "rote", verify: "t", mechanical: true }] });
		const shown = await runPlan({ op: "show" });
		expect(shown.content[0].text).toContain("⚙");
	});
});

describe("PlanManager.readySteps (P8b)", () => {
	it("returns pending steps whose deps are all done, carrying mechanical/verifyCmd", () => {
		const mgr = new PlanManager();
		mgr.propose([
			{ id: "s1", intent: "first" },
			{ id: "s2", intent: "rote", dependsOn: ["s1"], verifyCmd: "npm test", mechanical: true },
		]);
		// Only s1 is ready initially (s2 blocked on s1).
		expect(mgr.readySteps().map((s) => s.id)).toEqual(["s1"]);

		mgr.stepDone("s1");
		const ready = mgr.readySteps();
		expect(ready.map((s) => s.id)).toEqual(["s2"]);
		expect(ready[0]?.mechanical).toBe(true);
		expect(ready[0]?.verifyCmd).toBe("npm test");
	});

	it("is empty once every step is done", () => {
		const mgr = new PlanManager();
		mgr.propose([{ id: "s1", intent: "only" }]);
		mgr.stepDone("s1");
		expect(mgr.readySteps()).toEqual([]);
	});

	it("survives a serialize/restore round-trip with the mechanical flag intact", () => {
		const mgr = new PlanManager();
		mgr.propose([{ id: "s1", intent: "rote", verifyCmd: "t", mechanical: true }]);
		const restored = new PlanManager();
		restored.restore(mgr.serialize());
		expect(restored.current()?.steps[0]?.mechanical).toBe(true);
	});
});
