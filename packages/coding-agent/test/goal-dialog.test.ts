/**
 * Tests for the interactive `/goal` panel flow (goal-dialog.ts). The host is
 * faked, so these cover the control flow only — the live binding is a thin
 * pass-through in interactive-mode.ts (showGoalPanel).
 */

import { describe, expect, it, vi } from "vitest";
import type { GoalSnapshot } from "../src/core/goal/goal-manager.js";
import type { AskOption } from "../src/core/user-input-bus.js";
import { type GoalDialogHost, runGoalDialog } from "../src/modes/interactive/goal-dialog.js";

function snapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
	return {
		id: "g1",
		objective: "ship the selector revamp",
		status: "active",
		tokensUsed: 1000,
		iterations: 2,
		startedAt: 0,
		elapsedMs: 60_000,
		...overrides,
	};
}

interface HostOverrides extends Partial<GoalDialogHost> {}

function makeHost(overrides: HostOverrides = {}): GoalDialogHost {
	return {
		goalSnapshot: () => undefined,
		goalSummaryText: () => "summary",
		goalShouldAutoContinue: () => false,
		startGoal: vi.fn(),
		editGoal: vi.fn(),
		pauseGoal: vi.fn(),
		resumeGoal: vi.fn(),
		clearGoal: vi.fn(),
		setGoalTokenBudget: vi.fn(),
		promptInput: vi.fn(async () => undefined),
		pickOption: vi.fn(async () => undefined),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		startGoalSpinner: vi.fn(),
		prompt: vi.fn(async () => {}),
		...overrides,
	};
}

describe("runGoalDialog — no goal", () => {
	it("asks for an objective and starts + prompts the goal", async () => {
		const host = makeHost({
			promptInput: vi.fn(async () => "  refactor the parser  "),
		});
		await runGoalDialog(host);
		expect(host.startGoal).toHaveBeenCalledWith("refactor the parser", {});
		expect(host.startGoalSpinner).toHaveBeenCalledOnce();
		expect(host.prompt).toHaveBeenCalledWith("refactor the parser");
		expect(host.pickOption).not.toHaveBeenCalled();
	});

	it("does nothing when the objective input is cancelled or blank", async () => {
		for (const value of [undefined, "", "   "]) {
			const host = makeHost({ promptInput: vi.fn(async () => value) });
			await runGoalDialog(host);
			expect(host.startGoal).not.toHaveBeenCalled();
			expect(host.prompt).not.toHaveBeenCalled();
		}
	});

	it("routes a completed goal to the new-objective input, not the picker", async () => {
		const host = makeHost({
			goalSnapshot: () => snapshot({ status: "complete" }),
			promptInput: vi.fn(async () => "next goal"),
		});
		await runGoalDialog(host);
		expect(host.pickOption).not.toHaveBeenCalled();
		expect(host.startGoal).toHaveBeenCalledWith("next goal", {});
	});
});

