/**
 * Unit test for R10: goal_complete refuses to finish while the native import
 * graph (code-graph Fase 2, `built-ins/impact-extension.ts`) still has
 * unreviewed direct dependents of this turn's edits.
 */
import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	_resetImpactStateForTest,
	_setCoveringTestsForTest,
	_setUnreviewedImpactForTest,
} from "../src/core/built-ins/impact-extension.ts";
import { GoalManager, setCurrentGoalManager } from "../src/core/goal/goal-manager.js";
import { createGoalCompleteToolDefinition } from "../src/core/tools/goal-complete.js";

const tool = createGoalCompleteToolDefinition(process.cwd());

function complete(id: string, summary: string) {
	return tool.execute(id, { summary }, undefined, undefined, undefined as never);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

describe("goal_complete R10 (unreviewed impact-graph dependents)", () => {
	afterEach(() => {
		_resetImpactStateForTest();
		setCurrentGoalManager(undefined);
		resetRuntimeDiagnostics();
	});

	it("refuses completion while dependents are pending, then completes once cleared", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);

		_setUnreviewedImpactForTest([{ path: "src/b.ts", seeds: ["src/a.ts"] }]);
		const blocked = await complete("c1", "done");
		expect(blocked.details?.completed).toBe(false);
		expect(textOf(blocked)).toContain("Not completing the goal");
		expect(textOf(blocked)).toContain("import graph shows 1 file(s)");
		// Fase 4B: each bullet names the edit(s) that made the file impacted.
		expect(textOf(blocked)).toContain("  • src/b.ts (impacted by: src/a.ts)");
		expect(textOf(blocked)).toContain("never reviewed this turn");
		// No covering tests registered -> no tests line (regression guard).
		expect(textOf(blocked)).not.toContain("Tests covering the changed files");
		expect(mgr.get()?.status).toBe("active");

		const diag = getRuntimeDiagnostics().recent.find((e) => e.context?.ruleId === "impact-blocked-done");
		expect(diag?.category).toBe("quality.impact-guard");

		_resetImpactStateForTest();
		const ok = await complete("c2", "done");
		expect(ok.details?.completed).toBe(true);
		expect(mgr.get()?.status).toBe("complete");
	});

	it("completes immediately when the registry is empty", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);

		const r = await complete("c1", "done");
		expect(r.details?.completed).toBe(true);
		expect(mgr.get()?.status).toBe("complete");
	});

	it("caps the shown list at 10 and folds the remainder into +N more", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);

		const entries = Array.from({ length: 13 }, (_, i) => ({ path: `src/dep${i}.ts`, seeds: ["src/a.ts"] }));
		_setUnreviewedImpactForTest(entries);
		const r = await complete("c1", "done");
		expect(r.details?.completed).toBe(false);
		const text = textOf(r);
		expect(text).toContain("import graph shows 13 file(s)");
		expect(text).toContain("+3 more");
		// Exactly 10 bullet lines shown.
		expect(text.match(/ {2}• /g)).toHaveLength(10);
	});

	it("caps seeds per bullet at 2 and folds the rest into +N (Fase 4B)", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);

		_setUnreviewedImpactForTest([{ path: "src/b.ts", seeds: ["src/s1.ts", "src/s2.ts", "src/s3.ts", "src/s4.ts"] }]);
		const r = await complete("c1", "done");
		expect(r.details?.completed).toBe(false);
		expect(textOf(r)).toContain("  • src/b.ts (impacted by: src/s1.ts, src/s2.ts, +2)");
	});

	it("appends the covering-tests line when the registry has tests (Fase 4B)", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);

		_setUnreviewedImpactForTest([{ path: "src/b.ts", seeds: ["src/a.ts"] }]);
		_setCoveringTestsForTest(["test/a.test.ts", "test/b.test.ts"]);
		const r = await complete("c1", "done");
		expect(r.details?.completed).toBe(false);
		expect(textOf(r)).toContain("Tests covering the changed files (run them): test/a.test.ts, test/b.test.ts");
	});

	it("caps the covering-tests line at 5 and folds the rest into +N more (Fase 4B)", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);

		_setUnreviewedImpactForTest([{ path: "src/b.ts", seeds: ["src/a.ts"] }]);
		_setCoveringTestsForTest(Array.from({ length: 7 }, (_, i) => `test/dep${i}.test.ts`));
		const r = await complete("c1", "done");
		const text = textOf(r);
		expect(text).toContain("Tests covering the changed files (run them): ");
		expect(text).toContain("test/dep4.test.ts, +2 more");
		expect(text).not.toContain("test/dep5.test.ts");
	});

	it("covering tests alone (no pending files) do NOT block completion (Fase 4B)", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);

		_setCoveringTestsForTest(["test/a.test.ts"]);
		const r = await complete("c1", "done");
		expect(r.details?.completed).toBe(true);
		expect(mgr.get()?.status).toBe("complete");
	});
});
