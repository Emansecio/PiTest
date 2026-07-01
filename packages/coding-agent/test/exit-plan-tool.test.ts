/**
 * Tests for the `exit_plan` tool — the approval rite that flips plan mode to
 * auto. Covers the fail-closed invariant (no approval without a real listener),
 * the happy path (approval flips + writes artifact), feedback/keep-planning,
 * and the guards (not in plan mode, no plan built).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionChecker } from "../src/core/permissions/checker.ts";
import { createExitPlanToolDefinition, type ExitPlanToolDetails } from "../src/core/permissions/exit-plan-tool.ts";
import { PlanManager, setCurrentPlanManager } from "../src/core/plan/plan-manager.ts";
import {
	type AskOptionsAnswer,
	createUserInputBus,
	setCurrentUserInputBus,
	type UserInputBus,
} from "../src/core/user-input-bus.ts";

type FakeBusOverrides = {
	picked?: string[];
	freeformText?: string;
	comment?: string;
	cancelled?: boolean;
	hasListener?: boolean;
};

function makeFakeBus(overrides: FakeBusOverrides): UserInputBus {
	const has = overrides.hasListener ?? true;
	const fake: UserInputBus = {
		askOptions: async () =>
			({
				requestId: "t",
				picked: overrides.picked ?? [],
				freeformText: overrides.freeformText,
				comment: overrides.comment,
				cancelled: overrides.cancelled ?? false,
			}) as AskOptionsAnswer,
		onRequest: () => () => {},
		resolve: () => {},
		cancelAll: () => {},
		hasListener: () => has,
	};
	return fake;
}

async function runExitPlan(
	cwd: string,
	checker: PermissionChecker,
	input: { title: string; summary?: string },
	onApproved?: () => void,
) {
	const def = createExitPlanToolDefinition({ cwd, checker, onApproved });
	const result = await def.execute("test-call", input, undefined, undefined, undefined as never);
	return result as { details: ExitPlanToolDetails; isError?: boolean; content: Array<{ text: string }> };
}

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) {
		const d = dirs.pop();
		if (d) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}
	setCurrentUserInputBus(undefined);
	setCurrentPlanManager(undefined);
});

function makeDir(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-exitplan-"));
	dirs.push(d);
	return d;
}

function proposePlan(): void {
	const mgr = new PlanManager();
	mgr.propose(
		[
			{ id: "s1", intent: "scaffold module", producesArtifact: "src/mod.ts" },
			{ id: "s2", intent: "add tests", dependsOn: ["s1"], verifyCmd: "vitest run" },
		],
		"Constraints: keep public API. Key file read: src/mod.ts.",
	);
	setCurrentPlanManager(mgr);
}

describe("exit_plan tool", () => {
	it("approval flips the checker to auto and writes the plan artifact", async () => {
		const dir = makeDir();
		const checker = new PermissionChecker({ cwd: dir, mode: "plan", settings: {} });
		proposePlan();
		setCurrentUserInputBus(makeFakeBus({ picked: ["Approve & execute"] }));
		let approved = false;
		const res = await runExitPlan(
			dir,
			checker,
			{ title: "Scaffold module", summary: "Adds the module + tests." },
			() => {
				approved = true;
			},
		);
		expect(checker.mode).toBe("auto");
		expect(approved).toBe(true);
		expect(res.details.outcome).toBe("approved");
		expect(res.details.artifactPath).toBeDefined();
		const file = res.details.artifactPath!;
		expect(existsSync(file)).toBe(true);
		const body = readFileSync(file, "utf-8");
		expect(body).toContain("Scaffold module");
		expect(body).toContain("s1");
		expect(body).toContain("Constraints: keep public API");
	});

	it("'Keep planning' stays in plan mode and reports the choice", async () => {
		const dir = makeDir();
		const checker = new PermissionChecker({ cwd: dir, mode: "plan", settings: {} });
		proposePlan();
		setCurrentUserInputBus(makeFakeBus({ picked: ["Keep planning"] }));
		const res = await runExitPlan(dir, checker, { title: "Scaffold module" });
		expect(checker.mode).toBe("plan");
		expect(res.details.outcome).toBe("keep_planning");
		expect(res.content[0].text).toContain("keep planning");
	});

	it("freeform feedback stays in plan mode and returns the feedback", async () => {
		const dir = makeDir();
		const checker = new PermissionChecker({ cwd: dir, mode: "plan", settings: {} });
		proposePlan();
		setCurrentUserInputBus(makeFakeBus({ freeformText: "split s2 into unit + e2e" }));
		const res = await runExitPlan(dir, checker, { title: "Scaffold module" });
		expect(checker.mode).toBe("plan");
		expect(res.details.outcome).toBe("feedback");
		expect(res.content[0].text).toContain("split s2 into unit + e2e");
	});

	it("refuses to approve without an interactive listener (fail-closed)", async () => {
		const dir = makeDir();
		const checker = new PermissionChecker({ cwd: dir, mode: "plan", settings: {} });
		proposePlan();
		// No listener bound: simulates print/headless mode.
		setCurrentUserInputBus(makeFakeBus({ hasListener: false }));
		const res = await runExitPlan(dir, checker, { title: "Scaffold module" });
		expect(checker.mode).toBe("plan");
		expect(res.details.outcome).toBe("unavailable");
		expect(res.content[0].text).toContain("non-interactive");
	});

	it("refuses when no bus is bound at all (fail-closed)", async () => {
		const dir = makeDir();
		const checker = new PermissionChecker({ cwd: dir, mode: "plan", settings: {} });
		proposePlan();
		// No bus published (setCurrentUserInputBus(undefined) in afterEach).
		const res = await runExitPlan(dir, checker, { title: "Scaffold module" });
		expect(checker.mode).toBe("plan");
		expect(res.details.outcome).toBe("unavailable");
	});

	it("errors when called outside plan mode", async () => {
		const dir = makeDir();
		const checker = new PermissionChecker({ cwd: dir, mode: "auto", settings: {} });
		proposePlan();
		setCurrentUserInputBus(makeFakeBus({ picked: ["Approve & execute"] }));
		const res = await runExitPlan(dir, checker, { title: "Scaffold module" });
		expect(res.isError).toBe(true);
		expect(res.details.outcome).toBe("not_plan_mode");
		expect(checker.mode).toBe("auto"); // unchanged
	});

	it("errors when no structured plan has been proposed", async () => {
		const dir = makeDir();
		const checker = new PermissionChecker({ cwd: dir, mode: "plan", settings: {} });
		setCurrentPlanManager(new PlanManager()); // empty manager
		setCurrentUserInputBus(makeFakeBus({ picked: ["Approve & execute"] }));
		const res = await runExitPlan(dir, checker, { title: "Scaffold module" });
		expect(res.isError).toBe(true);
		expect(res.details.outcome).toBe("no_plan");
		expect(res.content[0].text).toContain("plan propose");
		expect(checker.mode).toBe("plan");
	});

	it("approval still succeeds when the artifact write fails (fail-open)", async () => {
		// Point cwd at a path whose .pit/plans parent cannot be created: use a
		// file path as cwd so mkdirSync recursive throws. Approval must stand.
		const fileAsCwd = join(makeDir(), "i-am-a-file");
		// Create the file so mkdir under it fails.
		const fs = await import("node:fs");
		fs.writeFileSync(fileAsCwd, "x", "utf-8");
		const checker = new PermissionChecker({ cwd: fileAsCwd, mode: "plan", settings: {} });
		proposePlan();
		setCurrentUserInputBus(makeFakeBus({ picked: ["Approve & execute"] }));
		const res = await runExitPlan(fileAsCwd, checker, { title: "Scaffold module" });
		expect(checker.mode).toBe("auto");
		expect(res.details.outcome).toBe("approved");
		expect(res.details.artifactPath).toBeUndefined();
		expect(res.content[0].text).toContain("could not be written");
	});

	it("real bus with a listener resolves through askOptions", async () => {
		const dir = makeDir();
		const checker = new PermissionChecker({ cwd: dir, mode: "plan", settings: {} });
		proposePlan();
		const bus = createUserInputBus();
		setCurrentUserInputBus(bus);
		// Register a listener that approves.
		bus.onRequest((req) => {
			bus.resolve(req.requestId, { picked: ["Approve & execute"], cancelled: false });
		});
		const res = await runExitPlan(dir, checker, { title: "Real bus" });
		expect(checker.mode).toBe("auto");
		expect(res.details.outcome).toBe("approved");
	});
});
