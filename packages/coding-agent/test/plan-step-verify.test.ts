/**
 * P8a — verify executor for `plan step_done`. Covers the new behavior only;
 * the DAG/versioning mechanics themselves are covered by plan-tool.test.ts.
 * Every test injects `PlanToolOptions.runStepVerify` so nothing here ever
 * spawns a real shell (mirrors how bash.ts tests inject `BashOperations`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BashResult } from "../src/core/bash-executor.js";
import { PlanManager, setCurrentPlanManager } from "../src/core/plan/plan-manager.js";
import { createPlanToolDefinition, type PlanToolDetails, type PlanToolOptions } from "../src/core/tools/plan.js";

type StepArg = {
	id: string;
	intent: string;
	depends_on?: string[];
	produces?: string;
	verify?: string;
};

function okResult(output = ""): BashResult {
	return { output, exitCode: 0, cancelled: false, truncated: false };
}

function failResult(exitCode: number, output = ""): BashResult {
	return { output, exitCode, cancelled: false, truncated: false };
}

function timeoutResult(output = ""): BashResult {
	return { output, exitCode: undefined, cancelled: true, truncated: false };
}

async function runPlan(
	input: { op: "propose" | "revise" | "step_done" | "show"; steps?: StepArg[]; step_id?: string; brief?: string },
	options?: PlanToolOptions,
	signal?: AbortSignal,
) {
	const def = createPlanToolDefinition("/tmp", options);
	// plan ignores onUpdate/ctx; pass placeholders to satisfy the signature (same as plan-tool.test.ts).
	const result = await def.execute("test-call", input, signal, undefined, undefined as never);
	return result as { details: PlanToolDetails; isError?: boolean; content: Array<{ text: string }> };
}

describe("plan tool — step verify (P8a)", () => {
	const ORIGINAL_FLAG = process.env.PIT_NO_STEP_VERIFY;

	beforeEach(() => setCurrentPlanManager(new PlanManager()));
	afterEach(() => {
		setCurrentPlanManager(undefined);
		if (ORIGINAL_FLAG === undefined) delete process.env.PIT_NO_STEP_VERIFY;
		else process.env.PIT_NO_STEP_VERIFY = ORIGINAL_FLAG;
	});

	it("verify passes: marks the step done and adds a dense verify-ok line", async () => {
		const runStepVerify = vi.fn(async (_cmd: string, _cwd: string, _signal: AbortSignal) => okResult());
		await runPlan({ op: "propose", steps: [{ id: "s1", intent: "build", verify: "npm test" }] }, { runStepVerify });
		const res = await runPlan({ op: "step_done", step_id: "s1" }, { runStepVerify });

		expect(res.isError).toBeFalsy();
		expect(res.details.steps.find((s) => s.id === "s1")?.status).toBe("done");
		expect(res.content[0].text).toContain("verify ok: npm test");
		expect(runStepVerify).toHaveBeenCalledTimes(1);
		expect(runStepVerify).toHaveBeenCalledWith("npm test", "/tmp", expect.any(AbortSignal));
	});

	it("verify fails (non-zero exit): step stays NOT done, output capped head+tail, reason surfaces", async () => {
		const bigOutput = `line-A-first\n${"x".repeat(5000)}\nline-Z-last-error`;
		const runStepVerify = vi.fn(async () => failResult(1, bigOutput));
		await runPlan({ op: "propose", steps: [{ id: "s1", intent: "build", verify: "npm test" }] }, { runStepVerify });
		const res = await runPlan({ op: "step_done", step_id: "s1" }, { runStepVerify });

		expect(res.isError).toBe(true);
		expect(res.details.steps.find((s) => s.id === "s1")?.status).not.toBe("done");
		expect(res.content[0].text).toMatch(/exit code 1/);
		expect(res.content[0].text).toContain("line-A-first");
		expect(res.content[0].text).toContain("line-Z-last-error");
		expect(res.content[0].text).toMatch(/truncated from the middle/);
		expect(res.content[0].text.length).toBeLessThan(bigOutput.length);
		expect(res.content[0].text).toMatch(/step_done.*again|revise/i);
	});

	it("verify times out: step stays NOT done and the message names the fixed 60s budget", async () => {
		const runStepVerify = vi.fn(async () => timeoutResult("still running..."));
		await runPlan({ op: "propose", steps: [{ id: "s1", intent: "build", verify: "sleep 999" }] }, { runStepVerify });
		const res = await runPlan({ op: "step_done", step_id: "s1" }, { runStepVerify });

		expect(res.isError).toBe(true);
		expect(res.details.steps.find((s) => s.id === "s1")?.status).not.toBe("done");
		expect(res.content[0].text).toMatch(/timed out after 60000ms/);
	});

	it("verify spawn failure: step stays NOT done, error is readable, execute() never throws", async () => {
		const runStepVerify = vi.fn(async (): Promise<BashResult> => {
			throw new Error("spawn ENOENT");
		});
		await runPlan(
			{ op: "propose", steps: [{ id: "s1", intent: "build", verify: "does-not-exist" }] },
			{ runStepVerify },
		);
		const res = await runPlan({ op: "step_done", step_id: "s1" }, { runStepVerify });

		expect(res.isError).toBe(true);
		expect(res.details.steps.find((s) => s.id === "s1")?.status).not.toBe("done");
		expect(res.content[0].text).toMatch(/could not start/);
		expect(res.content[0].text).toContain("spawn ENOENT");
	});

	it("step without verifyCmd: behavior is intact — marks done, no verify line, runner never invoked", async () => {
		const runStepVerify = vi.fn(async () => okResult());
		await runPlan({ op: "propose", steps: [{ id: "s1", intent: "docs" }] }, { runStepVerify });
		const res = await runPlan({ op: "step_done", step_id: "s1" }, { runStepVerify });

		expect(res.isError).toBeFalsy();
		expect(res.details.steps.find((s) => s.id === "s1")?.status).toBe("done");
		expect(res.content[0].text).not.toContain("verify ok:");
		expect(runStepVerify).not.toHaveBeenCalled();
	});

	it("PIT_NO_STEP_VERIFY restores the advisory-only behavior: verify never runs, step still marks done", async () => {
		process.env.PIT_NO_STEP_VERIFY = "1";
		const runStepVerify = vi.fn(async () => failResult(1, "would have failed"));
		await runPlan({ op: "propose", steps: [{ id: "s1", intent: "build", verify: "npm test" }] }, { runStepVerify });
		const res = await runPlan({ op: "step_done", step_id: "s1" }, { runStepVerify });

		expect(res.isError).toBeFalsy();
		expect(res.details.steps.find((s) => s.id === "s1")?.status).toBe("done");
		expect(res.content[0].text).not.toContain("verify ok:");
		expect(runStepVerify).not.toHaveBeenCalled();
	});

	it("dependsOn is validated before verify runs — unmet deps short-circuit without spawning verify", async () => {
		const runStepVerify = vi.fn(async () => okResult());
		await runPlan(
			{
				op: "propose",
				steps: [
					{ id: "s1", intent: "first" },
					{ id: "s2", intent: "second", depends_on: ["s1"], verify: "npm test" },
				],
			},
			{ runStepVerify },
		);
		const res = await runPlan({ op: "step_done", step_id: "s2" }, { runStepVerify });

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/unmet dependsOn/);
		expect(runStepVerify).not.toHaveBeenCalled();
		expect(res.details.steps.find((s) => s.id === "s2")?.status).not.toBe("done");
	});

	it("dependsOn met + verify passes: marks done normally, runner called once", async () => {
		const runStepVerify = vi.fn(async () => okResult());
		await runPlan(
			{
				op: "propose",
				steps: [
					{ id: "s1", intent: "first" },
					{ id: "s2", intent: "second", depends_on: ["s1"], verify: "npm test" },
				],
			},
			{ runStepVerify },
		);
		await runPlan({ op: "step_done", step_id: "s1" }, { runStepVerify });
		const res = await runPlan({ op: "step_done", step_id: "s2" }, { runStepVerify });

		expect(res.isError).toBeFalsy();
		expect(res.details.steps.find((s) => s.id === "s2")?.status).toBe("done");
		expect(runStepVerify).toHaveBeenCalledTimes(1);
	});
});