describe("runGoalDialog — existing goal picker", () => {
	it("offers Pause for an active goal and pauses on pick", async () => {
		const host = makeHost({
			goalSnapshot: () => snapshot({ status: "active" }),
			pickOption: vi.fn(async (_q: string, options: AskOption[]) => {
				expect(options.map((o) => o.label)).toEqual([
					"Pause",
					"Edit objective",
					"Set token budget",
					"Replace goal",
					"Clear goal",
				]);
				return "Pause";
			}),
		});
		await runGoalDialog(host);
		expect(host.pauseGoal).toHaveBeenCalledOnce();
		expect(host.showStatus).toHaveBeenCalledWith("summary");
	});

	it("offers Resume for a paused goal and drives a continuation turn", async () => {
		const host = makeHost({
			goalSnapshot: () => snapshot({ status: "paused" }),
			goalShouldAutoContinue: () => true,
			pickOption: vi.fn(async (_q: string, options: AskOption[]) => {
				expect(options[0]).toMatchObject({ label: "Resume", recommended: true });
				return "Resume";
			}),
		});
		await runGoalDialog(host);
		expect(host.resumeGoal).toHaveBeenCalledOnce();
		expect(host.startGoalSpinner).toHaveBeenCalledOnce();
		expect(host.prompt).toHaveBeenCalledWith("Resume working toward the goal.", { expandPromptTemplates: false });
	});

	it("does not prompt a continuation when resume leaves the goal non-active", async () => {
		const host = makeHost({
			goalSnapshot: () => snapshot({ status: "paused" }),
			goalShouldAutoContinue: () => false,
			pickOption: vi.fn(async () => "Resume"),
		});
		await runGoalDialog(host);
		expect(host.resumeGoal).toHaveBeenCalledOnce();
		expect(host.prompt).not.toHaveBeenCalled();
	});

	it("budget_limited leads with Raise token budget and omits the duplicate budget action", async () => {
		const host = makeHost({
			goalSnapshot: () => snapshot({ status: "budget_limited", tokenBudget: 1000 }),
			goalShouldAutoContinue: () => true,
			promptInput: vi.fn(async () => "200k"),
			pickOption: vi.fn(async (_q: string, options: AskOption[]) => {
				const labels = options.map((o) => o.label);
				expect(options[0]).toMatchObject({ label: "Raise token budget", recommended: true });
				expect(labels).not.toContain("Set token budget");
				return "Raise token budget";
			}),
		});
		await runGoalDialog(host);
		expect(host.setGoalTokenBudget).toHaveBeenCalledWith(200_000);
		expect(host.prompt).toHaveBeenCalledWith("Resume working toward the goal.", { expandPromptTemplates: false });
	});

	it("warns on an invalid budget and changes nothing", async () => {
		const host = makeHost({
			goalSnapshot: () => snapshot({ status: "active" }),
			promptInput: vi.fn(async () => "banana"),
			pickOption: vi.fn(async () => "Set token budget"),
		});
		await runGoalDialog(host);
		expect(host.showWarning).toHaveBeenCalledWith('Invalid token budget: "banana". Use e.g. 100k or 1.5m.');
		expect(host.setGoalTokenBudget).not.toHaveBeenCalled();
		expect(host.prompt).not.toHaveBeenCalled();
	});

	it("edits the objective via the input, keeping progress", async () => {
		const host = makeHost({
			goalSnapshot: () => snapshot({ status: "active" }),
			promptInput: vi.fn(async () => "sharper objective"),
			pickOption: vi.fn(async () => "Edit objective"),
		});
		await runGoalDialog(host);
		expect(host.editGoal).toHaveBeenCalledWith("sharper objective");
		expect(host.startGoal).not.toHaveBeenCalled();
	});

	it("Replace goal starts a fresh goal through the objective input", async () => {
		const host = makeHost({
			goalSnapshot: () => snapshot({ status: "active" }),
			promptInput: vi.fn(async () => "brand new goal"),
			pickOption: vi.fn(async () => "Replace goal"),
		});
		await runGoalDialog(host);
		expect(host.startGoal).toHaveBeenCalledWith("brand new goal", {});
		expect(host.prompt).toHaveBeenCalledWith("brand new goal");
	});

	it("Clear goal clears and confirms", async () => {
		const host = makeHost({
			goalSnapshot: () => snapshot({ status: "active" }),
			pickOption: vi.fn(async () => "Clear goal"),
		});
		await runGoalDialog(host);
		expect(host.clearGoal).toHaveBeenCalledOnce();
		expect(host.showStatus).toHaveBeenCalledWith("Goal cleared");
	});

	it("Esc on the picker closes with zero side effects", async () => {
		const host = makeHost({
			goalSnapshot: () => snapshot({ status: "active" }),
			pickOption: vi.fn(async () => undefined),
		});
		await runGoalDialog(host);
		expect(host.pauseGoal).not.toHaveBeenCalled();
		expect(host.editGoal).not.toHaveBeenCalled();
		expect(host.clearGoal).not.toHaveBeenCalled();
		expect(host.startGoal).not.toHaveBeenCalled();
		expect(host.prompt).not.toHaveBeenCalled();
		expect(host.showStatus).not.toHaveBeenCalled();
	});
});
