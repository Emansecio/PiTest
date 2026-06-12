import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getCurrentPlanManager,
	PlanManager,
	PlanValidationError,
	setCurrentPlanManager,
	topoOrder,
} from "../src/core/plan/plan-manager.js";
import { createPlanToolDefinition, type PlanToolDetails } from "../src/core/tools/plan.js";

type StepArg = {
	id: string;
	intent: string;
	depends_on?: string[];
	produces?: string;
	verify?: string;
};

async function runPlan(input: {
	op: "propose" | "revise" | "step_done" | "show";
	steps?: StepArg[];
	step_id?: string;
}) {
	const def = createPlanToolDefinition("/tmp");
	// plan ignores signal/onUpdate/ctx; pass placeholders to satisfy the signature.
	const result = await def.execute("test-call", input, undefined, undefined, undefined as never);
	return result as { details: PlanToolDetails; isError?: boolean; content: Array<{ text: string }> };
}

describe("PlanManager (DAG)", () => {
	it("proposes v1 and reports it as current", () => {
		const mgr = new PlanManager();
		const v = mgr.propose([
			{ id: "a", intent: "scaffold" },
			{ id: "b", intent: "wire", dependsOn: ["a"] },
		]);
		expect(v.version).toBe(1);
		expect(mgr.currentVersion()).toBe(1);
		expect(mgr.current()?.steps.map((s) => s.id)).toEqual(["a", "b"]);
		expect(mgr.counts()).toEqual({ done: 0, total: 2 });
	});

	it("revise produces v2 and preserves history", () => {
		const mgr = new PlanManager();
		mgr.propose([{ id: "a", intent: "scaffold" }]);
		const v2 = mgr.revise([
			{ id: "a", intent: "scaffold" },
			{ id: "b", intent: "test", dependsOn: ["a"] },
		]);
		expect(v2.version).toBe(2);
		expect(mgr.currentVersion()).toBe(2);
		expect(mgr.diffFromPrevious()).toContain("+ b");
	});

	it("rejects a cycle in dependsOn", () => {
		const mgr = new PlanManager();
		expect(() =>
			mgr.propose([
				{ id: "a", intent: "x", dependsOn: ["b"] },
				{ id: "b", intent: "y", dependsOn: ["a"] },
			]),
		).toThrow(PlanValidationError);
	});

	it("rejects a self-edge", () => {
		const mgr = new PlanManager();
		expect(() => mgr.propose([{ id: "a", intent: "x", dependsOn: ["a"] }])).toThrow(PlanValidationError);
	});

	it("rejects dependsOn pointing at an unknown id", () => {
		const mgr = new PlanManager();
		expect(() => mgr.propose([{ id: "a", intent: "x", dependsOn: ["ghost"] }])).toThrow(/unknown step id/);
	});

	it("rejects duplicate ids and empty plans", () => {
		const mgr = new PlanManager();
		expect(() =>
			mgr.propose([
				{ id: "a", intent: "x" },
				{ id: "a", intent: "y" },
			]),
		).toThrow(/Duplicate/);
		expect(() => mgr.propose([])).toThrow(/at least one step/);
	});

	it("stepDone mutates the current version in place (no new version)", () => {
		const mgr = new PlanManager();
		mgr.propose([
			{ id: "a", intent: "x" },
			{ id: "b", intent: "y", dependsOn: ["a"] },
		]);
		const done = mgr.stepDone("a");
		expect(done?.status).toBe("done");
		expect(mgr.currentVersion()).toBe(1);
		expect(mgr.counts()).toEqual({ done: 1, total: 2 });
		expect(mgr.stepDone("missing")).toBeUndefined();
	});

	it("topoOrder respects dependencies", () => {
		const v = new PlanManager().propose([
			{ id: "c", intent: "deploy", dependsOn: ["b"] },
			{ id: "a", intent: "build" },
			{ id: "b", intent: "test", dependsOn: ["a"] },
		]);
		const order = topoOrder(v.steps).map((s) => s.id);
		expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
		expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
	});

	it("serializes and restores all versions", () => {
		const mgr = new PlanManager();
		mgr.propose([{ id: "a", intent: "x" }]);
		mgr.revise([
			{ id: "a", intent: "x" },
			{ id: "b", intent: "y", dependsOn: ["a"] },
		]);
		mgr.stepDone("a");
		const data = mgr.serialize();

		const mgr2 = new PlanManager();
		mgr2.restore(data);
		expect(mgr2.currentVersion()).toBe(2);
		expect(mgr2.current()?.steps.find((s) => s.id === "a")?.status).toBe("done");
	});

	it("emits a compaction-survivable system prompt section only when a plan exists", () => {
		const mgr = new PlanManager();
		expect(mgr.systemPromptSection()).toBe("");
		mgr.propose([{ id: "a", intent: "scaffold the module" }]);
		const section = mgr.systemPromptSection();
		expect(section).toContain("<plan>");
		expect(section).toContain("scaffold the module");
		expect(section).toContain("step_done");
	});
});

