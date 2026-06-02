/**
 * Unit test for R7: goal_complete refuses to finish while the project check is
 * red, consulting the session-published verification probe.
 */
import { describe, expect, it } from "vitest";
import { GoalManager, setCurrentGoalManager } from "../src/core/goal/goal-manager.js";
import { createGoalCompleteToolDefinition } from "../src/core/tools/goal-complete.js";
import { setCurrentVerificationProbe } from "../src/core/verification/verification.js";

const tool = createGoalCompleteToolDefinition(process.cwd());

// goal_complete ignores signal/onUpdate/ctx; pass placeholders to satisfy the
// 5-arg ToolDefinition.execute signature.
function complete(id: string, summary: string) {
	return tool.execute(id, { summary }, undefined, undefined, undefined as never);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

describe("goal_complete verification gate (R7)", () => {
	it("refuses while the check is red, then completes once it is green", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);
		try {
			setCurrentVerificationProbe(async () => ({
				ok: false,
				exitCode: 1,
				output: "type error in foo.ts",
				timedOut: false,
			}));
			const red = await complete("c1", "done");
			expect(red.details?.completed).toBe(false);
			expect(textOf(red)).toContain("Not completing");
			expect(textOf(red)).toContain("type error in foo.ts");
			expect(mgr.get()?.status).toBe("active");

			setCurrentVerificationProbe(async () => ({ ok: true, exitCode: 0, output: "", timedOut: false }));
			const green = await complete("c2", "done");
			expect(green.details?.completed).toBe(true);
			expect(mgr.get()?.status).toBe("complete");
		} finally {
			setCurrentVerificationProbe(undefined);
			setCurrentGoalManager(undefined);
		}
	});

	it("completes when no probe is registered", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);
		setCurrentVerificationProbe(undefined);
		try {
			const r = await complete("c1", "ok");
			expect(r.details?.completed).toBe(true);
		} finally {
			setCurrentGoalManager(undefined);
		}
	});

	it("completes when the probe returns null (verification off or no command)", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);
		setCurrentVerificationProbe(async () => null);
		try {
			const r = await complete("c1", "ok");
			expect(r.details?.completed).toBe(true);
		} finally {
			setCurrentVerificationProbe(undefined);
			setCurrentGoalManager(undefined);
		}
	});
});
