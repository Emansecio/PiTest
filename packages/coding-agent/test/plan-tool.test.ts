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
	brief?: string;
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
		expect(section).toContain("executing");
	});

	it("uses planning wording under permission mode plan", () => {
		const mgr = new PlanManager();
		mgr.propose([{ id: "a", intent: "research" }]);
		const section = mgr.systemPromptSection({ permissionMode: "plan" });
		expect(section).toContain("refining");
		expect(section).toContain("READ-ONLY");
		expect(section).not.toContain("You are executing");
		expect(section).toContain("exit_plan");
	});

	it("revise preserves done status for matching step ids", () => {
		const mgr = new PlanManager();
		mgr.propose([
			{ id: "a", intent: "one" },
			{ id: "b", intent: "two", dependsOn: ["a"] },
		]);
		mgr.stepDone("a");
		mgr.revise([
			{ id: "a", intent: "one (clarified)" },
			{ id: "b", intent: "two", dependsOn: ["a"] },
			{ id: "c", intent: "three", dependsOn: ["b"] },
		]);
		expect(mgr.current()?.steps.find((s) => s.id === "a")?.status).toBe("done");
		expect(mgr.current()?.steps.find((s) => s.id === "b")?.status).toBe("pending");
		expect(mgr.currentVersion()).toBe(2);
	});

	it("stepDone rejects unmet dependsOn", () => {
		const mgr = new PlanManager();
		mgr.propose([
			{ id: "a", intent: "one" },
			{ id: "b", intent: "two", dependsOn: ["a"] },
		]);
		expect(() => mgr.stepDone("b")).toThrow(/unmet dependsOn/);
		expect(mgr.current()?.steps.find((s) => s.id === "b")?.status).toBe("pending");
	});

	it("rejects oversized plans and bounds prompt injection", () => {
		const mgr = new PlanManager();
		const steps = Array.from({ length: 65 }, (_, i) => ({ id: `s${i}`, intent: "work" }));
		expect(() => mgr.propose(steps)).toThrow(/at most 64 steps/);
		mgr.propose(Array.from({ length: 64 }, (_, i) => ({ id: `s${i}`, intent: "x".repeat(200) })));
		expect(mgr.systemPromptSection().length).toBeLessThanOrEqual(6000);
	});

	it("archives when all steps are done and stops prompt injection", () => {
		const mgr = new PlanManager();
		mgr.propose([
			{ id: "a", intent: "one" },
			{ id: "b", intent: "two", dependsOn: ["a"] },
		]);
		expect(mgr.systemPromptSection()).toContain("<plan>");
		expect(mgr.isArchived()).toBe(false);
		mgr.stepDone("a");
		expect(mgr.systemPromptSection()).toContain("<plan>");
		mgr.stepDone("b");
		expect(mgr.isArchived()).toBe(true);
		expect(mgr.systemPromptSection()).toBe("");
		expect(mgr.render()).toContain("2/2 done");
		expect(mgr.serialize().archived).toBe(true);
	});

	it("restores archived flag and keeps injection off until a fresh propose", () => {
		const mgr = new PlanManager();
		mgr.propose([{ id: "a", intent: "done already", status: "done" }]);
		expect(mgr.isArchived()).toBe(true);
		const data = mgr.serialize();
		const mgr2 = new PlanManager();
		mgr2.restore(data);
		expect(mgr2.isArchived()).toBe(true);
		expect(mgr2.systemPromptSection()).toBe("");
		mgr2.propose([{ id: "x", intent: "new work" }]);
		expect(mgr2.isArchived()).toBe(false);
		expect(mgr2.systemPromptSection()).toContain("<plan>");
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

	it("step_done with unmet dependsOn is an error", async () => {
		await runPlan({
			op: "propose",
			steps: [
				{ id: "s1", intent: "first" },
				{ id: "s2", intent: "second", depends_on: ["s1"] },
			],
		});
		const res = await runPlan({ op: "step_done", step_id: "s2" });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/unmet dependsOn/);
	});

	it("revise after step_done keeps done status on matching ids", async () => {
		await runPlan({
			op: "propose",
			steps: [
				{ id: "s1", intent: "first" },
				{ id: "s2", intent: "second", depends_on: ["s1"] },
			],
		});
		await runPlan({ op: "step_done", step_id: "s1" });
		const revised = await runPlan({
			op: "revise",
			steps: [
				{ id: "s1", intent: "first clarified" },
				{ id: "s2", intent: "second", depends_on: ["s1"] },
			],
		});
		expect(revised.isError).toBeFalsy();
		expect(revised.details.steps.find((s) => s.id === "s1")?.status).toBe("done");
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

describe("plan tool — brief", () => {
	beforeEach(() => setCurrentPlanManager(new PlanManager()));
	afterEach(() => setCurrentPlanManager(undefined));

	it("propose stores the brief and render() shows it in full", async () => {
		await runPlan({
			op: "propose",
			steps: [{ id: "s1", intent: "scaffold" }],
			brief: "Constraints: keep public API stable. Key files: src/mod.ts.",
		});
		const shown = await runPlan({ op: "show" });
		expect(shown.content[0].text).toContain("brief:");
		expect(shown.content[0].text).toContain("keep public API stable");
	});

	it("revise without a new brief inherits the previous brief", async () => {
		await runPlan({
			op: "propose",
			steps: [{ id: "s1", intent: "scaffold" }],
			brief: "Inherited context.",
		});
		const revised = await runPlan({
			op: "revise",
			steps: [
				{ id: "s1", intent: "scaffold" },
				{ id: "s2", intent: "wire", depends_on: ["s1"] },
			],
		});
		expect(revised.details.version).toBe(2);
		const mgr = getCurrentPlanManager();
		expect(mgr?.current()?.brief).toBe("Inherited context.");
	});

	it("revise with a new brief replaces the inherited one", async () => {
		await runPlan({
			op: "propose",
			steps: [{ id: "s1", intent: "scaffold" }],
			brief: "old context",
		});
		await runPlan({
			op: "revise",
			steps: [{ id: "s1", intent: "scaffold" }],
			brief: "new context",
		});
		expect(getCurrentPlanManager()?.current()?.brief).toBe("new context");
	});

	it("clamps the brief at BRIEF_MAX (4000 chars)", () => {
		const mgr = new PlanManager();
		const long = "x".repeat(5000);
		mgr.propose([{ id: "s1", intent: "scaffold" }], long);
		expect(mgr.current()?.brief?.length).toBe(4000);
	});

	it("emits the brief truncated in the system prompt section with a full-brief hint", () => {
		const mgr = new PlanManager();
		const long = "y".repeat(2000);
		mgr.propose([{ id: "s1", intent: "scaffold" }], long);
		const section = mgr.systemPromptSection();
		expect(section).toContain("brief:");
		expect(section).toContain("(full brief: plan show)");
		// Truncated body is present but shorter than the full brief.
		expect(section).toContain("y".repeat(100));
		expect(section.length).toBeLessThan(long.length + 1000);
	});

	it("emits the full brief in the system prompt section when under the truncation cap", () => {
		const mgr = new PlanManager();
		mgr.propose([{ id: "s1", intent: "scaffold" }], "short context");
		const section = mgr.systemPromptSection();
		expect(section).toContain("short context");
		expect(section).not.toContain("(full brief: plan show)");
	});

	it("serialize/restore round-trips the brief", () => {
		const mgr = new PlanManager();
		mgr.propose([{ id: "s1", intent: "scaffold" }], "round-trip context");
		const data = mgr.serialize();
		const mgr2 = new PlanManager();
		mgr2.restore(data);
		expect(mgr2.current()?.brief).toBe("round-trip context");
	});

	it("restore of a pre-brief plan state does not throw", () => {
		const legacy = {
			versions: [
				{
					version: 1,
					steps: [{ id: "s1", intent: "x", dependsOn: [], status: "pending" }],
				},
			],
		};
		const mgr = new PlanManager();
		expect(() => mgr.restore(legacy as any)).not.toThrow();
		expect(mgr.current()?.brief).toBeUndefined();
		expect(mgr.current()?.steps.map((s) => s.id)).toEqual(["s1"]);
	});
});

describe("plan tool — verify advisory note", () => {
	beforeEach(() => setCurrentPlanManager(new PlanManager()));
	afterEach(() => setCurrentPlanManager(undefined));

	it("propose notes steps that lack verify", async () => {
		const res = await runPlan({
			op: "propose",
			steps: [
				{ id: "s1", intent: "scaffold", verify: "vitest" },
				{ id: "s2", intent: "wire" },
				{ id: "s3", intent: "docs" },
			],
		});
		expect(res.isError).toBeFalsy();
		expect(res.content[0].text).toContain("steps without verify");
		expect(res.content[0].text).toContain("s2");
		expect(res.content[0].text).toContain("s3");
		expect(res.content[0].text).not.toMatch(/s1\b.*without/);
	});

	it("propose omits the note when every step has verify", async () => {
		const res = await runPlan({
			op: "propose",
			steps: [
				{ id: "s1", intent: "scaffold", verify: "vitest" },
				{ id: "s2", intent: "wire", verify: "tsc --noEmit" },
			],
		});
		expect(res.content[0].text).not.toContain("steps without verify");
	});

	it("revise appends the verify note after the diff", async () => {
		await runPlan({ op: "propose", steps: [{ id: "s1", intent: "scaffold" }] });
		const res = await runPlan({
			op: "revise",
			steps: [
				{ id: "s1", intent: "scaffold" },
				{ id: "s2", intent: "wire" },
			],
		});
		expect(res.content[0].text).toContain("changes:");
		expect(res.content[0].text).toContain("steps without verify");
	});
});