describe("plan tool", () => {
	beforeEach(() => setCurrentPlanManager(new PlanManager()));
	afterEach(() => setCurrentPlanManager(undefined));

	it("propose → show round-trips the DAG", async () => {
		const proposed = await runPlan({
			op: "propose",
			steps: [
				{ id: "s1", intent: "scaffold", produces: "plan.ts" },
				{ id: "s2", intent: "test", depends_on: ["s1"], verify: "vitest" },
			],
		});
		expect(proposed.isError).toBeFalsy();
		expect(proposed.details.version).toBe(1);
		expect(proposed.details.steps.map((s) => s.id)).toEqual(["s1", "s2"]);

		const shown = await runPlan({ op: "show" });
		expect(shown.details.version).toBe(1);
		expect(shown.content[0].text).toContain("s1");
		expect(shown.content[0].text).toContain("s2");
		expect(shown.content[0].text).toContain("→plan.ts");
	});

	it("revise increments the version and reports a diff", async () => {
		await runPlan({ op: "propose", steps: [{ id: "s1", intent: "scaffold" }] });
		const revised = await runPlan({
			op: "revise",
			steps: [
				{ id: "s1", intent: "scaffold" },
				{ id: "s2", intent: "wire", depends_on: ["s1"] },
			],
		});
		expect(revised.details.version).toBe(2);
		expect(revised.content[0].text).toContain("changes:");
		expect(revised.content[0].text).toContain("+ s2");
		expect(getCurrentPlanManager()?.currentVersion()).toBe(2);
	});

	it("step_done marks the node done and surfaces it in the render", async () => {
		await runPlan({ op: "propose", steps: [{ id: "s1", intent: "scaffold" }] });
		const done = await runPlan({ op: "step_done", step_id: "s1" });
		expect(done.isError).toBeFalsy();
		expect(done.details.steps.find((s) => s.id === "s1")?.status).toBe("done");
		expect(done.content[0].text).toContain("(1/1 done)");
	});

	it("step_done on a missing id is an error", async () => {
		await runPlan({ op: "propose", steps: [{ id: "s1", intent: "scaffold" }] });
		const res = await runPlan({ op: "step_done", step_id: "ghost" });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/No step with id ghost/);
	});

	it("propose with a cycle is a clean error, not a throw", async () => {
		const res = await runPlan({
			op: "propose",
			steps: [
				{ id: "a", intent: "x", depends_on: ["b"] },
				{ id: "b", intent: "y", depends_on: ["a"] },
			],
		});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/cycle/i);
		expect(getCurrentPlanManager()?.isEmpty()).toBe(true);
	});

	it("propose with a dangling depends_on is a clean error", async () => {
		const res = await runPlan({
			op: "propose",
			steps: [{ id: "a", intent: "x", depends_on: ["ghost"] }],
		});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/unknown step id/);
	});

	it("show on an empty plan guides toward propose", async () => {
		const res = await runPlan({ op: "show" });
		expect(res.isError).toBeFalsy();
		expect(res.content[0].text).toMatch(/No plan yet/);
		expect(res.details.version).toBe(0);
	});
});
