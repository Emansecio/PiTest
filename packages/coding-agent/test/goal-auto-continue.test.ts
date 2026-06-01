/**
 * Integration test for autonomous goal auto-continuation: after the agent ends
 * a turn without calling goal_complete, the session should drive a continuation
 * turn on its own, and stop once goal_complete fires.
 */
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.js";

describe("goal auto-continuation", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("continues after an incomplete turn and stops when goal_complete is called", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.startGoal("finish the task", {});
		expect(harness.session.getActiveToolNames()).toContain("goal_complete");

		harness.setResponses([
			// Turn from the initial objective prompt — no goal_complete yet.
			fauxAssistantMessage("did step one"),
			// Auto-continuation turn — the agent now calls goal_complete.
			fauxAssistantMessage([fauxToolCall("goal_complete", { summary: "all done" })], { stopReason: "toolUse" }),
			// Wrap-up after the tool result.
			fauxAssistantMessage("finished"),
		]);

		await harness.session.prompt("finish the task");

		expect(harness.session.goalSnapshot()?.status).toBe("complete");
		// The continuation prompt was injected as a second user message.
		const userTexts = getUserTexts(harness);
		expect(userTexts.length).toBeGreaterThanOrEqual(2);
		expect(userTexts.some((t) => t.toLowerCase().includes("continue working toward the goal"))).toBe(true);
		// goal_complete is removed from the surface once cleared.
		harness.session.clearGoal();
		expect(harness.session.getActiveToolNames()).not.toContain("goal_complete");
	});

	it("persists goal progress to the session so it survives a reload", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.startGoal("persist me", {});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("goal_complete", { summary: "ok" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("persist me");

		const goalEntries = harness.sessionManager
			.getEntries()
			.filter((e) => (e as { type?: string; customType?: string }).customType === "goal");
		expect(goalEntries.length).toBeGreaterThan(0);
		const last = goalEntries[goalEntries.length - 1] as { data?: { status?: string; iterations?: number } };
		expect(last.data?.status).toBe("complete");
		expect(last.data?.iterations ?? 0).toBeGreaterThanOrEqual(1);
	});

	it("does not auto-continue when no goal is active", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("just one turn")]);
		await harness.session.prompt("hello");

		expect(getUserTexts(harness)).toEqual(["hello"]);
		expect(harness.session.goalSnapshot()).toBeUndefined();
	});
});
